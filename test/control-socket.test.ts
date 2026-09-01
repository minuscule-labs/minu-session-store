import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DaemonControlServer,
  isDaemonControlAvailable,
  requestDaemonSync,
  requestStorageVersionReconciliation,
} from "../src/daemon/control-socket.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("daemon control socket", () => {
  it("accepts a private local sync request and returns its summary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "daemon-control-test-"));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "state", "daemon.sock");
    const summary = {
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
      discovered: 1,
      skippedByFingerprint: 0,
      deferred: 0,
      unchanged: 0,
      uploaded: 1,
      updated: 0,
      failed: 0,
      bytesStored: 123,
    };
    const sync = vi.fn(async () => summary);
    const reconciliation = {
      checked: 2,
      reconciled: 2,
      skipped: 0,
      failed: 0,
      failures: [],
    };
    const reconcile = vi.fn(async () => reconciliation);
    const server = new DaemonControlServer(socketPath, sync, reconcile);

    await server.start();
    try {
      expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
      await expect(isDaemonControlAvailable(socketPath)).resolves.toBe(true);
      await expect(requestDaemonSync({ socketPath, force: true })).resolves.toEqual(summary);
      expect(sync).toHaveBeenCalledWith(true);
      await expect(
        requestStorageVersionReconciliation({ socketPath, limit: 2 }),
      ).resolves.toEqual(reconciliation);
      expect(reconcile).toHaveBeenCalledWith(2);
    } finally {
      await server.stop();
    }
    await expect(stat(socketPath)).rejects.toThrow();
  });
});
