import type { SessionCatalog } from "../catalog/session-catalog.js";
import type { SessionSourceAdapter } from "../core/contracts.js";
import type { SyncSessionService } from "../core/sync-session.js";

export type DaemonScanSummary = {
  startedAt: string;
  completedAt: string;
  discovered: number;
  skippedByFingerprint: number;
  deferred: number;
  unchanged: number;
  uploaded: number;
  updated: number;
  failed: number;
  bytesStored: number;
};

export type SessionDaemonOptions = {
  sourceInstallationId: string;
  source: SessionSourceAdapter;
  catalog: SessionCatalog;
  syncService: SyncSessionService;
  scanIntervalMs?: number;
  quietPeriodMs?: number;
  maximumWaitMs?: number;
  now?: () => Date;
  onScanComplete?: (summary: DaemonScanSummary) => void | Promise<void>;
  onError?: (error: { path?: string; code: string; message: string }) => void;
};

export class SessionDaemon {
  private readonly scanIntervalMs: number;
  private readonly quietPeriodMs: number;
  private readonly maximumWaitMs: number;
  private readonly now: () => Date;
  private activeScan: Promise<DaemonScanSummary> | undefined;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: SessionDaemonOptions) {
    this.scanIntervalMs = options.scanIntervalMs ?? 60_000;
    this.quietPeriodMs = options.quietPeriodMs ?? 120_000;
    this.maximumWaitMs = options.maximumWaitMs ?? 1_800_000;
    this.now = options.now ?? (() => new Date());
    if (this.scanIntervalMs < 1_000) throw new Error("Daemon scan interval must be at least one second");
    if (this.quietPeriodMs < 0) throw new Error("Daemon quiet period cannot be negative");
    if (this.maximumWaitMs < this.quietPeriodMs) {
      throw new Error("Daemon maximum wait must be at least the quiet period");
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.scanOnce();
      } catch (error) {
        this.options.onError?.(sanitizedError(error));
      }
      await waitForNextScan(this.scanIntervalMs, signal);
    }
  }

  async scanOnce(options: { force?: boolean } = {}): Promise<DaemonScanSummary> {
    if (this.activeScan) return this.activeScan;
    const scan = this.runExclusive(() => this.performScan(options.force ?? false));
    this.activeScan = scan;
    try {
      return await scan;
    } finally {
      if (this.activeScan === scan) this.activeScan = undefined;
    }
  }

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release: () => void = () => {};
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async performScan(force: boolean): Promise<DaemonScanSummary> {
    const startedAt = this.now().toISOString();
    const summary = {
      startedAt,
      completedAt: startedAt,
      discovered: 0,
      skippedByFingerprint: 0,
      deferred: 0,
      unchanged: 0,
      uploaded: 0,
      updated: 0,
      failed: 0,
      bytesStored: 0,
    } satisfies DaemonScanSummary;

    for await (const session of this.options.source.discover()) {
      summary.discovered += 1;
      const decision = force
        ? "sync"
        : await this.options.catalog.evaluateSourceSync(
            this.options.sourceInstallationId,
            session,
            {
              quietPeriodMs: this.quietPeriodMs,
              maximumWaitMs: this.maximumWaitMs,
            },
          );
      if (decision !== "sync") {
        if (decision === "unchanged") summary.skippedByFingerprint += 1;
        else summary.deferred += 1;
        continue;
      }

      await this.options.catalog.markSyncStarted(this.options.sourceInstallationId, session);
      try {
        const result = await this.options.syncService.sync(session);
        summary[result.status] += 1;
        if (result.status !== "unchanged") summary.bytesStored += result.byteSize;
        await this.options.catalog.markSyncCompleted(
          this.options.sourceInstallationId,
          session,
          result.checksum,
        );
      } catch (error) {
        summary.failed += 1;
        const sanitized = sanitizedError(error, session.path);
        await this.options.catalog.markSyncFailed(
          this.options.sourceInstallationId,
          session,
          sanitized,
        );
        this.options.onError?.(sanitized);
      }
    }

    summary.completedAt = this.now().toISOString();
    await this.options.onScanComplete?.(summary);
    return summary;
  }
}

function sanitizedError(error: unknown, path?: string): { path?: string; code: string; message: string } {
  const code =
    error instanceof Error && error.name && error.name !== "Error"
      ? error.name
      : "SESSION_SYNC_FAILED";
  const message = error instanceof Error ? error.message : "Unknown session synchronization failure";
  return {
    ...(path === undefined ? {} : { path }),
    code,
    message: message.slice(0, 1000),
  };
}

async function waitForNextScan(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });

    function finish(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}
