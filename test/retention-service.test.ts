import { createClient } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionCatalog } from "../src/catalog/session-catalog.js";
import type { CapturedSession, VersionedObjectStore } from "../src/core/contracts.js";
import { RetentionService } from "../src/core/retention-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("RetentionService", () => {
  it("reconciles, stages, and deletes only after the grace period", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retention-service-test-"));
    temporaryDirectories.push(directory);
    const databaseUrl = `file:${join(directory, "catalog.db")}`;
    let now = new Date("2026-02-01T00:00:00.000Z");
    const catalog = new SessionCatalog({
      url: databaseUrl,
      migrationsFolder: resolve("drizzle"),
      now: () => now,
    });
    await catalog.initialize();
    const sourceInstallationId = await catalog.registerSourceInstallation({
      ownerId: "local",
      harness: "pi",
      deviceId: "device-1",
    });

    const checksums = "abcdef012345".split("");
    let sessionId = "";
    for (const character of checksums) {
      const captured = capturedSession(character.repeat(64));
      const prepared = await catalog.prepareSnapshot({
        ownerId: "local",
        sourceInstallationId,
        captured,
      });
      sessionId = prepared.sessionId;
      await catalog.recordVerifiedSnapshot({
        sessionId,
        objectKey: `sessions/local/${sessionId}/raw/${captured.snapshot.checksum}.jsonl`,
        captured,
        uploadedAt: "2026-02-01T00:00:00.000Z",
      });
    }

    now = new Date("2026-03-01T00:00:00.000Z");
    const verify = vi.fn<VersionedObjectStore["verify"]>(async () => ({
      storageVersionId: "s3-version-2",
    }));
    const deleteVersion = vi.fn<VersionedObjectStore["deleteVersion"]>(async () => {});
    const objectStore: VersionedObjectStore = {
      async putImmutable(input) {
        return { status: "stored", objectKey: input.objectKey };
      },
      verify,
      deleteVersion,
    };
    const service = new RetentionService({
      ownerId: "local",
      catalog,
      objectStore,
      policy: { keepAllForDays: 7, keepLatestVersions: 10, keepFirstVersion: true },
      gracePeriodMs: 24 * 60 * 60 * 1000,
      now: () => now,
    });

    await expect(service.run()).resolves.toMatchObject({
      planned: 1,
      reconciledVersionIds: 1,
      staged: 1,
      deleted: 0,
      failed: 0,
    });
    expect(deleteVersion).not.toHaveBeenCalled();

    now = new Date("2026-03-02T00:00:01.000Z");
    await expect(service.run()).resolves.toMatchObject({
      planned: 1,
      staged: 0,
      deleted: 1,
      deletedBytes: 123,
      failed: 0,
    });
    expect(deleteVersion).toHaveBeenCalledWith({
      objectKey: `sessions/local/${sessionId}/raw/${"b".repeat(64)}.jsonl`,
      storageVersionId: "s3-version-2",
    });

    const reader = createClient({ url: databaseUrl });
    try {
      const tombstone = await reader.execute({
        sql: "SELECT storage_status, deleted_at, checksum FROM session_objects WHERE version = 2",
        args: [],
      });
      expect(tombstone.rows[0]).toMatchObject({
        storage_status: "deleted",
        deleted_at: "2026-03-02T00:00:01.000Z",
        checksum: "b".repeat(64),
      });
    } finally {
      reader.close();
      catalog.close();
    }
  });
});

function capturedSession(checksum: string): CapturedSession {
  return {
    externalId: "pi-session-1",
    harness: "pi",
    formatVersion: "3",
    adapterVersion: "0.1.0",
    lifecycleStatus: "unknown",
    observedAt: "2026-02-01T00:00:00.000Z",
    snapshot: {
      path: "/tmp/not-read.jsonl",
      checksumAlgorithm: "sha256",
      checksum,
      byteSize: 123,
      contentType: "application/x-ndjson",
      originalFilename: "session.jsonl",
      async dispose() {},
    },
  };
}
