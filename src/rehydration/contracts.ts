export type RehydrationStatus = "ready" | "already_present" | "conflict" | "unsupported";

export type RehydrationPlan = {
  harness: string;
  status: RehydrationStatus;
  sessionId: string;
  externalId: string;
  sessionObjectId: string;
  snapshotChecksum: string;
  snapshotByteSize: number;
  workingDirectory?: string;
  sessionRoot?: string;
  targetPath?: string;
  changes: string[];
  warnings: string[];
  precondition?: {
    targetMustNotExist: boolean;
  };
};

export type RehydrationContext = {
  sessionId: string;
  externalId: string;
  sourceHarness: string;
  workingDirectory?: string;
  version: number;
  sessionObjectId: string;
  snapshotChecksum: string;
  byteSize: number;
  originalFilename?: string;
  requestedSessionRoot?: string;
};

export type RehydrationResult = {
  status: "installed" | "already_present";
  targetPath?: string;
  warnings?: string[];
};

export interface SessionRehydrationAdapter {
  readonly harness: string;

  plan(context: RehydrationContext): Promise<RehydrationPlan>;
  validateSnapshot(plan: RehydrationPlan, stagedPath: string): Promise<void>;
  apply(plan: RehydrationPlan, stagedPath: string): Promise<RehydrationResult>;
}
