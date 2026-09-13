import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiSessionRehydrationAdapter } from "../src/adapters/pi/pi-session-rehydration-adapter.js";
import type { RehydrationContext } from "../src/rehydration/contracts.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("PiSessionRehydrationAdapter", () => {
  it("creates a deterministic read-only plan in Pi's project directory", async () => {
    const root = await temporaryDirectory();
    const adapter = new PiSessionRehydrationAdapter({ sessionRoots: [root] });
    const canonicalRoot = await realpath(root);
    const context = rehydrationContext();

    const plan = await adapter.plan(context);

    expect(plan).toMatchObject({
      harness: "pi",
      status: "ready",
      sessionId: context.sessionId,
      externalId: context.externalId,
      sessionObjectId: context.sessionObjectId,
      snapshotChecksum: context.snapshotChecksum,
      snapshotByteSize: context.byteSize,
      workingDirectory: context.workingDirectory,
      targetPath: join(canonicalRoot, "--workspace-project--", context.originalFilename!),
      precondition: { targetMustNotExist: true },
    });
    expect(await readDirectory(root)).toEqual([]);
    await expect(adapter.plan(context)).resolves.toEqual(plan);
  });

  it("validates only complete, checksum-identical Pi v3 snapshots", async () => {
    const root = await temporaryDirectory();
    const adapter = new PiSessionRehydrationAdapter({ sessionRoots: [root] });
    const content = piSnapshot();
    const context = rehydrationContext(content);
    const plan = await adapter.plan(context);
    const staged = join(root, "staged.jsonl");
    await writeFile(staged, content);

    await expect(adapter.validateSnapshot(plan, staged)).resolves.toBeUndefined();
    await writeFile(staged, piSnapshot({ id: "another-session" }));
    await expect(adapter.validateSnapshot(plan, staged)).rejects.toThrow("external session ID");
    await writeFile(staged, piSnapshot({ version: 2 }));
    await expect(adapter.validateSnapshot(plan, staged)).rejects.toThrow("supported v3");
    await writeFile(staged, piSnapshot({ cwd: "relative/project" }));
    await expect(adapter.validateSnapshot(plan, staged)).rejects.toThrow("supported v3");
    const strictAdapter = new PiSessionRehydrationAdapter({
      sessionRoots: [root],
      maxHeaderBytes: 10,
    });
    await writeFile(staged, content);
    await expect(strictAdapter.validateSnapshot(plan, staged)).rejects.toThrow("complete JSONL header");
    const partialContent = Buffer.concat([content, Buffer.from("{")]);
    const partialPlan = await adapter.plan(rehydrationContext(partialContent));
    await writeFile(staged, partialContent);
    await expect(adapter.validateSnapshot(partialPlan, staged)).rejects.toThrow("partial JSONL");
  });

  it("reports identical sessions and refuses every differing collision", async () => {
    const root = await temporaryDirectory();
    const adapter = new PiSessionRehydrationAdapter({ sessionRoots: [root] });
    const canonicalRoot = await realpath(root);
    const content = piSnapshot();
    const context = rehydrationContext(content);
    const targetDirectory = join(canonicalRoot, "--workspace-project--");
    await mkdir(targetDirectory);
    const targetPath = join(targetDirectory, context.originalFilename!);
    await writeFile(targetPath, content);

    await expect(adapter.plan(context)).resolves.toMatchObject({
      status: "already_present",
      targetPath,
    });

    const duplicateDirectory = join(canonicalRoot, "--another-project--");
    await mkdir(duplicateDirectory);
    const duplicatePath = join(duplicateDirectory, "2026-09-07T00-00-00-000Z_external-1.jsonl");
    await writeFile(duplicatePath, piSnapshot({ extra: "different bytes" }));
    await expect(adapter.plan(context)).resolves.toMatchObject({
      status: "conflict",
      warnings: [expect.stringContaining(duplicatePath)],
    });
  });

  it("atomically installs verified bytes and makes repeated apply idempotent", async () => {
    const root = await temporaryDirectory();
    const stagingDirectory = await temporaryDirectory();
    const adapter = new PiSessionRehydrationAdapter({ sessionRoots: [root] });
    const content = piSnapshot();
    const context = rehydrationContext(content);
    const plan = await adapter.plan(context);
    const stagedPath = join(stagingDirectory, "verified.jsonl");
    await writeFile(stagedPath, content, { mode: 0o600 });
    await adapter.validateSnapshot(plan, stagedPath);

    const installed = await adapter.apply(plan, stagedPath);
    expect(installed).toMatchObject({ status: "installed", targetPath: plan.targetPath });
    expect(await readFile(plan.targetPath!)).toEqual(content);
    expect((await lstat(plan.targetPath!)).mode & 0o777).toBe(0o600);
    await expect(adapter.apply(plan, stagedPath)).resolves.toMatchObject({
      status: "already_present",
      targetPath: plan.targetPath,
    });
    expect((await readdir(join(plan.sessionRoot!, "--workspace-project--"))).filter((name) =>
      name.startsWith(".minu-rehydrate-"),
    )).toEqual([]);
  });

  it("rechecks a target created after planning and refuses different bytes", async () => {
    const root = await temporaryDirectory();
    const stagingDirectory = await temporaryDirectory();
    const adapter = new PiSessionRehydrationAdapter({ sessionRoots: [root] });
    const content = piSnapshot();
    const context = rehydrationContext(content);
    const plan = await adapter.plan(context);
    const stagedPath = join(stagingDirectory, "verified.jsonl");
    await writeFile(stagedPath, content);
    await mkdir(join(plan.sessionRoot!, "--workspace-project--"));
    await writeFile(plan.targetPath!, piSnapshot({ extra: "concurrent conflict" }));

    await expect(adapter.apply(plan, stagedPath)).rejects.toThrow("conflicts with existing sessions");
    expect(await readFile(plan.targetPath!, "utf8")).toContain("concurrent conflict");
  });

  it("refuses unsafe roots and symlink target directories", async () => {
    const root = await temporaryDirectory();
    const adapter = new PiSessionRehydrationAdapter();
    await expect(
      adapter.plan({ ...rehydrationContext(), requestedSessionRoot: "relative-root" }),
    ).rejects.toThrow("absolute path");

    const outside = await temporaryDirectory();
    await symlink(outside, join(root, "--workspace-project--"));
    const rootedAdapter = new PiSessionRehydrationAdapter({ sessionRoots: [root] });
    await expect(rootedAdapter.plan(rehydrationContext())).rejects.toThrow("contains a symlink");
    expect((await lstat(join(root, "--workspace-project--"))).isSymbolicLink()).toBe(true);
  });

  it("requires catalog working-directory metadata", async () => {
    const root = await temporaryDirectory();
    const adapter = new PiSessionRehydrationAdapter({ sessionRoots: [root] });
    const { workingDirectory: _workingDirectory, ...context } = rehydrationContext();
    await expect(adapter.plan(context)).rejects.toThrow("working directory");
  });
});

function rehydrationContext(content = piSnapshot()): RehydrationContext {
  return {
    sessionId: "session-1",
    externalId: "external-1",
    sourceHarness: "pi",
    workingDirectory: "/workspace/project",
    version: 2,
    sessionObjectId: "object-1",
    snapshotChecksum: createHash("sha256").update(content).digest("hex"),
    byteSize: content.length,
    originalFilename: "2026-09-07T00-00-00-000Z_external-1.jsonl",
  };
}

function piSnapshot(
  overrides: { id?: string; version?: number; cwd?: string; extra?: string } = {},
): Buffer {
  return Buffer.from(
    `${JSON.stringify({
      type: "session",
      version: overrides.version ?? 3,
      id: overrides.id ?? "external-1",
      timestamp: "2026-09-07T00:00:00.000Z",
      cwd: overrides.cwd ?? "/workspace/project",
      ...(overrides.extra === undefined ? {} : { extra: overrides.extra }),
    })}\n`,
  );
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-rehydration-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function readDirectory(path: string): Promise<string[]> {
  return readdir(path);
}
