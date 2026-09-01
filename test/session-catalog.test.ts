import { createClient } from "@libsql/client";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionCatalog } from "../src/catalog/session-catalog.js";
import type { CapturedSession } from "../src/core/contracts.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("SessionCatalog", () => {
  it("records immutable versions idempotently in a user-readable SQLite database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "session-catalog-test-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "catalog.db");
    const databaseUrl = `file:${databasePath}`;
    let now = new Date("2026-02-01T00:00:00.000Z");
    const catalog = new SessionCatalog({
      url: databaseUrl,
      migrationsFolder: resolve("drizzle"),
      now: () => now,
    });

    await catalog.initialize();
    expect((await stat(databasePath)).mode & 0o777).toBe(0o600);

    const sourceInstallationId = await catalog.registerSourceInstallation({
      ownerId: "local",
      harness: "pi",
      deviceId: "device-1",
      displayName: "Laptop",
    });

    const baselineSource = {
      path: "/sessions/session.jsonl",
      externalId: "pi-session-1",
      formatVersion: "3",
      modifiedAt: new Date("2026-01-01T00:00:00.000Z"),
      byteSize: 100,
    };
    await catalog.markSyncStarted(sourceInstallationId, baselineSource);
    await catalog.markSyncCompleted(sourceInstallationId, baselineSource, "0".repeat(64));
    const changedSource = {
      ...baselineSource,
      modifiedAt: now,
      byteSize: 101,
    };
    await expect(catalog.evaluateSourceSync(sourceInstallationId, changedSource)).resolves.toBe(
      "deferred",
    );
    now = new Date("2026-02-01T00:02:01.000Z");
    await expect(catalog.evaluateSourceSync(sourceInstallationId, changedSource)).resolves.toBe(
      "sync",
    );

    const captured = capturedSession("a".repeat(64));
    const prepared = await catalog.prepareSnapshot({
      ownerId: "local",
      sourceInstallationId,
      captured,
    });
    expect(prepared.existingObjectId).toBeUndefined();

    const recorded = await catalog.recordVerifiedSnapshot({
      sessionId: prepared.sessionId,
      objectKey: `sessions/local/${prepared.sessionId}/raw/${captured.snapshot.checksum}.jsonl`,
      storageVersionId: "s3-version-1",
      captured,
    });
    expect(recorded).toMatchObject({ version: 1, created: true });
    await expect(
      catalog.recordStorageVersionId(
        recorded.sessionObjectId,
        `sessions/local/${prepared.sessionId}/raw/${captured.snapshot.checksum}.jsonl`,
        "replacement-version",
      ),
    ).resolves.toBe(false);

    const repeated = await catalog.prepareSnapshot({
      ownerId: "local",
      sourceInstallationId,
      captured,
    });
    expect(repeated).toEqual({
      sessionId: prepared.sessionId,
      existingObjectId: recorded.sessionObjectId,
    });

    await expect(catalog.listSessions({ ownerId: "local", search: "test session" })).resolves.toEqual([
      expect.objectContaining({
        id: prepared.sessionId,
        title: "Test session",
        latestVersion: 1,
        latestByteSize: 123,
      }),
    ]);
    await expect(catalog.listSessions({ ownerId: "local", search: "missing" })).resolves.toEqual([]);
    await expect(
      catalog.listSessions({ ownerId: "local", harness: "pi", deviceId: "device-1" }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: prepared.sessionId,
        ownerId: "local",
        harness: "pi",
        sourceInstallationId,
        sourceDeviceId: "device-1",
        sourceDisplayName: "Laptop",
      }),
    ]);
    await expect(
      catalog.listSessions({ ownerId: "local", harness: "other" }),
    ).resolves.toEqual([]);
    await expect(
      catalog.listSessions({ ownerId: "local", sourceInstallationId: "src_missing" }),
    ).resolves.toEqual([]);
    await expect(catalog.locateSessionObject("local", "pi-session-1")).resolves.toEqual(
      expect.objectContaining({
        sessionId: prepared.sessionId,
        harness: "pi",
        sourceInstallationId,
        version: expect.objectContaining({
          version: 1,
          objectKey: `sessions/local/${prepared.sessionId}/raw/${captured.snapshot.checksum}.jsonl`,
          storageVersionId: "s3-version-1",
          storageStatus: "verified",
        }),
      }),
    );
    await expect(catalog.locateSessionObject("local", "pi-session-1", 2)).resolves.toBeUndefined();
    await expect(
      catalog.listStorageObjectsForVerification({
        ownerId: "local",
        identifier: "pi-session-1",
        limit: 1,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        sessionId: prepared.sessionId,
        version: expect.objectContaining({ version: 1, storageVersionId: "s3-version-1" }),
      }),
    ]);
    await expect(catalog.getSession("local", "pi-session-1")).resolves.toEqual(
      expect.objectContaining({
        id: prepared.sessionId,
        externalId: "pi-session-1",
        versions: [
          expect.objectContaining({
            version: 1,
            checksum: captured.snapshot.checksum,
            byteSize: 123,
          }),
        ],
      }),
    );

    const backupPath = join(directory, "backups", "catalog.db");
    await expect(catalog.backup(backupPath)).resolves.toBe(backupPath);
    expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
    const backupReader = createClient({ url: `file:${backupPath}` });
    try {
      const backupSessions = await backupReader.execute("SELECT COUNT(*) count FROM session_catalog_v1");
      expect(backupSessions.rows[0]?.count).toBe(1);
    } finally {
      backupReader.close();
    }

    const reader = createClient({ url: databaseUrl });
    try {
      const view = await reader.execute("SELECT * FROM session_catalog_v1");
      expect(view.rows).toHaveLength(1);
      expect(view.rows[0]).toMatchObject({
        id: prepared.sessionId,
        external_id: "pi-session-1",
        latest_version: 1,
        latest_checksum: captured.snapshot.checksum,
        latest_byte_size: 123,
      });
      const outbox = await reader.execute("SELECT COUNT(*) count FROM outbox_events");
      expect(outbox.rows[0]?.count).toBe(0);

      await reader.execute("CREATE TABLE user_annotations (session_id TEXT, note TEXT)");
      await reader.execute({
        sql: "INSERT INTO user_annotations (session_id, note) VALUES (?, ?)",
        args: [prepared.sessionId, "User-owned data"],
      });
      const annotations = await reader.execute("SELECT * FROM user_annotations");
      expect(annotations.rows[0]).toMatchObject({ note: "User-owned data" });

      const additionalChecksums = "bcdef012345".split("");
      for (const [index, character] of additionalChecksums.entries()) {
        const nextCaptured = capturedSession(character.repeat(64));
        const nextPrepared = await catalog.prepareSnapshot({
          ownerId: "local",
          sourceInstallationId,
          captured: nextCaptured,
        });
        await catalog.recordVerifiedSnapshot({
          sessionId: nextPrepared.sessionId,
          objectKey: `sessions/local/${nextPrepared.sessionId}/raw/${nextCaptured.snapshot.checksum}.jsonl`,
          storageVersionId: `s3-version-${index + 2}`,
          captured: nextCaptured,
        });
      }
      const retentionPlan = await catalog.planRetention(
        "local",
        { keepAllForDays: 7, keepLatestVersions: 10, keepFirstVersion: true },
        new Date("2026-03-01T00:00:00.000Z"),
      );
      expect(retentionPlan).toMatchObject({
        reclaimableBytes: 123,
        missingStorageVersionIds: 0,
        candidates: [{ version: 2, storageVersionId: "s3-version-2" }],
      });
      await expect(catalog.getStorageStatusSummary()).resolves.toEqual({
        verified: 12,
        pendingDeletion: 0,
        deleted: 0,
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
    title: "Test session",
    lifecycleStatus: "unknown",
    startedAt: "2026-01-01T00:00:00.000Z",
    workingDirectory: "/workspace/project",
    observedAt: "2026-01-02T00:00:00.000Z",
    snapshot: {
      path: "/tmp/not-read-by-catalog.jsonl",
      checksumAlgorithm: "sha256",
      checksum,
      byteSize: 123,
      contentType: "application/x-ndjson",
      originalFilename: "session.jsonl",
      async dispose() {},
    },
  };
}
