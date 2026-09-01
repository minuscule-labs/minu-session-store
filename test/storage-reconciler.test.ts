import { describe, expect, it, vi } from "vitest";
import type { CatalogStorageLocation, SessionCatalog } from "../src/catalog/session-catalog.js";
import type { ObjectStore } from "../src/core/contracts.js";
import { reconcileStorageVersionIds } from "../src/operations/storage-reconciler.js";

describe("reconcileStorageVersionIds", () => {
  it("verifies the observed version again before recording it", async () => {
    const target = storageTarget();
    const listStorageObjectsForVerification = vi.fn(async () => [target]);
    const recordStorageVersionId = vi.fn(async () => true);
    const verify = vi
      .fn()
      .mockResolvedValueOnce({ storageVersionId: "observed-version" })
      .mockResolvedValueOnce({ storageVersionId: "observed-version" });

    const report = await reconcileStorageVersionIds({
      ownerId: "local",
      catalog: {
        listStorageObjectsForVerification,
        recordStorageVersionId,
      } as unknown as SessionCatalog,
      objectStore: { verify } as unknown as ObjectStore,
    });

    expect(report).toEqual({
      checked: 1,
      reconciled: 1,
      skipped: 0,
      failed: 0,
      failures: [],
    });
    expect(listStorageObjectsForVerification).toHaveBeenCalledWith({
      ownerId: "local",
      missingStorageVersionId: true,
    });
    expect(verify).toHaveBeenNthCalledWith(
      1,
      expect.not.objectContaining({ storageVersionId: expect.anything() }),
    );
    expect(verify).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ storageVersionId: "observed-version" }),
    );
    expect(recordStorageVersionId).toHaveBeenCalledWith(
      target.version.id,
      target.version.objectKey,
      "observed-version",
    );
  });

  it("does not write a version ID when exact verification fails", async () => {
    const recordStorageVersionId = vi.fn();
    const verify = vi
      .fn()
      .mockResolvedValueOnce({ storageVersionId: "observed-version" })
      .mockRejectedValueOnce(new Error("exact version mismatch"));

    const report = await reconcileStorageVersionIds({
      ownerId: "local",
      catalog: {
        listStorageObjectsForVerification: vi.fn(async () => [storageTarget()]),
        recordStorageVersionId,
      } as unknown as SessionCatalog,
      objectStore: { verify } as unknown as ObjectStore,
    });

    expect(report).toMatchObject({ checked: 1, reconciled: 0, failed: 1 });
    expect(report.failures[0]?.error).toBe("exact version mismatch");
    expect(recordStorageVersionId).not.toHaveBeenCalled();
  });
});

function storageTarget(): CatalogStorageLocation {
  return {
    ownerId: "local",
    harness: "pi",
    sessionId: "ses_1",
    externalId: "external-1",
    sourceInstallationId: "src_1",
    version: {
      id: "obj_1",
      version: 1,
      checksum: "a".repeat(64),
      byteSize: 123,
      objectKey: `sessions/local/ses_1/raw/${"a".repeat(64)}.jsonl`,
      storageVersionId: null,
      contentType: "application/x-ndjson",
      storageStatus: "verified",
      observedAt: "2026-08-31T00:00:00.000Z",
      verifiedAt: "2026-08-31T00:00:00.000Z",
      deletedAt: null,
    },
  };
}
