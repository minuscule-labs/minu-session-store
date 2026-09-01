import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PiSessionSource } from "../adapters/pi/pi-session-source.js";
import { S3ObjectStore } from "../adapters/s3/s3-object-store.js";
import { localDatabasePath } from "../catalog/catalog-url.js";
import { SessionCatalog } from "../catalog/session-catalog.js";
import { catalogAuthToken, type SessionStoreConfig } from "../config/config.js";
import { SyncSessionService } from "../core/sync-session.js";

export type SessionStoreRuntime = {
  source: PiSessionSource;
  catalog: SessionCatalog;
  objectStore: S3ObjectStore;
  syncService: SyncSessionService;
  sourceInstallationId: string;
  close(): void;
};

export function createObjectStore(config: SessionStoreConfig): S3ObjectStore {
  return new S3ObjectStore({
    bucket: config.s3.bucket,
    ...(config.s3.profile === undefined ? {} : { profile: config.s3.profile }),
    clientConfig: {
      region: config.s3.region,
      ...(config.s3.endpoint === undefined ? {} : { endpoint: config.s3.endpoint }),
      ...(config.s3.forcePathStyle === undefined
        ? {}
        : { forcePathStyle: config.s3.forcePathStyle }),
    },
    ...(config.s3.serverSideEncryption === undefined
      ? {}
      : { serverSideEncryption: config.s3.serverSideEncryption }),
    ...(config.s3.kmsKeyId === undefined ? {} : { kmsKeyId: config.s3.kmsKeyId }),
  });
}

export async function createRuntime(config: SessionStoreConfig): Promise<SessionStoreRuntime> {
  const databasePath = localDatabasePath(config.catalog.url);
  if (databasePath) {
    await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
    await chmod(dirname(databasePath), 0o700);
  }

  const authToken = catalogAuthToken(config);
  const catalog = new SessionCatalog({
    url: config.catalog.url,
    ...(authToken === undefined ? {} : { authToken }),
    migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
  });

  try {
    await catalog.initialize();
    const sourceInstallationId = await catalog.registerSourceInstallation({
      ownerId: config.ownerId,
      harness: "pi",
      deviceId: config.deviceId,
      ...(config.deviceName === undefined ? {} : { displayName: config.deviceName }),
    });
    const source = new PiSessionSource({
      ...(config.pi.sessionRoots === undefined ? {} : { sessionRoots: config.pi.sessionRoots }),
    });
    const objectStore = createObjectStore(config);
    const syncService = new SyncSessionService({
      ownerId: config.ownerId,
      sourceInstallationId,
      source,
      catalog,
      objectStore,
    });

    return {
      source,
      catalog,
      objectStore,
      syncService,
      sourceInstallationId,
      close: () => catalog.close(),
    };
  } catch (error) {
    catalog.close();
    throw error;
  }
}
