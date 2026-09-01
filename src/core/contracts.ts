export type SessionLifecycleStatus = "active" | "completed" | "unknown";

export type DiscoveryIssue = {
  path: string;
  message: string;
};

export type DiscoverSessionsInput = {
  modifiedSince?: Date;
  workingDirectory?: string;
};

export type DiscoveredSession = {
  path: string;
  externalId: string;
  formatVersion?: string;
  modifiedAt: Date;
  byteSize: number;
};

export type CapturedSnapshot = {
  path: string;
  checksumAlgorithm: "sha256";
  checksum: string;
  byteSize: number;
  contentType: string;
  originalFilename: string;
  dispose(): Promise<void>;
};

export type CapturedSession = {
  externalId: string;
  harness: string;
  formatVersion?: string;
  adapterVersion: string;
  title?: string;
  lifecycleStatus: SessionLifecycleStatus;
  startedAt?: string;
  completedAt?: string;
  workingDirectory?: string;
  observedAt: string;
  snapshot: CapturedSnapshot;
};

export interface SessionSourceAdapter {
  readonly harness: string;
  readonly adapterVersion: string;

  discover(input?: DiscoverSessionsInput): AsyncIterable<DiscoveredSession>;
  capture(session: DiscoveredSession): Promise<CapturedSession>;
}

export type StoreSnapshotInput = {
  sessionId: string;
  objectKey: string;
  snapshotPath: string;
  checksum: string;
  byteSize: number;
  contentType: string;
};

export type StoredObject = {
  objectKey: string;
  checksum: string;
  byteSize: number;
  contentType: string;
  storageVersionId?: string;
};

export type PutImmutableResult = {
  status: "stored" | "already_exists";
  objectKey: string;
};

export type VerifiedObject = {
  storageVersionId?: string;
};

export interface ObjectStore {
  putImmutable(input: StoreSnapshotInput): Promise<PutImmutableResult>;
  verify(input: StoredObject): Promise<VerifiedObject>;
}

export type DeleteStoredObjectVersionInput = {
  objectKey: string;
  storageVersionId: string;
};

export interface VersionedObjectStore extends ObjectStore {
  deleteVersion(input: DeleteStoredObjectVersionInput): Promise<void>;
}
