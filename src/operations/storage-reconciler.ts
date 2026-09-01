import type { CatalogStorageLocation, SessionCatalog } from "../catalog/session-catalog.js";
import type { ObjectStore } from "../core/contracts.js";

export type StorageVersionReconciliationFailure = {
  sessionId: string;
  version: number;
  objectKey: string;
  error: string;
};

export type StorageVersionReconciliationReport = {
  checked: number;
  reconciled: number;
  skipped: number;
  failed: number;
  failures: StorageVersionReconciliationFailure[];
};

export async function reconcileStorageVersionIds(input: {
  ownerId: string;
  catalog: SessionCatalog;
  objectStore: ObjectStore;
  limit?: number;
}): Promise<StorageVersionReconciliationReport> {
  const targets = await input.catalog.listStorageObjectsForVerification({
    ownerId: input.ownerId,
    missingStorageVersionId: true,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  const report: StorageVersionReconciliationReport = {
    checked: targets.length,
    reconciled: 0,
    skipped: 0,
    failed: 0,
    failures: [],
  };

  for (const target of targets) {
    try {
      const observed = await verifyCurrentObject(target, input.objectStore);
      await verifyExactObject(target, observed, input.objectStore);
      const recorded = await input.catalog.recordStorageVersionId(
        target.version.id,
        target.version.objectKey,
        observed,
      );
      if (recorded) report.reconciled += 1;
      else report.skipped += 1;
    } catch (error) {
      report.failed += 1;
      if (report.failures.length < 50) {
        report.failures.push({
          sessionId: target.sessionId,
          version: target.version.version,
          objectKey: target.version.objectKey,
          error: errorMessage(error),
        });
      }
    }
  }

  return report;
}

async function verifyCurrentObject(
  target: CatalogStorageLocation,
  objectStore: ObjectStore,
): Promise<string> {
  const verified = await objectStore.verify({
    objectKey: target.version.objectKey,
    checksum: target.version.checksum,
    byteSize: target.version.byteSize,
    contentType: target.version.contentType,
  });
  if (!verified.storageVersionId) throw new Error("Object store did not return an S3 VersionId");
  return verified.storageVersionId;
}

async function verifyExactObject(
  target: CatalogStorageLocation,
  storageVersionId: string,
  objectStore: ObjectStore,
): Promise<void> {
  const verified = await objectStore.verify({
    objectKey: target.version.objectKey,
    checksum: target.version.checksum,
    byteSize: target.version.byteSize,
    contentType: target.version.contentType,
    storageVersionId,
  });
  if (verified.storageVersionId !== storageVersionId) {
    throw new Error(
      `Object store returned VersionId ${verified.storageVersionId ?? "none"}; expected ${storageVersionId}`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
