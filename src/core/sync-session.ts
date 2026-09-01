import type { DiscoveredSession, ObjectStore, SessionSourceAdapter } from "./contracts.js";
import { buildRawSessionObjectKey } from "../adapters/s3/s3-object-store.js";
import type { SessionCatalog } from "../catalog/session-catalog.js";

export type SyncSessionDependencies = {
  ownerId: string;
  sourceInstallationId: string;
  source: SessionSourceAdapter;
  catalog: SessionCatalog;
  objectStore: ObjectStore;
};

export type SyncSessionResult =
  | {
      status: "unchanged";
      sessionId: string;
      sessionObjectId: string;
      checksum: string;
      byteSize: number;
    }
  | {
      status: "uploaded" | "updated";
      sessionId: string;
      sessionObjectId: string;
      version: number;
      checksum: string;
      byteSize: number;
    };

export class SyncSessionService {
  constructor(private readonly dependencies: SyncSessionDependencies) {}

  async sync(session: DiscoveredSession): Promise<SyncSessionResult> {
    const captured = await this.dependencies.source.capture(session);

    try {
      const prepared = await this.dependencies.catalog.prepareSnapshot({
        ownerId: this.dependencies.ownerId,
        sourceInstallationId: this.dependencies.sourceInstallationId,
        captured,
      });

      if (prepared.existingObjectId) {
        return {
          status: "unchanged",
          sessionId: prepared.sessionId,
          sessionObjectId: prepared.existingObjectId,
          checksum: captured.snapshot.checksum,
          byteSize: captured.snapshot.byteSize,
        };
      }

      const objectKey = buildRawSessionObjectKey({
        ownerId: this.dependencies.ownerId,
        sessionId: prepared.sessionId,
        checksum: captured.snapshot.checksum,
      });
      const putResult = await this.dependencies.objectStore.putImmutable({
        sessionId: prepared.sessionId,
        objectKey,
        snapshotPath: captured.snapshot.path,
        checksum: captured.snapshot.checksum,
        byteSize: captured.snapshot.byteSize,
        contentType: captured.snapshot.contentType,
      });
      const storedObject = {
        objectKey: putResult.objectKey,
        checksum: captured.snapshot.checksum,
        byteSize: captured.snapshot.byteSize,
        contentType: captured.snapshot.contentType,
      };
      const verified = await this.dependencies.objectStore.verify(storedObject);

      const recorded = await this.dependencies.catalog.recordVerifiedSnapshot({
        sessionId: prepared.sessionId,
        objectKey: putResult.objectKey,
        ...(verified.storageVersionId === undefined
          ? {}
          : { storageVersionId: verified.storageVersionId }),
        captured,
      });

      return {
        status: recorded.version === 1 ? "uploaded" : "updated",
        sessionId: prepared.sessionId,
        sessionObjectId: recorded.sessionObjectId,
        version: recorded.version,
        checksum: captured.snapshot.checksum,
        byteSize: captured.snapshot.byteSize,
      };
    } finally {
      await captured.snapshot.dispose();
    }
  }
}
