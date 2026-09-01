import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { SessionCatalog } from "../src/catalog/session-catalog.js";
import { createConfig, writeConfig } from "../src/config/config.js";
import type { CapturedSession } from "../src/core/contracts.js";

const executeFile = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("catalog CLI commands", () => {
  it("reports the package version", async () => {
    const version = await runCli(["--version"]);
    expect(version.stdout.trim()).toBe("0.1.0");
  });

  it("filters sessions and locates an exact stored object", async () => {
    const directory = await mkdtemp(join(tmpdir(), "catalog-cli-test-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "catalog.db");
    const configPath = join(directory, "config.json");
    await writeConfig(
      createConfig({
        bucket: "example-session-archive",
        region: "us-east-1",
        catalogUrl: `file:${databasePath}`,
      }),
      configPath,
    );

    const catalog = new SessionCatalog({
      url: `file:${databasePath}`,
      migrationsFolder: resolve("drizzle"),
    });
    await catalog.initialize();
    const sourceInstallationId = await catalog.registerSourceInstallation({
      ownerId: "local",
      harness: "pi",
      deviceId: "device-1",
      displayName: "Test laptop",
    });
    const captured = capturedSession();
    const prepared = await catalog.prepareSnapshot({
      ownerId: "local",
      sourceInstallationId,
      captured,
    });
    await catalog.recordVerifiedSnapshot({
      sessionId: prepared.sessionId,
      objectKey: `sessions/local/${prepared.sessionId}/raw/${captured.snapshot.checksum}.jsonl`,
      storageVersionId: "storage-version-1",
      captured,
    });
    catalog.close();

    const piList = await runCli([
      "sessions",
      "list",
      "--harness",
      "pi",
      "--json",
      "--config",
      configPath,
    ]);
    expect(JSON.parse(piList.stdout)).toEqual([
      expect.objectContaining({
        id: prepared.sessionId,
        harness: "pi",
        sourceInstallationId,
        sourceDeviceId: "device-1",
      }),
    ]);

    const otherList = await runCli([
      "sessions",
      "list",
      "--harness",
      "other",
      "--json",
      "--config",
      configPath,
    ]);
    expect(JSON.parse(otherList.stdout)).toEqual([]);

    const located = await runCli([
      "storage",
      "locate",
      "external-session-1",
      "--version",
      "1",
      "--json",
      "--config",
      configPath,
    ]);
    const location = JSON.parse(located.stdout);
    expect(location).toMatchObject({
      bucket: "example-session-archive",
      region: "us-east-1",
      harness: "pi",
      sessionId: prepared.sessionId,
      sourceInstallationId,
      s3Uri: `s3://example-session-archive/sessions/local/${prepared.sessionId}/raw/${captured.snapshot.checksum}.jsonl`,
      version: {
        version: 1,
        storageVersionId: "storage-version-1",
        storageStatus: "verified",
      },
    });
    expect(new URL(location.consoleUrl).searchParams.get("versionId")).toBe("storage-version-1");
  });
});

function runCli(args: string[]) {
  return executeFile(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), ...args], {
    cwd: resolve("."),
  });
}

function capturedSession(): CapturedSession {
  return {
    externalId: "external-session-1",
    harness: "pi",
    adapterVersion: "0.1.0",
    title: "Catalog CLI test",
    lifecycleStatus: "unknown",
    workingDirectory: "/workspace/project",
    observedAt: "2026-08-31T00:00:00.000Z",
    snapshot: {
      path: "/tmp/not-read-by-catalog.jsonl",
      checksumAlgorithm: "sha256",
      checksum: "a".repeat(64),
      byteSize: 123,
      contentType: "application/x-ndjson",
      originalFilename: "session.jsonl",
      async dispose() {},
    },
  };
}
