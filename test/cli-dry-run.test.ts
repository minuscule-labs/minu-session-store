import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createConfig, writeConfig } from "../src/config/config.js";

const executeFile = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("minu-sessions sync --dry-run", () => {
  it("plans a new session without creating or mutating the catalog", async () => {
    const directory = await mkdtemp(join(tmpdir(), "session-cli-test-"));
    temporaryDirectories.push(directory);
    const sessionsDirectory = join(directory, "sessions");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(sessionsDirectory);
    const sessionPath = join(sessionsDirectory, "session.jsonl");
    await writeFile(
      sessionPath,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "session-1",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/workspace",
      })}\n`,
    );

    const databasePath = join(directory, "catalog.db");
    const configPath = join(directory, "config.json");
    await writeConfig(
      createConfig({
        bucket: "unused-during-dry-run",
        region: "us-east-1",
        catalogUrl: `file:${databasePath}`,
        sessionRoots: [sessionsDirectory],
      }),
      configPath,
    );

    const { stdout, stderr } = await executeFile(
      process.execPath,
      ["--import", "tsx", resolve("src/cli.ts"), "sync", "--dry-run", "--config", configPath],
      { cwd: resolve(".") },
    );

    expect(stderr).toBe("");
    expect(stdout).toContain("new_session: 1");
    await expect(access(databasePath)).rejects.toThrow();
  });
});
