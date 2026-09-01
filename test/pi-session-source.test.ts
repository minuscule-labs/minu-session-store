import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiSessionSource } from "../src/adapters/pi/pi-session-source.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("PiSessionSource", () => {
  it("discovers valid Pi sessions deterministically and skips symlinks", async () => {
    const root = await createTemporaryDirectory();
    const projectA = join(root, "project-a");
    const projectB = join(root, "project-b");
    await Promise.all([mkdir(projectA), mkdir(projectB)]);

    const laterPath = join(projectB, "later.jsonl");
    const earlierPath = join(projectA, "earlier.jsonl");
    await writeSession(laterPath, { id: "session-b", cwd: "/workspace/b" });
    await writeSession(earlierPath, { id: "session-a", cwd: "/workspace/a" });
    await writeFile(join(projectA, "invalid.jsonl"), "not-json\n", "utf8");
    await symlink(earlierPath, join(projectB, "linked.jsonl"));

    const source = new PiSessionSource({ sessionRoots: [root] });
    const sessions = await collect(source.discover());

    expect(sessions.map((session) => session.path)).toEqual([
      await realpath(earlierPath),
      await realpath(laterPath),
    ]);
    expect(sessions.map((session) => session.externalId)).toEqual(["session-a", "session-b"]);
    expect(sessions.map((session) => session.formatVersion)).toEqual(["3", "3"]);
  });

  it("captures exact bytes and extracts archival metadata", async () => {
    const root = await createTemporaryDirectory();
    const sessionPath = join(root, "session.jsonl");
    const content = sessionContent({
      id: "session-123",
      cwd: "/workspace/project",
      entries: [
        { type: "session_info", id: "one", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", name: "Old" },
        {
          type: "message",
          id: "two",
          parentId: "one",
          timestamp: "2026-01-01T00:00:02.000Z",
          message: { role: "user", content: "x".repeat(1_000_000), timestamp: 1 },
        },
        { type: "session_info", id: "three", parentId: "two", timestamp: "2026-01-01T00:00:03.000Z", name: "Current name" },
      ],
    });
    await writeFile(sessionPath, content);

    const source = new PiSessionSource({
      sessionRoots: [root],
      now: () => new Date("2026-02-01T00:00:00.000Z"),
    });
    const [discovered] = await collect(source.discover());
    expect(discovered).toBeDefined();

    const captured = await source.capture(discovered!);
    expect(captured).toMatchObject({
      externalId: "session-123",
      harness: "pi",
      formatVersion: "3",
      adapterVersion: "0.1.0",
      title: "Current name",
      lifecycleStatus: "unknown",
      startedAt: "2026-01-01T00:00:00.000Z",
      workingDirectory: "/workspace/project",
      observedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(await readFile(captured.snapshot.path, "utf8")).toBe(content);
    expect(captured.snapshot.byteSize).toBe(Buffer.byteLength(content));
    expect(captured.snapshot.checksum).toBe(createHash("sha256").update(content).digest("hex"));

    const snapshotPath = captured.snapshot.path;
    await captured.snapshot.dispose();
    await expect(access(snapshotPath)).rejects.toThrow();
  });

  it("rejects a partial final JSONL entry", async () => {
    const root = await createTemporaryDirectory();
    const sessionPath = join(root, "partial.jsonl");
    await writeFile(
      sessionPath,
      JSON.stringify({
        type: "session",
        version: 3,
        id: "partial",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/workspace",
      }),
    );

    const source = new PiSessionSource({ sessionRoots: [root], captureAttempts: 1 });
    const [discovered] = await collect(source.discover());
    expect(discovered).toBeDefined();
    await expect(source.capture(discovered!)).rejects.toThrow("partial JSONL entry");
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "session-store-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeSession(
  path: string,
  input: { id: string; cwd: string },
): Promise<void> {
  await writeFile(path, sessionContent(input));
}

function sessionContent(input: {
  id: string;
  cwd: string;
  entries?: Array<Record<string, unknown>>;
}): string {
  const lines = [
    {
      type: "session",
      version: 3,
      id: input.id,
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: input.cwd,
    },
    ...(input.entries ?? []),
  ];
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
