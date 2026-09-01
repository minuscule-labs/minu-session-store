import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { and, desc, eq, isNull, lte, max, or, sql } from "drizzle-orm";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import type {
  CapturedSession,
  DiscoveredSession,
  SessionLifecycleStatus,
} from "../core/contracts.js";
import { localDatabasePath } from "./catalog-url.js";
import * as schema from "./schema.js";

export type SessionCatalogOptions = {
  url: string;
  authToken?: string;
  migrationsFolder?: string;
  client?: Client;
  now?: () => Date;
  emitOutboxEvents?: boolean;
};

export type RegisterSourceInstallationInput = {
  id?: string;
  ownerId: string;
  harness: string;
  deviceId: string;
  displayName?: string;
};

export type PrepareSnapshotInput = {
  ownerId: string;
  sourceInstallationId: string;
  captured: CapturedSession;
};

export type PreparedSnapshot = {
  sessionId: string;
  existingObjectId?: string;
};

export type RecordVerifiedSnapshotInput = {
  sessionId: string;
  objectKey: string;
  storageVersionId?: string;
  captured: CapturedSession;
  uploadedAt?: string;
};

export type RecordedSnapshot = {
  sessionObjectId: string;
  version: number;
  created: boolean;
};

export type SnapshotPlan =
  | { status: "new_session" }
  | { status: "new_version"; sessionId: string }
  | { status: "unchanged"; sessionId: string; sessionObjectId: string };

export type SourceDebouncePolicy = {
  quietPeriodMs: number;
  maximumWaitMs: number;
};

export type SyncJobSummary = {
  pending: number;
  processing: number;
  retry: number;
  completed: number;
  failed: number;
};

export type StorageStatusSummary = {
  verified: number;
  pendingDeletion: number;
  deleted: number;
};

export type CatalogSessionSummary = {
  id: string;
  ownerId: string;
  sourceInstallationId: string;
  sourceDeviceId: string;
  sourceDisplayName: string | null;
  externalId: string;
  harness: string;
  title: string | null;
  workingDirectory: string | null;
  lifecycleStatus: SessionLifecycleStatus;
  startedAt: string | null;
  lastObservedAt: string;
  latestVersion: number | null;
  latestByteSize: number | null;
  latestVerifiedAt: string | null;
};

export type RetentionPolicy = {
  keepAllForDays: number;
  keepLatestVersions: number;
  keepFirstVersion: boolean;
};

export type RetentionCandidate = {
  sessionObjectId: string;
  sessionId: string;
  version: number;
  checksum: string;
  byteSize: number;
  objectKey: string;
  storageVersionId: string | null;
  contentType: string;
  storageStatus: "verified" | "pending_deletion";
  deleteEligibleAt: string | null;
  verifiedAt: string;
};

export type RetentionPlan = {
  candidates: RetentionCandidate[];
  reclaimableBytes: number;
  missingStorageVersionIds: number;
};

export type CatalogSessionVersion = {
  id: string;
  version: number;
  checksum: string;
  byteSize: number;
  objectKey: string;
  storageVersionId: string | null;
  contentType: string;
  storageStatus: "verified" | "pending_deletion" | "deleted";
  observedAt: string;
  verifiedAt: string;
  deletedAt: string | null;
};

export type CatalogStorageLocation = {
  ownerId: string;
  harness: string;
  sessionId: string;
  externalId: string;
  sourceInstallationId: string;
  version: CatalogSessionVersion;
};

export type CatalogSessionDetails = CatalogSessionSummary & {
  formatVersion: string | null;
  adapterVersion: string;
  completedAt: string | null;
  versionCount: number;
  versions: CatalogSessionVersion[];
};

const storageLocationSelection = {
  ownerId: schema.sessions.ownerId,
  harness: schema.sessions.harness,
  sessionId: schema.sessions.id,
  externalId: schema.sessions.externalId,
  sourceInstallationId: schema.sessions.sourceInstallationId,
  id: schema.sessionObjects.id,
  version: schema.sessionObjects.version,
  checksum: schema.sessionObjects.checksum,
  byteSize: schema.sessionObjects.byteSize,
  objectKey: schema.sessionObjects.objectKey,
  storageVersionId: schema.sessionObjects.storageVersionId,
  contentType: schema.sessionObjects.contentType,
  storageStatus: schema.sessionObjects.storageStatus,
  observedAt: schema.sessionObjects.observedAt,
  verifiedAt: schema.sessionObjects.verifiedAt,
  deletedAt: schema.sessionObjects.deletedAt,
};

export class SessionCatalog {
  private readonly client: Client;
  private readonly database: LibSQLDatabase<typeof schema>;
  private readonly now: () => Date;
  private readonly migrationsFolder: string | undefined;
  private readonly localDatabasePath: string | undefined;
  private readonly emitOutboxEvents: boolean;

  constructor(options: SessionCatalogOptions) {
    this.client = options.client ?? createClient(clientConfiguration(options));
    this.database = drizzle(this.client, { schema });
    this.now = options.now ?? (() => new Date());
    this.migrationsFolder = options.migrationsFolder;
    this.localDatabasePath = localDatabasePath(options.url);
    this.emitOutboxEvents = options.emitOutboxEvents ?? false;
  }

  async initialize(): Promise<void> {
    if (this.localDatabasePath) {
      await mkdir(dirname(this.localDatabasePath), { recursive: true, mode: 0o700 });
      await chmod(dirname(this.localDatabasePath), 0o700);
      for (const statement of [
        "PRAGMA journal_mode = WAL",
        "PRAGMA foreign_keys = ON",
        "PRAGMA busy_timeout = 5000",
        "PRAGMA synchronous = NORMAL",
      ]) {
        await this.client.execute(statement);
      }
    }

    if (this.migrationsFolder) {
      await migrate(this.database, { migrationsFolder: this.migrationsFolder });
    }
    if (this.localDatabasePath) await chmod(this.localDatabasePath, 0o600);
  }

  async backup(destinationPath: string): Promise<string> {
    if (!this.localDatabasePath) throw new Error("Catalog backup currently requires local SQLite");
    const destination = resolve(destinationPath);
    if (destination === this.localDatabasePath) {
      throw new Error("Catalog backup destination must differ from the active database");
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await chmod(dirname(destination), 0o700);
    await this.client.execute(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
    await chmod(destination, 0o600);
    return destination;
  }

  close(): void {
    this.client.close();
  }

  async registerSourceInstallation(input: RegisterSourceInstallationInput): Promise<string> {
    const now = this.now().toISOString();
    const id = input.id ?? createId("src");

    await this.database
      .insert(schema.sourceInstallations)
      .values({
        id,
        ownerId: input.ownerId,
        harness: input.harness,
        deviceId: input.deviceId,
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.sourceInstallations.ownerId,
          schema.sourceInstallations.harness,
          schema.sourceInstallations.deviceId,
        ],
        set: {
          ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
          updatedAt: now,
        },
      });

    const [installation] = await this.database
      .select({ id: schema.sourceInstallations.id })
      .from(schema.sourceInstallations)
      .where(
        and(
          eq(schema.sourceInstallations.ownerId, input.ownerId),
          eq(schema.sourceInstallations.harness, input.harness),
          eq(schema.sourceInstallations.deviceId, input.deviceId),
        ),
      )
      .limit(1);

    if (!installation) throw new Error("Failed to register source installation");
    return installation.id;
  }

  async findSourceInstallationId(input: {
    ownerId: string;
    harness: string;
    deviceId: string;
  }): Promise<string | undefined> {
    const [installation] = await this.database
      .select({ id: schema.sourceInstallations.id })
      .from(schema.sourceInstallations)
      .where(
        and(
          eq(schema.sourceInstallations.ownerId, input.ownerId),
          eq(schema.sourceInstallations.harness, input.harness),
          eq(schema.sourceInstallations.deviceId, input.deviceId),
        ),
      )
      .limit(1);
    return installation?.id;
  }

  async planSnapshot(input: PrepareSnapshotInput): Promise<SnapshotPlan> {
    const [session] = await this.database
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.ownerId, input.ownerId),
          eq(schema.sessions.sourceInstallationId, input.sourceInstallationId),
          eq(schema.sessions.externalId, input.captured.externalId),
        ),
      )
      .limit(1);
    if (!session) return { status: "new_session" };

    const [existingObject] = await this.database
      .select({ id: schema.sessionObjects.id })
      .from(schema.sessionObjects)
      .where(
        and(
          eq(schema.sessionObjects.sessionId, session.id),
          eq(schema.sessionObjects.checksum, input.captured.snapshot.checksum),
        ),
      )
      .limit(1);

    return existingObject
      ? { status: "unchanged", sessionId: session.id, sessionObjectId: existingObject.id }
      : { status: "new_version", sessionId: session.id };
  }

  async evaluateSourceSync(
    sourceInstallationId: string,
    session: DiscoveredSession,
    debounce: SourceDebouncePolicy = { quietPeriodMs: 120_000, maximumWaitMs: 1_800_000 },
  ): Promise<"sync" | "unchanged" | "deferred"> {
    const [job] = await this.database
      .select({
        status: schema.syncJobs.status,
        sourceMtimeMs: schema.syncJobs.sourceMtimeMs,
        sourceByteSize: schema.syncJobs.sourceByteSize,
        pendingMtimeMs: schema.syncJobs.pendingMtimeMs,
        pendingByteSize: schema.syncJobs.pendingByteSize,
        firstChangedAt: schema.syncJobs.firstChangedAt,
        lastChangedAt: schema.syncJobs.lastChangedAt,
        nextAttemptAt: schema.syncJobs.nextAttemptAt,
      })
      .from(schema.syncJobs)
      .where(
        and(
          eq(schema.syncJobs.sourceInstallationId, sourceInstallationId),
          eq(schema.syncJobs.sourcePath, session.path),
        ),
      )
      .limit(1);
    if (!job) return "sync";

    const mtimeMs = session.modifiedAt.getTime();
    const hasCapturedFingerprint =
      job.sourceMtimeMs === mtimeMs && job.sourceByteSize === session.byteSize;
    if (hasCapturedFingerprint) {
      if (job.pendingMtimeMs !== null || job.pendingByteSize !== null) {
        await this.clearPendingSourceChange(sourceInstallationId, session.path);
      }
      return "unchanged";
    }

    const now = this.now();
    const hasSamePendingFingerprint =
      job.pendingMtimeMs === mtimeMs && job.pendingByteSize === session.byteSize;
    const firstChangedAt = job.firstChangedAt ?? now.toISOString();
    if (!hasSamePendingFingerprint) {
      await this.database
        .update(schema.syncJobs)
        .set({
          pendingMtimeMs: mtimeMs,
          pendingByteSize: session.byteSize,
          firstChangedAt,
          lastChangedAt: now.toISOString(),
          ...(job.status === "retry" || job.status === "failed"
            ? {
                status: "completed" as const,
                attemptCount: 0,
                errorCode: null,
                errorMessage: null,
              }
            : {}),
          updatedAt: now.toISOString(),
        })
        .where(
          and(
            eq(schema.syncJobs.sourceInstallationId, sourceInstallationId),
            eq(schema.syncJobs.sourcePath, session.path),
          ),
        );
    }

    if (hasSamePendingFingerprint && job.status === "failed") return "deferred";
    if (
      hasSamePendingFingerprint &&
      job.status === "retry" &&
      Date.parse(job.nextAttemptAt) > now.getTime()
    ) {
      return "deferred";
    }
    if (hasSamePendingFingerprint && job.status === "processing") return "sync";

    const quietPeriodElapsed = mtimeMs <= now.getTime() - debounce.quietPeriodMs;
    const maximumWaitElapsed =
      Date.parse(firstChangedAt) <= now.getTime() - debounce.maximumWaitMs;
    return quietPeriodElapsed || maximumWaitElapsed ? "sync" : "deferred";
  }

  async markSyncStarted(
    sourceInstallationId: string,
    session: DiscoveredSession,
  ): Promise<void> {
    const now = this.now().toISOString();
    await this.database
      .insert(schema.syncJobs)
      .values({
        id: createId("job"),
        sourceInstallationId,
        sourcePath: session.path,
        pendingMtimeMs: session.modifiedAt.getTime(),
        pendingByteSize: session.byteSize,
        firstChangedAt: now,
        lastChangedAt: now,
        status: "processing",
        nextAttemptAt: now,
        lastAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.syncJobs.sourceInstallationId, schema.syncJobs.sourcePath],
        set: {
          pendingMtimeMs: session.modifiedAt.getTime(),
          pendingByteSize: session.byteSize,
          status: "processing",
          lastAttemptAt: now,
          errorCode: null,
          errorMessage: null,
          updatedAt: now,
        },
      });
  }

  async markSyncCompleted(
    sourceInstallationId: string,
    session: DiscoveredSession,
    checksum: string,
  ): Promise<void> {
    const now = this.now().toISOString();
    await this.database
      .update(schema.syncJobs)
      .set({
        sourceMtimeMs: session.modifiedAt.getTime(),
        sourceByteSize: session.byteSize,
        pendingMtimeMs: null,
        pendingByteSize: null,
        firstChangedAt: null,
        lastChangedAt: null,
        status: "completed",
        attemptCount: 0,
        nextAttemptAt: now,
        lastChecksum: checksum,
        lastSucceededAt: now,
        errorCode: null,
        errorMessage: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.syncJobs.sourceInstallationId, sourceInstallationId),
          eq(schema.syncJobs.sourcePath, session.path),
        ),
      );
  }

  async markSyncFailed(
    sourceInstallationId: string,
    session: DiscoveredSession,
    error: { code: string; message: string },
    maximumAttempts = 8,
  ): Promise<void> {
    const [job] = await this.database
      .select({ attemptCount: schema.syncJobs.attemptCount })
      .from(schema.syncJobs)
      .where(
        and(
          eq(schema.syncJobs.sourceInstallationId, sourceInstallationId),
          eq(schema.syncJobs.sourcePath, session.path),
        ),
      )
      .limit(1);
    const attemptCount = (job?.attemptCount ?? 0) + 1;
    const nextAttemptAt = new Date(
      this.now().getTime() + retryDelayMilliseconds(attemptCount),
    ).toISOString();

    await this.database
      .update(schema.syncJobs)
      .set({
        status: attemptCount >= maximumAttempts ? "failed" : "retry",
        attemptCount,
        nextAttemptAt,
        errorCode: error.code,
        errorMessage: error.message,
        updatedAt: this.now().toISOString(),
      })
      .where(
        and(
          eq(schema.syncJobs.sourceInstallationId, sourceInstallationId),
          eq(schema.syncJobs.sourcePath, session.path),
        ),
      );
  }

  private async clearPendingSourceChange(
    sourceInstallationId: string,
    sourcePath: string,
  ): Promise<void> {
    await this.database
      .update(schema.syncJobs)
      .set({
        pendingMtimeMs: null,
        pendingByteSize: null,
        firstChangedAt: null,
        lastChangedAt: null,
        updatedAt: this.now().toISOString(),
      })
      .where(
        and(
          eq(schema.syncJobs.sourceInstallationId, sourceInstallationId),
          eq(schema.syncJobs.sourcePath, sourcePath),
        ),
      );
  }

  async planRetention(
    ownerId: string,
    policy: RetentionPolicy,
    at = this.now(),
  ): Promise<RetentionPlan> {
    const cutoff = at.getTime() - policy.keepAllForDays * 24 * 60 * 60 * 1000;
    const rows = await this.database
      .select({
        sessionObjectId: schema.sessionObjects.id,
        sessionId: schema.sessionObjects.sessionId,
        latestObjectId: schema.sessions.latestObjectId,
        version: schema.sessionObjects.version,
        checksum: schema.sessionObjects.checksum,
        byteSize: schema.sessionObjects.byteSize,
        objectKey: schema.sessionObjects.objectKey,
        storageVersionId: schema.sessionObjects.storageVersionId,
        contentType: schema.sessionObjects.contentType,
        storageStatus: schema.sessionObjects.storageStatus,
        deleteEligibleAt: schema.sessionObjects.deleteEligibleAt,
        pinnedAt: schema.sessionObjects.pinnedAt,
        verifiedAt: schema.sessionObjects.verifiedAt,
      })
      .from(schema.sessionObjects)
      .innerJoin(schema.sessions, eq(schema.sessions.id, schema.sessionObjects.sessionId))
      .where(eq(schema.sessions.ownerId, ownerId))
      .orderBy(schema.sessionObjects.sessionId, desc(schema.sessionObjects.version));

    const rankBySession = new Map<string, number>();
    const candidates: RetentionCandidate[] = [];
    for (const row of rows) {
      if (row.storageStatus === "deleted") continue;
      const rank = (rankBySession.get(row.sessionId) ?? 0) + 1;
      rankBySession.set(row.sessionId, rank);
      const isEligible =
        (row.storageStatus === "verified" || row.storageStatus === "pending_deletion") &&
        row.sessionObjectId !== row.latestObjectId &&
        row.pinnedAt === null &&
        (!policy.keepFirstVersion || row.version !== 1) &&
        rank > policy.keepLatestVersions &&
        Date.parse(row.verifiedAt) < cutoff;
      if (!isEligible) continue;

      candidates.push({
        sessionObjectId: row.sessionObjectId,
        sessionId: row.sessionId,
        version: row.version,
        checksum: row.checksum,
        byteSize: row.byteSize,
        objectKey: row.objectKey,
        storageVersionId: row.storageVersionId,
        contentType: row.contentType,
        storageStatus: row.storageStatus,
        deleteEligibleAt: row.deleteEligibleAt,
        verifiedAt: row.verifiedAt,
      });
    }

    return {
      candidates,
      reclaimableBytes: candidates.reduce((total, candidate) => total + candidate.byteSize, 0),
      missingStorageVersionIds: candidates.filter(
        (candidate) => candidate.storageVersionId === null,
      ).length,
    };
  }

  async recordStorageVersionId(
    sessionObjectId: string,
    objectKey: string,
    storageVersionId: string,
  ): Promise<boolean> {
    if (!storageVersionId.trim()) throw new Error("Storage version ID is required");
    const result = await this.database
      .update(schema.sessionObjects)
      .set({ storageVersionId })
      .where(
        and(
          eq(schema.sessionObjects.id, sessionObjectId),
          eq(schema.sessionObjects.objectKey, objectKey),
          eq(schema.sessionObjects.storageStatus, "verified"),
          isNull(schema.sessionObjects.storageVersionId),
        ),
      );
    return result.rowsAffected > 0;
  }

  async stageRetentionCandidates(
    candidates: RetentionCandidate[],
    deleteEligibleAt: Date,
  ): Promise<number> {
    let staged = 0;
    for (const candidate of candidates) {
      if (!candidate.storageVersionId || candidate.storageStatus !== "verified") continue;
      const result = await this.database
        .update(schema.sessionObjects)
        .set({
          storageStatus: "pending_deletion",
          deleteEligibleAt: deleteEligibleAt.toISOString(),
          deletionError: null,
        })
        .where(
          and(
            eq(schema.sessionObjects.id, candidate.sessionObjectId),
            eq(schema.sessionObjects.storageStatus, "verified"),
          ),
        );
      if (result.rowsAffected > 0) staged += 1;
    }
    return staged;
  }

  async listDueRetention(ownerId: string, at = this.now()): Promise<RetentionCandidate[]> {
    const rows = await this.database
      .select({
        sessionObjectId: schema.sessionObjects.id,
        sessionId: schema.sessionObjects.sessionId,
        version: schema.sessionObjects.version,
        checksum: schema.sessionObjects.checksum,
        byteSize: schema.sessionObjects.byteSize,
        objectKey: schema.sessionObjects.objectKey,
        storageVersionId: schema.sessionObjects.storageVersionId,
        contentType: schema.sessionObjects.contentType,
        storageStatus: schema.sessionObjects.storageStatus,
        deleteEligibleAt: schema.sessionObjects.deleteEligibleAt,
        verifiedAt: schema.sessionObjects.verifiedAt,
      })
      .from(schema.sessionObjects)
      .innerJoin(schema.sessions, eq(schema.sessions.id, schema.sessionObjects.sessionId))
      .where(
        and(
          eq(schema.sessions.ownerId, ownerId),
          eq(schema.sessionObjects.storageStatus, "pending_deletion"),
          lte(schema.sessionObjects.deleteEligibleAt, at.toISOString()),
        ),
      );
    return rows.map((row) => ({ ...row, storageStatus: "pending_deletion" as const }));
  }

  async cancelRetention(sessionObjectId: string): Promise<void> {
    await this.database
      .update(schema.sessionObjects)
      .set({
        storageStatus: "verified",
        deleteEligibleAt: null,
        deletionError: null,
      })
      .where(
        and(
          eq(schema.sessionObjects.id, sessionObjectId),
          eq(schema.sessionObjects.storageStatus, "pending_deletion"),
        ),
      );
  }

  async markRetentionDeleted(sessionObjectId: string, deletedAt = this.now()): Promise<void> {
    await this.database
      .update(schema.sessionObjects)
      .set({
        storageStatus: "deleted",
        deleteEligibleAt: null,
        deletedAt: deletedAt.toISOString(),
        deletionError: null,
      })
      .where(
        and(
          eq(schema.sessionObjects.id, sessionObjectId),
          eq(schema.sessionObjects.storageStatus, "pending_deletion"),
        ),
      );
  }

  async recordRetentionDeletionError(sessionObjectId: string, message: string): Promise<void> {
    await this.database
      .update(schema.sessionObjects)
      .set({ deletionError: message.slice(0, 1000) })
      .where(
        and(
          eq(schema.sessionObjects.id, sessionObjectId),
          eq(schema.sessionObjects.storageStatus, "pending_deletion"),
        ),
      );
  }

  async listSessions(input: {
    ownerId: string;
    harness?: string;
    sourceInstallationId?: string;
    deviceId?: string;
    limit?: number;
    search?: string;
  }): Promise<CatalogSessionSummary[]> {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const harness = input.harness?.trim();
    const sourceInstallationId = input.sourceInstallationId?.trim();
    const deviceId = input.deviceId?.trim();
    const search = input.search?.trim();
    const searchCondition = search
      ? sql<boolean>`instr(lower(coalesce(${schema.sessions.title}, '') || ' ' || ${schema.sessions.externalId} || ' ' || coalesce(${schema.sessions.workingDirectory}, '')), lower(${search})) > 0`
      : undefined;

    return this.database
      .select({
        id: schema.sessions.id,
        ownerId: schema.sessions.ownerId,
        sourceInstallationId: schema.sessions.sourceInstallationId,
        sourceDeviceId: schema.sourceInstallations.deviceId,
        sourceDisplayName: schema.sourceInstallations.displayName,
        externalId: schema.sessions.externalId,
        harness: schema.sessions.harness,
        title: schema.sessions.title,
        workingDirectory: schema.sessions.workingDirectory,
        lifecycleStatus: schema.sessions.lifecycleStatus,
        startedAt: schema.sessions.startedAt,
        lastObservedAt: schema.sessions.lastObservedAt,
        latestVersion: schema.sessionObjects.version,
        latestByteSize: schema.sessionObjects.byteSize,
        latestVerifiedAt: schema.sessionObjects.verifiedAt,
      })
      .from(schema.sessions)
      .innerJoin(
        schema.sourceInstallations,
        eq(schema.sourceInstallations.id, schema.sessions.sourceInstallationId),
      )
      .leftJoin(schema.sessionObjects, eq(schema.sessionObjects.id, schema.sessions.latestObjectId))
      .where(
        and(
          eq(schema.sessions.ownerId, input.ownerId),
          harness ? eq(schema.sessions.harness, harness) : undefined,
          sourceInstallationId
            ? eq(schema.sessions.sourceInstallationId, sourceInstallationId)
            : undefined,
          deviceId ? eq(schema.sourceInstallations.deviceId, deviceId) : undefined,
          searchCondition,
        ),
      )
      .orderBy(desc(schema.sessionObjects.verifiedAt), desc(schema.sessions.lastObservedAt))
      .limit(limit);
  }

  async getSession(
    ownerId: string,
    identifier: string,
    versionLimit = 20,
  ): Promise<CatalogSessionDetails | undefined> {
    const [session] = await this.database
      .select({
        id: schema.sessions.id,
        ownerId: schema.sessions.ownerId,
        sourceInstallationId: schema.sessions.sourceInstallationId,
        sourceDeviceId: schema.sourceInstallations.deviceId,
        sourceDisplayName: schema.sourceInstallations.displayName,
        externalId: schema.sessions.externalId,
        harness: schema.sessions.harness,
        title: schema.sessions.title,
        workingDirectory: schema.sessions.workingDirectory,
        lifecycleStatus: schema.sessions.lifecycleStatus,
        formatVersion: schema.sessions.formatVersion,
        adapterVersion: schema.sessions.adapterVersion,
        startedAt: schema.sessions.startedAt,
        completedAt: schema.sessions.completedAt,
        lastObservedAt: schema.sessions.lastObservedAt,
        latestVersion: schema.sessionObjects.version,
        latestByteSize: schema.sessionObjects.byteSize,
        latestVerifiedAt: schema.sessionObjects.verifiedAt,
      })
      .from(schema.sessions)
      .innerJoin(
        schema.sourceInstallations,
        eq(schema.sourceInstallations.id, schema.sessions.sourceInstallationId),
      )
      .leftJoin(schema.sessionObjects, eq(schema.sessionObjects.id, schema.sessions.latestObjectId))
      .where(
        and(
          eq(schema.sessions.ownerId, ownerId),
          or(eq(schema.sessions.id, identifier), eq(schema.sessions.externalId, identifier)),
        ),
      )
      .limit(1);
    if (!session) return undefined;

    const versions = await this.database
      .select({
        id: schema.sessionObjects.id,
        version: schema.sessionObjects.version,
        checksum: schema.sessionObjects.checksum,
        byteSize: schema.sessionObjects.byteSize,
        objectKey: schema.sessionObjects.objectKey,
        storageVersionId: schema.sessionObjects.storageVersionId,
        contentType: schema.sessionObjects.contentType,
        storageStatus: schema.sessionObjects.storageStatus,
        observedAt: schema.sessionObjects.observedAt,
        verifiedAt: schema.sessionObjects.verifiedAt,
        deletedAt: schema.sessionObjects.deletedAt,
      })
      .from(schema.sessionObjects)
      .where(eq(schema.sessionObjects.sessionId, session.id))
      .orderBy(desc(schema.sessionObjects.version))
      .limit(Math.min(Math.max(versionLimit, 1), 100));

    return { ...session, versionCount: session.latestVersion ?? 0, versions };
  }

  async locateSessionObject(
    ownerId: string,
    identifier: string,
    version?: number,
  ): Promise<CatalogStorageLocation | undefined> {
    const [row] = await this.database
      .select(storageLocationSelection)
      .from(schema.sessions)
      .innerJoin(schema.sessionObjects, eq(schema.sessionObjects.sessionId, schema.sessions.id))
      .where(
        and(
          eq(schema.sessions.ownerId, ownerId),
          or(eq(schema.sessions.id, identifier), eq(schema.sessions.externalId, identifier)),
          version === undefined ? undefined : eq(schema.sessionObjects.version, version),
        ),
      )
      .orderBy(desc(schema.sessionObjects.version))
      .limit(1);
    if (!row) return undefined;

    return storageLocationFromRow(row);
  }

  async listStorageObjectsForVerification(input: {
    ownerId: string;
    identifier?: string;
    limit?: number;
    missingStorageVersionId?: boolean;
  }): Promise<CatalogStorageLocation[]> {
    const identifier = input.identifier?.trim();
    const query = this.database
      .select(storageLocationSelection)
      .from(schema.sessions)
      .innerJoin(schema.sessionObjects, eq(schema.sessionObjects.sessionId, schema.sessions.id))
      .where(
        and(
          eq(schema.sessions.ownerId, input.ownerId),
          identifier
            ? or(eq(schema.sessions.id, identifier), eq(schema.sessions.externalId, identifier))
            : undefined,
          or(
            eq(schema.sessionObjects.storageStatus, "verified"),
            eq(schema.sessionObjects.storageStatus, "pending_deletion"),
          ),
          input.missingStorageVersionId
            ? isNull(schema.sessionObjects.storageVersionId)
            : undefined,
        ),
      )
      .orderBy(desc(schema.sessionObjects.verifiedAt));
    const rows = input.limit === undefined ? await query : await query.limit(input.limit);
    return rows.map(storageLocationFromRow);
  }

  async getSyncJobSummary(): Promise<SyncJobSummary> {
    const rows = await this.database.select({ status: schema.syncJobs.status }).from(schema.syncJobs);
    const summary: SyncJobSummary = {
      pending: 0,
      processing: 0,
      retry: 0,
      completed: 0,
      failed: 0,
    };
    for (const row of rows) summary[row.status] += 1;
    return summary;
  }

  async getStorageStatusSummary(): Promise<StorageStatusSummary> {
    const rows = await this.database
      .select({ status: schema.sessionObjects.storageStatus })
      .from(schema.sessionObjects);
    const summary: StorageStatusSummary = { verified: 0, pendingDeletion: 0, deleted: 0 };
    for (const row of rows) {
      if (row.status === "verified") summary.verified += 1;
      if (row.status === "pending_deletion") summary.pendingDeletion += 1;
      if (row.status === "deleted") summary.deleted += 1;
    }
    return summary;
  }

  async prepareSnapshot(input: PrepareSnapshotInput): Promise<PreparedSnapshot> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this.prepareSnapshotOnce(input);
      } catch (error) {
        if (!isUniqueConstraintError(error) || attempt === 3) throw error;
      }
    }

    throw new Error("Failed to prepare session snapshot");
  }

  private async prepareSnapshotOnce(input: PrepareSnapshotInput): Promise<PreparedSnapshot> {
    return this.database.transaction(async (transaction) => {
      const [existingSession] = await transaction
        .select()
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.ownerId, input.ownerId),
            eq(schema.sessions.sourceInstallationId, input.sourceInstallationId),
            eq(schema.sessions.externalId, input.captured.externalId),
          ),
        )
        .limit(1);

      const now = this.now().toISOString();
      const sessionId = existingSession?.id ?? createId("ses");
      const lifecycleStatus = nextLifecycleStatus(
        existingSession?.lifecycleStatus,
        input.captured.lifecycleStatus,
      );

      if (existingSession) {
        await transaction
          .update(schema.sessions)
          .set({
            adapterVersion: input.captured.adapterVersion,
            lifecycleStatus,
            lastObservedAt: input.captured.observedAt,
            updatedAt: now,
            ...(input.captured.formatVersion === undefined
              ? {}
              : { formatVersion: input.captured.formatVersion }),
            ...(input.captured.title === undefined ? {} : { title: input.captured.title }),
            ...(input.captured.workingDirectory === undefined
              ? {}
              : { workingDirectory: input.captured.workingDirectory }),
            ...(input.captured.startedAt === undefined ? {} : { startedAt: input.captured.startedAt }),
            ...(input.captured.completedAt === undefined
              ? {}
              : { completedAt: input.captured.completedAt }),
          })
          .where(eq(schema.sessions.id, sessionId));
      } else {
        await transaction.insert(schema.sessions).values({
          id: sessionId,
          ownerId: input.ownerId,
          sourceInstallationId: input.sourceInstallationId,
          externalId: input.captured.externalId,
          harness: input.captured.harness,
          ...(input.captured.formatVersion === undefined
            ? {}
            : { formatVersion: input.captured.formatVersion }),
          adapterVersion: input.captured.adapterVersion,
          ...(input.captured.title === undefined ? {} : { title: input.captured.title }),
          ...(input.captured.workingDirectory === undefined
            ? {}
            : { workingDirectory: input.captured.workingDirectory }),
          lifecycleStatus,
          ...(input.captured.startedAt === undefined ? {} : { startedAt: input.captured.startedAt }),
          ...(input.captured.completedAt === undefined
            ? {}
            : { completedAt: input.captured.completedAt }),
          lastObservedAt: input.captured.observedAt,
          createdAt: now,
          updatedAt: now,
        });
      }

      const [existingObject] = await transaction
        .select({ id: schema.sessionObjects.id })
        .from(schema.sessionObjects)
        .where(
          and(
            eq(schema.sessionObjects.sessionId, sessionId),
            eq(schema.sessionObjects.checksum, input.captured.snapshot.checksum),
          ),
        )
        .limit(1);

      return {
        sessionId,
        ...(existingObject === undefined ? {} : { existingObjectId: existingObject.id }),
      };
    });
  }

  async recordVerifiedSnapshot(input: RecordVerifiedSnapshotInput): Promise<RecordedSnapshot> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this.recordVerifiedSnapshotOnce(input);
      } catch (error) {
        if (!isUniqueConstraintError(error) || attempt === 3) throw error;
      }
    }

    throw new Error("Failed to record verified session snapshot");
  }

  private async recordVerifiedSnapshotOnce(input: RecordVerifiedSnapshotInput): Promise<RecordedSnapshot> {
    return this.database.transaction(async (transaction) => {
      const [existingObject] = await transaction
        .select({ id: schema.sessionObjects.id, version: schema.sessionObjects.version })
        .from(schema.sessionObjects)
        .where(
          and(
            eq(schema.sessionObjects.sessionId, input.sessionId),
            eq(schema.sessionObjects.checksum, input.captured.snapshot.checksum),
          ),
        )
        .limit(1);

      if (existingObject) {
        return {
          sessionObjectId: existingObject.id,
          version: existingObject.version,
          created: false,
        };
      }

      const [session] = await transaction
        .select({ latestObjectId: schema.sessions.latestObjectId })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, input.sessionId))
        .limit(1);
      if (!session) throw new Error(`Session does not exist: ${input.sessionId}`);

      const [versionResult] = await transaction
        .select({ value: max(schema.sessionObjects.version) })
        .from(schema.sessionObjects)
        .where(eq(schema.sessionObjects.sessionId, input.sessionId));
      const version = (versionResult?.value ?? 0) + 1;
      const sessionObjectId = createId("obj");
      const now = this.now().toISOString();
      const uploadedAt = input.uploadedAt ?? now;

      await transaction.insert(schema.sessionObjects).values({
        id: sessionObjectId,
        sessionId: input.sessionId,
        version,
        objectKey: input.objectKey,
        ...(input.storageVersionId === undefined
          ? {}
          : { storageVersionId: input.storageVersionId }),
        contentType: input.captured.snapshot.contentType,
        originalFilename: input.captured.snapshot.originalFilename,
        checksum: input.captured.snapshot.checksum,
        byteSize: input.captured.snapshot.byteSize,
        storageStatus: "verified",
        observedAt: input.captured.observedAt,
        uploadedAt,
        verifiedAt: now,
        createdAt: now,
      });

      await transaction
        .update(schema.sessions)
        .set({ latestObjectId: sessionObjectId, updatedAt: now })
        .where(eq(schema.sessions.id, input.sessionId));

      if (this.emitOutboxEvents) {
        if (!session.latestObjectId) {
          await insertOutboxEvent(transaction, {
            eventKey: `session.created:${input.sessionId}`,
            type: "session.created",
            aggregateId: input.sessionId,
            payload: { sessionId: input.sessionId, sessionObjectId },
            now,
          });
        }
        await insertOutboxEvent(transaction, {
          eventKey: `session.object.created:${sessionObjectId}`,
          type: "session.object.created",
          aggregateId: input.sessionId,
          payload: { sessionId: input.sessionId, sessionObjectId, version },
          now,
        });
      }

      return { sessionObjectId, version, created: true };
    });
  }
}

function storageLocationFromRow(row: {
  ownerId: string;
  harness: string;
  sessionId: string;
  externalId: string;
  sourceInstallationId: string;
  id: string;
  version: number;
  checksum: string;
  byteSize: number;
  objectKey: string;
  storageVersionId: string | null;
  contentType: string;
  storageStatus: "verified" | "pending_deletion" | "deleted";
  observedAt: string;
  verifiedAt: string;
  deletedAt: string | null;
}): CatalogStorageLocation {
  return {
    ownerId: row.ownerId,
    harness: row.harness,
    sessionId: row.sessionId,
    externalId: row.externalId,
    sourceInstallationId: row.sourceInstallationId,
    version: {
      id: row.id,
      version: row.version,
      checksum: row.checksum,
      byteSize: row.byteSize,
      objectKey: row.objectKey,
      storageVersionId: row.storageVersionId,
      contentType: row.contentType,
      storageStatus: row.storageStatus,
      observedAt: row.observedAt,
      verifiedAt: row.verifiedAt,
      deletedAt: row.deletedAt,
    },
  };
}

type CatalogTransaction = Parameters<
  Parameters<LibSQLDatabase<typeof schema>["transaction"]>[0]
>[0];

async function insertOutboxEvent(
  transaction: CatalogTransaction,
  input: {
    eventKey: string;
    type: string;
    aggregateId: string;
    payload: Record<string, unknown>;
    now: string;
  },
): Promise<void> {
  await transaction
    .insert(schema.outboxEvents)
    .values({
      id: createId("evt"),
      eventKey: input.eventKey,
      type: input.type,
      aggregateId: input.aggregateId,
      payload: JSON.stringify(input.payload),
      occurredAt: input.now,
      availableAt: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoNothing({ target: schema.outboxEvents.eventKey });
}

function clientConfiguration(options: SessionCatalogOptions): { url: string; authToken?: string } {
  return {
    url: options.url,
    ...(options.authToken === undefined ? {} : { authToken: options.authToken }),
  };
}

function nextLifecycleStatus(
  current: SessionLifecycleStatus | undefined,
  observed: SessionLifecycleStatus,
): SessionLifecycleStatus {
  if (current === "completed" || observed === "completed") return "completed";
  if (observed === "unknown" && current) return current;
  return observed;
}

function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function retryDelayMilliseconds(attemptCount: number): number {
  const baseDelay = 30_000;
  const maximumDelay = 60 * 60 * 1000;
  return Math.min(baseDelay * 2 ** Math.max(0, attemptCount - 1), maximumDelay);
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /unique constraint/i.test(error.message);
}
