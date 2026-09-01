import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const sourceInstallations = sqliteTable(
  "source_installations",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    harness: text("harness").notNull(),
    deviceId: text("device_id").notNull(),
    displayName: text("display_name"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("source_installations_owner_harness_device_uidx").on(
      table.ownerId,
      table.harness,
      table.deviceId,
    ),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    sourceInstallationId: text("source_installation_id")
      .notNull()
      .references(() => sourceInstallations.id, { onDelete: "restrict" }),
    externalId: text("external_id").notNull(),
    harness: text("harness").notNull(),
    formatVersion: text("format_version"),
    adapterVersion: text("adapter_version").notNull(),
    title: text("title"),
    workingDirectory: text("working_directory"),
    lifecycleStatus: text("lifecycle_status", { enum: ["active", "completed", "unknown"] })
      .notNull()
      .default("unknown"),
    latestObjectId: text("latest_object_id"),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    lastObservedAt: text("last_observed_at").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("sessions_owner_source_external_uidx").on(
      table.ownerId,
      table.sourceInstallationId,
      table.externalId,
    ),
    index("sessions_harness_started_idx").on(table.harness, table.startedAt),
    index("sessions_lifecycle_observed_idx").on(table.lifecycleStatus, table.lastObservedAt),
  ],
);

export const sessionObjects = sqliteTable(
  "session_objects",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    objectType: text("object_type", { enum: ["raw_session"] }).notNull().default("raw_session"),
    objectKey: text("object_key").notNull(),
    storageVersionId: text("storage_version_id"),
    contentType: text("content_type").notNull(),
    originalFilename: text("original_filename"),
    checksumAlgorithm: text("checksum_algorithm", { enum: ["sha256"] }).notNull().default("sha256"),
    checksum: text("checksum").notNull(),
    byteSize: integer("byte_size").notNull(),
    storageStatus: text("storage_status", {
      enum: ["verified", "pending_deletion", "deleted"],
    }).notNull(),
    pinnedAt: text("pinned_at"),
    deleteEligibleAt: text("delete_eligible_at"),
    deletedAt: text("deleted_at"),
    deletionError: text("deletion_error"),
    observedAt: text("observed_at").notNull(),
    uploadedAt: text("uploaded_at").notNull(),
    verifiedAt: text("verified_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("session_objects_session_checksum_uidx").on(table.sessionId, table.checksum),
    uniqueIndex("session_objects_session_version_uidx").on(table.sessionId, table.version),
    uniqueIndex("session_objects_key_uidx").on(table.objectKey),
    index("session_objects_session_created_idx").on(table.sessionId, table.createdAt),
  ],
);

export const outboxEvents = sqliteTable(
  "outbox_events",
  {
    id: text("id").primaryKey(),
    eventKey: text("event_key").notNull(),
    type: text("type").notNull(),
    version: integer("version").notNull().default(1),
    aggregateId: text("aggregate_id").notNull(),
    payload: text("payload").notNull(),
    occurredAt: text("occurred_at").notNull(),
    availableAt: text("available_at").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: text("lease_expires_at"),
    deliveredAt: text("delivered_at"),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("outbox_events_event_key_uidx").on(table.eventKey),
    index("outbox_events_delivery_idx").on(table.deliveredAt, table.availableAt, table.leaseExpiresAt),
  ],
);

export const syncJobs = sqliteTable(
  "sync_jobs",
  {
    id: text("id").primaryKey(),
    sourceInstallationId: text("source_installation_id")
      .notNull()
      .references(() => sourceInstallations.id, { onDelete: "cascade" }),
    sourcePath: text("source_path").notNull(),
    sourceMtimeMs: integer("source_mtime_ms"),
    sourceByteSize: integer("source_byte_size"),
    pendingMtimeMs: integer("pending_mtime_ms"),
    pendingByteSize: integer("pending_byte_size"),
    firstChangedAt: text("first_changed_at"),
    lastChangedAt: text("last_changed_at"),
    lastChecksum: text("last_checksum"),
    status: text("status", { enum: ["pending", "processing", "retry", "completed", "failed"] })
      .notNull()
      .default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: text("next_attempt_at").notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: text("lease_expires_at"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    lastAttemptAt: text("last_attempt_at"),
    lastSucceededAt: text("last_succeeded_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("sync_jobs_source_path_uidx").on(table.sourceInstallationId, table.sourcePath),
    index("sync_jobs_claim_idx").on(table.status, table.nextAttemptAt, table.leaseExpiresAt),
  ],
);
