import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionCatalog } from "../src/catalog/session-catalog.js";
import type { CapturedSession, ObjectStore, SessionSourceAdapter } from "../src/core/contracts.js";
import { SyncSessionService } from "../src/core/sync-session.js";
import { SessionDaemon } from "../src/daemon/session-daemon.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("SessionDaemon", () => {
  it("persists source fingerprints and skips unchanged files on later scans", async () => {
    const directory = await mkdtemp(join(tmpdir(), "session-daemon-test-"));
    temporaryDirectories.push(directory);
    const catalog = new SessionCatalog({
      url: `file:${join(directory, "catalog.db")}`,
      migrationsFolder: resolve("drizzle"),
    });
    await catalog.initialize();
    const sourceInstallationId = await catalog.registerSourceInstallation({
      ownerId: "local",
      harness: "pi",
      deviceId: "device-1",
    });

    const captured = capturedSession();
    const capture = vi.fn(async () => captured);
    const source: SessionSourceAdapter = {
      harness: "pi",
      adapterVersion: "0.1.0",
      async *discover() {
        yield {
          path: "/sessions/session.jsonl",
          externalId: captured.externalId,
          formatVersion: "3",
          modifiedAt: new Date("2026-01-01T00:00:00.000Z"),
          byteSize: captured.snapshot.byteSize,
        };
      },
      capture,
    };
    const putImmutable = vi.fn<ObjectStore["putImmutable"]>(async (input) => ({
      status: "stored",
      objectKey: input.objectKey,
    }));
    const verify = vi.fn<ObjectStore["verify"]>(async () => ({}));
    const syncService = new SyncSessionService({
      ownerId: "local",
      sourceInstallationId,
      source,
      catalog,
      objectStore: { putImmutable, verify },
    });
    const daemon = new SessionDaemon({
      sourceInstallationId,
      source,
      catalog,
      syncService,
    });

    const first = await daemon.scanOnce();
    const second = await daemon.scanOnce();

    expect(first).toMatchObject({ discovered: 1, uploaded: 1, skippedByFingerprint: 0, failed: 0 });
    expect(second).toMatchObject({ discovered: 1, uploaded: 0, skippedByFingerprint: 1, failed: 0 });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(putImmutable).toHaveBeenCalledTimes(1);

    const events: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstStarted = new Promise<void>((resolveStarted) => {
      void daemon.runExclusive(async () => {
        events.push("first-start");
        resolveStarted();
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        events.push("first-end");
      });
    });
    await firstStarted;
    const secondOperation = daemon.runExclusive(async () => {
      events.push("second");
    });
    await Promise.resolve();
    expect(events).toEqual(["first-start"]);
    releaseFirst();
    await secondOperation;
    expect(events).toEqual(["first-start", "first-end", "second"]);

    await expect(catalog.getSyncJobSummary()).resolves.toEqual({
      pending: 0,
      processing: 0,
      retry: 0,
      completed: 1,
      failed: 0,
    });
    catalog.close();
  });
});

function capturedSession(): CapturedSession {
  return {
    externalId: "pi-session-1",
    harness: "pi",
    formatVersion: "3",
    adapterVersion: "0.1.0",
    lifecycleStatus: "unknown",
    observedAt: "2026-01-01T00:00:00.000Z",
    snapshot: {
      path: "/tmp/session.jsonl",
      checksumAlgorithm: "sha256",
      checksum: "e".repeat(64),
      byteSize: 100,
      contentType: "application/x-ndjson",
      originalFilename: "session.jsonl",
      async dispose() {},
    },
  };
}
