import type { CatalogStorageLocation } from "../catalog/session-catalog.js";
import type { ObjectStore } from "../core/contracts.js";

export type StorageVerificationResult = {
  sessionId: string;
  externalId: string;
  harness: string;
  version: number;
  objectKey: string;
  storageVersionId: string | null;
  observedStorageVersionId?: string;
  status: "passed" | "warning" | "failed";
  error?: string;
};

export type StorageVerificationReport = {
  checked: number;
  passed: number;
  warnings: number;
  failed: number;
  results: StorageVerificationResult[];
};

export async function verifyStorageObjects(input: {
  targets: CatalogStorageLocation[];
  objectStore: ObjectStore;
  concurrency?: number;
}): Promise<StorageVerificationReport> {
  const concurrency = Math.min(Math.max(input.concurrency ?? 6, 1), 32);
  const results = new Array<StorageVerificationResult>(input.targets.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < input.targets.length) {
      const index = nextIndex++;
      const target = input.targets[index];
      if (!target) return;
      results[index] = await verifyTarget(target, input.objectStore);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, input.targets.length) }, () => worker()),
  );
  const warnings = results.filter((result) => result.status === "warning").length;
  const failed = results.filter((result) => result.status === "failed").length;
  return {
    checked: results.length,
    passed: results.length - warnings - failed,
    warnings,
    failed,
    results,
  };
}

async function verifyTarget(
  target: CatalogStorageLocation,
  objectStore: ObjectStore,
): Promise<StorageVerificationResult> {
  const result = {
    sessionId: target.sessionId,
    externalId: target.externalId,
    harness: target.harness,
    version: target.version.version,
    objectKey: target.version.objectKey,
    storageVersionId: target.version.storageVersionId,
  };
  try {
    const verified = await objectStore.verify({
      objectKey: target.version.objectKey,
      checksum: target.version.checksum,
      byteSize: target.version.byteSize,
      contentType: target.version.contentType,
      ...(target.version.storageVersionId === null
        ? {}
        : { storageVersionId: target.version.storageVersionId }),
    });
    if (!target.version.storageVersionId) {
      if (!verified.storageVersionId) {
        throw new Error("Catalog and object store did not provide an S3 VersionId");
      }
      return {
        ...result,
        observedStorageVersionId: verified.storageVersionId,
        status: "warning",
        error: "Object content is valid, but the catalog is missing the S3 VersionId",
      };
    }
    if (verified.storageVersionId !== target.version.storageVersionId) {
      throw new Error(
        `Object store returned VersionId ${verified.storageVersionId ?? "none"}; expected ${target.version.storageVersionId}`,
      );
    }
    return { ...result, status: "passed" };
  } catch (error) {
    return { ...result, status: "failed", error: errorMessage(error) };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
