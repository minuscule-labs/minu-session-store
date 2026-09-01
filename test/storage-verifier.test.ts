import { describe, expect, it, vi } from "vitest";
import type { CatalogStorageLocation } from "../src/catalog/session-catalog.js";
import type { ObjectStore } from "../src/core/contracts.js";
import { verifyStorageObjects } from "../src/operations/storage-verifier.js";

describe("verifyStorageObjects", () => {
  it("verifies exact versions and reports failures without stopping the audit", async () => {
    const verify = vi.fn(async (input: { storageVersionId?: string }) => {
      if (input.storageVersionId === "version-2") throw new Error("object is missing");
      return { storageVersionId: input.storageVersionId ?? "observed-version-3" };
    });
    const report = await verifyStorageObjects({
      targets: [target(1, "version-1"), target(2, "version-2"), target(3, null)],
      objectStore: { verify } as unknown as ObjectStore,
      concurrency: 2,
    });

    expect(report).toMatchObject({ checked: 3, passed: 1, warnings: 1, failed: 1 });
    expect(report.results).toEqual([
      expect.objectContaining({ version: 1, status: "passed" }),
      expect.objectContaining({ version: 2, status: "failed", error: "object is missing" }),
      expect.objectContaining({
        version: 3,
        status: "warning",
        observedStorageVersionId: "observed-version-3",
        error: "Object content is valid, but the catalog is missing the S3 VersionId",
      }),
    ]);
    expect(verify).toHaveBeenCalledTimes(3);
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({ storageVersionId: "version-1" }),
    );
  });
});

function target(version: number, storageVersionId: string | null): CatalogStorageLocation {
  return {
    ownerId: "local",
    harness: "pi",
    sessionId: "ses_1",
    externalId: "external-1",
    sourceInstallationId: "src_1",
    version: {
      id: `obj_${version}`,
      version,
      checksum: String(version).repeat(64),
      byteSize: 123,
      objectKey: `sessions/local/ses_1/raw/${version}.jsonl`,
      storageVersionId,
      contentType: "application/x-ndjson",
      storageStatus: "verified",
      observedAt: "2026-08-31T00:00:00.000Z",
      verifiedAt: "2026-08-31T00:00:00.000Z",
      deletedAt: null,
    },
  };
}
