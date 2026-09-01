import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionCatalog } from "../src/catalog/session-catalog.js";
import type {
  CapturedSession,
  DiscoveredSession,
  ObjectStore,
  SessionSourceAdapter,
} from "../src/core/contracts.js";
import { SyncSessionService } from "../src/core/sync-session.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("SyncSessionService", () => {
  it("uploads, verifies, records, and then skips an unchanged snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sync-session-test-"));
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

    const dispose = vi.fn(async () => {});
    const captured = capturedSession(dispose);
    const source: SessionSourceAdapter = {
      harness: "pi",
      adapterVersion: "0.1.0",
      async *discover() {},
      async capture() {
        return captured;
      },
    };
    const putImmutable = vi.fn<ObjectStore["putImmutable"]>(async (input) => ({
      status: "stored",
      objectKey: input.objectKey,
    }));
    const verify = vi.fn<ObjectStore["verify"]>(async () => ({}));
    const service = new SyncSessionService({
      ownerId: "local",
      sourceInstallationId,
      source,
      catalog,
      objectStore: { putImmutable, verify },
    });
    const discovered: DiscoveredSession = {
      path: "/sessions/session.jsonl",
      externalId: captured.externalId,
      formatVersion: "3",
      modifiedAt: new Date(),
      byteSize: captured.snapshot.byteSize,
    };

    const first = await service.sync(discovered);
    const second = await service.sync(discovered);

    expect(first).toMatchObject({ status: "uploaded", version: 1 });
    expect(second).toMatchObject({
      status: "unchanged",
      sessionId: first.sessionId,
      sessionObjectId: first.sessionObjectId,
    });
    expect(putImmutable).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(2);
    catalog.close();
  });
});

function capturedSession(dispose: () => Promise<void>): CapturedSession {
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
      checksum: "d".repeat(64),
      byteSize: 100,
      contentType: "application/x-ndjson",
      originalFilename: "session.jsonl",
      dispose,
    },
  };
}
