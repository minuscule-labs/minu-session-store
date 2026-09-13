import type { CatalogStorageLocation, SessionCatalog } from "../catalog/session-catalog.js";
import type { RetrievableObjectStore } from "../core/contracts.js";
import { retrieveVerifiedSessionObject } from "../operations/session-restorer.js";
import type {
  RehydrationContext,
  RehydrationPlan,
  SessionRehydrationAdapter,
} from "./contracts.js";

export type SessionRehydrationRequest = {
  sessionId: string;
  targetHarness: string;
  version?: number;
  sessionRoot?: string;
};

export type SessionRehydrationApplyResult = {
  status: "installed" | "already_present";
  harness: string;
  sessionId: string;
  sessionObjectId: string;
  version: number;
  checksum: string;
  byteSize: number;
  targetPath?: string;
  warnings: string[];
};

export type SessionRehydratorOptions = {
  ownerId: string;
  catalog: Pick<SessionCatalog, "locateSessionObjectById">;
  objectStore: RetrievableObjectStore;
  adapters: ReadonlyMap<string, SessionRehydrationAdapter>;
  platform?: NodeJS.Platform;
};

export class SessionRehydrator {
  private readonly ownerId: string;
  private readonly catalog: Pick<SessionCatalog, "locateSessionObjectById">;
  private readonly objectStore: RetrievableObjectStore;
  private readonly adapters: ReadonlyMap<string, SessionRehydrationAdapter>;
  private readonly platform: NodeJS.Platform;

  constructor(options: SessionRehydratorOptions) {
    this.ownerId = options.ownerId;
    this.catalog = options.catalog;
    this.objectStore = options.objectStore;
    this.adapters = options.adapters;
    this.platform = options.platform ?? process.platform;
  }

  async plan(input: SessionRehydrationRequest): Promise<RehydrationPlan> {
    return (await this.prepare(input)).plan;
  }

  async apply(input: SessionRehydrationRequest): Promise<SessionRehydrationApplyResult> {
    const prepared = await this.prepare(input);
    const { location, adapter, plan } = prepared;
    if (plan.status === "already_present") return resultFromPlan(location, plan);
    if (plan.status !== "ready") {
      throw new Error(`Rehydration cannot apply a ${plan.status} plan`);
    }

    const restored = await retrieveVerifiedSessionObject({
      target: location,
      objectStore: this.objectStore,
    });
    try {
      await adapter.validateSnapshot(plan, restored.path);
      const applied = await adapter.apply(plan, restored.path);
      return {
        status: applied.status,
        harness: plan.harness,
        sessionId: location.sessionId,
        sessionObjectId: location.version.id,
        version: location.version.version,
        checksum: restored.checksum,
        byteSize: restored.byteSize,
        ...(applied.targetPath === undefined && plan.targetPath === undefined
          ? {}
          : { targetPath: applied.targetPath ?? plan.targetPath! }),
        warnings: [...new Set([...plan.warnings, ...(applied.warnings ?? [])])],
      };
    } finally {
      await restored.dispose();
    }
  }

  private async prepare(input: SessionRehydrationRequest): Promise<{
    location: CatalogStorageLocation;
    adapter: SessionRehydrationAdapter;
    plan: RehydrationPlan;
  }> {
    assertSupportedPlatform(this.platform);
    const location = await this.catalog.locateSessionObjectById(
      this.ownerId,
      input.sessionId,
      input.version,
    );
    if (!location) {
      throw new Error(`Stored session object not found for catalog session ID: ${input.sessionId}`);
    }
    assertRehydratableObject(location);

    const adapter = this.adapters.get(input.targetHarness);
    if (!adapter) {
      throw new Error(
        `Automatic rehydration is not supported for ${input.targetHarness}. ` +
          "Restore the native snapshot with: minu-sessions sessions restore ...",
      );
    }
    if (adapter.harness !== input.targetHarness) {
      throw new Error(
        `Rehydration adapter registry maps ${input.targetHarness} to ${adapter.harness}`,
      );
    }
    if (location.harness !== input.targetHarness) {
      throw new Error(
        `Cannot rehydrate a ${location.harness} session into ${input.targetHarness}. ` +
          "Restore the native snapshot with: minu-sessions sessions restore ...",
      );
    }

    const context = rehydrationContext(location, input.sessionRoot);
    const plan = await adapter.plan(context);
    assertPlanMatchesContext(plan, context, adapter.harness);
    return { location, adapter, plan };
  }
}

function assertSupportedPlatform(platform: NodeJS.Platform): void {
  if (platform !== "darwin") {
    throw new Error("Harness rehydration is currently supported only on macOS");
  }
}

function assertRehydratableObject(location: CatalogStorageLocation): void {
  if (location.version.storageStatus === "deleted") {
    throw new Error("The selected session object has been deleted from storage");
  }
  if (!location.version.storageVersionId?.trim()) {
    throw new Error("Rehydration requires an exact cataloged S3 VersionId");
  }
}

function rehydrationContext(
  location: CatalogStorageLocation,
  requestedSessionRoot: string | undefined,
): RehydrationContext {
  return {
    sessionId: location.sessionId,
    externalId: location.externalId,
    sourceHarness: location.harness,
    ...(location.workingDirectory === undefined
      ? {}
      : { workingDirectory: location.workingDirectory }),
    version: location.version.version,
    sessionObjectId: location.version.id,
    snapshotChecksum: location.version.checksum,
    byteSize: location.version.byteSize,
    ...(location.version.originalFilename === undefined
      ? {}
      : { originalFilename: location.version.originalFilename }),
    ...(requestedSessionRoot === undefined ? {} : { requestedSessionRoot }),
  };
}

function assertPlanMatchesContext(
  plan: RehydrationPlan,
  context: RehydrationContext,
  harness: string,
): void {
  if (
    plan.harness !== harness ||
    plan.sessionId !== context.sessionId ||
    plan.externalId !== context.externalId ||
    plan.sessionObjectId !== context.sessionObjectId ||
    plan.snapshotChecksum !== context.snapshotChecksum ||
    plan.snapshotByteSize !== context.byteSize
  ) {
    throw new Error("Rehydration adapter returned a plan for a different session snapshot");
  }
}

function resultFromPlan(
  location: CatalogStorageLocation,
  plan: RehydrationPlan,
): SessionRehydrationApplyResult {
  return {
    status: "already_present",
    harness: plan.harness,
    sessionId: location.sessionId,
    sessionObjectId: location.version.id,
    version: location.version.version,
    checksum: location.version.checksum,
    byteSize: location.version.byteSize,
    ...(plan.targetPath === undefined ? {} : { targetPath: plan.targetPath }),
    warnings: plan.warnings,
  };
}
