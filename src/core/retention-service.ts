import type {
  RetentionCandidate,
  RetentionPlan,
  RetentionPolicy,
  SessionCatalog,
} from "../catalog/session-catalog.js";
import type { VersionedObjectStore } from "./contracts.js";

export type RetentionServiceOptions = {
  ownerId: string;
  catalog: SessionCatalog;
  objectStore: VersionedObjectStore;
  policy: RetentionPolicy;
  gracePeriodMs: number;
  now?: () => Date;
  onError?: (error: { sessionObjectId: string; message: string }) => void;
};

export type RetentionRunSummary = {
  planned: number;
  reconciledVersionIds: number;
  staged: number;
  cancelled: number;
  deleted: number;
  deletedBytes: number;
  failed: number;
};

export class RetentionService {
  private readonly now: () => Date;

  constructor(private readonly options: RetentionServiceOptions) {
    if (options.gracePeriodMs < 0) throw new Error("Retention grace period cannot be negative");
    this.now = options.now ?? (() => new Date());
  }

  async run(): Promise<RetentionRunSummary> {
    const summary: RetentionRunSummary = {
      planned: 0,
      reconciledVersionIds: 0,
      staged: 0,
      cancelled: 0,
      deleted: 0,
      deletedBytes: 0,
      failed: 0,
    };

    let plan = await this.options.catalog.planRetention(
      this.options.ownerId,
      this.options.policy,
      this.now(),
    );
    summary.planned = plan.candidates.length;
    await this.reconcileStorageVersionIds(plan, summary);
    plan = await this.options.catalog.planRetention(
      this.options.ownerId,
      this.options.policy,
      this.now(),
    );

    const eligibleIds = new Set(plan.candidates.map((candidate) => candidate.sessionObjectId));
    const due = await this.options.catalog.listDueRetention(this.options.ownerId, this.now());
    for (const candidate of due) {
      if (!eligibleIds.has(candidate.sessionObjectId)) {
        await this.options.catalog.cancelRetention(candidate.sessionObjectId);
        summary.cancelled += 1;
        continue;
      }
      if (!candidate.storageVersionId) {
        this.reportFailure(summary, candidate, "S3 VersionId is missing");
        continue;
      }

      try {
        await this.options.objectStore.deleteVersion({
          objectKey: candidate.objectKey,
          storageVersionId: candidate.storageVersionId,
        });
        await this.options.catalog.markRetentionDeleted(candidate.sessionObjectId, this.now());
        summary.deleted += 1;
        summary.deletedBytes += candidate.byteSize;
      } catch (error) {
        const message = errorMessage(error);
        await this.options.catalog.recordRetentionDeletionError(candidate.sessionObjectId, message);
        this.reportFailure(summary, candidate, message);
      }
    }

    plan = await this.options.catalog.planRetention(
      this.options.ownerId,
      this.options.policy,
      this.now(),
    );
    const deleteEligibleAt = new Date(this.now().getTime() + this.options.gracePeriodMs);
    summary.staged = await this.options.catalog.stageRetentionCandidates(
      plan.candidates,
      deleteEligibleAt,
    );
    return summary;
  }

  private async reconcileStorageVersionIds(
    plan: RetentionPlan,
    summary: RetentionRunSummary,
  ): Promise<void> {
    for (const candidate of plan.candidates) {
      if (candidate.storageVersionId) continue;
      try {
        const verified = await this.options.objectStore.verify({
          objectKey: candidate.objectKey,
          checksum: candidate.checksum,
          byteSize: candidate.byteSize,
          contentType: candidate.contentType,
        });
        if (!verified.storageVersionId) {
          throw new Error("Object store did not return an S3 VersionId");
        }
        await this.options.catalog.recordStorageVersionId(
          candidate.sessionObjectId,
          candidate.objectKey,
          verified.storageVersionId,
        );
        summary.reconciledVersionIds += 1;
      } catch (error) {
        this.reportFailure(summary, candidate, errorMessage(error));
      }
    }
  }

  private reportFailure(
    summary: RetentionRunSummary,
    candidate: RetentionCandidate,
    message: string,
  ): void {
    summary.failed += 1;
    this.options.onError?.({ sessionObjectId: candidate.sessionObjectId, message });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
