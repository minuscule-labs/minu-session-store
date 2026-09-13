import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  RehydrationContext,
  RehydrationPlan,
  RehydrationResult,
  SessionRehydrationAdapter,
} from "../../rehydration/contracts.js";
import { resolvePiSessionRoots, type PiSessionRootOptions } from "./pi-session-roots.js";

const MAX_HEADER_BYTES = 1024 * 1024;
const READ_BUFFER_BYTES = 64 * 1024;

export type PiSessionRehydrationAdapterOptions = PiSessionRootOptions & {
  maxHeaderBytes?: number;
};

type PiSessionHeader = {
  type: "session";
  version: number;
  id: string;
  cwd: string;
};

/**
 * Pi v3 stores each project below the sessions root as --<encoded-cwd>--.
 * Its SessionManager discovers .jsonl files directly in that project directory.
 */
export class PiSessionRehydrationAdapter implements SessionRehydrationAdapter {
  readonly harness = "pi";

  private readonly options: PiSessionRootOptions & { maxHeaderBytes: number };

  constructor(options: PiSessionRehydrationAdapterOptions = {}) {
    const maxHeaderBytes = options.maxHeaderBytes ?? MAX_HEADER_BYTES;
    if (!Number.isSafeInteger(maxHeaderBytes) || maxHeaderBytes < 1) {
      throw new Error("Pi header scan limit must be a positive integer");
    }
    this.options = {
      maxHeaderBytes,
      ...(options.sessionRoots === undefined ? {} : { sessionRoots: options.sessionRoots }),
      ...(options.agentDirectory === undefined ? {} : { agentDirectory: options.agentDirectory }),
    };
  }

  async plan(context: RehydrationContext): Promise<RehydrationPlan> {
    const workingDirectory = requireWorkingDirectory(context);
    const sessionRoot = await this.resolveSessionRoot(context.requestedSessionRoot);
    const targetDirectory = join(sessionRoot, piProjectDirectoryName(workingDirectory));
    await assertSafeTargetDirectory(sessionRoot, targetDirectory);

    const filename = piSessionFilename(context);
    const targetPath = join(targetDirectory, filename);
    const collisions = await findSessionCollisions(sessionRoot, targetPath, context);
    if (collisions.hasConflict) {
      return piPlan(context, workingDirectory, {
        status: "conflict",
        sessionRoot,
        targetPath,
        changes: [],
        warnings: collisionWarnings(collisions),
      });
    }
    if (collisions.identicalPaths.length > 0) {
      const existingPath = collisions.identicalPaths[0]!;
      return piPlan(context, workingDirectory, {
        status: "already_present",
        sessionRoot,
        targetPath: existingPath,
        changes: [],
        warnings: existingPath === targetPath ? [] : [`Identical Pi session already exists at ${existingPath}`],
      });
    }

    return piPlan(context, workingDirectory, {
      status: "ready",
      sessionRoot,
      targetPath,
      changes: [`Install the exact Pi v3 snapshot at ${targetPath}`],
      warnings:
        context.originalFilename === undefined || context.originalFilename !== filename
          ? ["The archived filename is unavailable or incompatible; a deterministic Pi filename will be used"]
          : [],
      precondition: { targetMustNotExist: true },
    });
  }

  async validateSnapshot(plan: RehydrationPlan, stagedPath: string): Promise<void> {
    if (plan.harness !== this.harness) throw new Error("Pi adapter received a plan for another harness");
    const fileStats = await lstat(stagedPath);
    if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
      throw new Error("Pi snapshot is not a regular file");
    }
    const header = await readPiV3Header(stagedPath, this.options.maxHeaderBytes);
    if (header.id !== plan.externalId) {
      throw new Error("Pi snapshot header does not match the catalog external session ID");
    }
    if (plan.workingDirectory !== undefined && resolve(header.cwd) !== resolve(plan.workingDirectory)) {
      throw new Error("Pi snapshot header working directory does not match catalog metadata");
    }
    if (fileStats.size !== plan.snapshotByteSize) {
      throw new Error("Pi snapshot size does not match the verified restore result");
    }

    await assertCompleteJsonlBoundary(stagedPath, fileStats.size);
    if ((await sha256File(stagedPath)) !== plan.snapshotChecksum.toLowerCase()) {
      throw new Error("Pi snapshot checksum does not match the verified restore result");
    }
  }

  async apply(plan: RehydrationPlan, stagedPath: string): Promise<RehydrationResult> {
    const targetPath = requirePlanTargetPath(plan);
    const sessionRoot = requirePlanSessionRoot(plan);
    const root = await validateSessionRoot(sessionRoot, true);
    const targetDirectory = dirname(targetPath);
    assertPlannedTarget(root, targetDirectory, targetPath, plan);
    await assertSafeTargetDirectory(root, targetDirectory);

    const collisions = await findSessionCollisions(root, targetPath, contextFromPlan(plan));
    if (collisions.hasConflict) {
      throw new Error(`Pi rehydration conflicts with existing sessions: ${collisions.conflictingPaths.join(", ")}`);
    }
    if (collisions.identicalPaths.length > 0) {
      const existingPath = collisions.identicalPaths[0]!;
      return {
        status: "already_present",
        targetPath: existingPath,
        warnings:
          existingPath === targetPath ? [] : [`Identical Pi session already exists at ${existingPath}`],
      };
    }

    await createSafeTargetDirectory(root, targetDirectory);
    return installSnapshot(stagedPath, targetPath, plan);
  }

  private async resolveSessionRoot(requestedRoot: string | undefined): Promise<string> {
    if (requestedRoot !== undefined) return validateSessionRoot(requestedRoot, true);

    const roots = await resolvePiSessionRoots(this.options);
    const usableRoots = (
      await Promise.all(
        roots.map(async (root) => {
          try {
            return await validateSessionRoot(root, false);
          } catch {
            return undefined;
          }
        }),
      )
    ).filter((root): root is string => root !== undefined);
    if (usableRoots.length !== 1) {
      throw new Error(
        usableRoots.length === 0
          ? "No existing writable Pi session root was found; create one or pass --session-root"
          : "Multiple Pi session roots were found; select one with --session-root",
      );
    }
    return usableRoots[0]!;
  }
}

function requirePlanTargetPath(plan: RehydrationPlan): string {
  if (!plan.targetPath || !isAbsolute(plan.targetPath)) {
    throw new Error("Pi rehydration plan has no absolute target path");
  }
  return resolve(plan.targetPath);
}

function requirePlanSessionRoot(plan: RehydrationPlan): string {
  if (!plan.sessionRoot || !isAbsolute(plan.sessionRoot)) {
    throw new Error("Pi rehydration plan has no absolute session root");
  }
  return plan.sessionRoot;
}

function assertPlannedTarget(
  root: string,
  targetDirectory: string,
  targetPath: string,
  plan: RehydrationPlan,
): void {
  if (!plan.workingDirectory) throw new Error("Pi rehydration plan has no working directory");
  const expectedDirectory = join(root, piProjectDirectoryName(resolve(plan.workingDirectory)));
  if (targetDirectory !== expectedDirectory || targetPath !== join(expectedDirectory, basename(targetPath))) {
    throw new Error("Pi rehydration plan target is outside its expected project directory");
  }
}

function contextFromPlan(plan: RehydrationPlan): RehydrationContext {
  return {
    sessionId: plan.sessionId,
    externalId: plan.externalId,
    sourceHarness: "pi",
    version: 0,
    sessionObjectId: plan.sessionObjectId,
    snapshotChecksum: plan.snapshotChecksum,
    byteSize: plan.snapshotByteSize,
  };
}

async function createSafeTargetDirectory(root: string, targetDirectory: string): Promise<void> {
  try {
    await mkdir(targetDirectory, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
  }
  await assertSafeTargetDirectory(root, targetDirectory);
}

async function installSnapshot(
  stagedPath: string,
  targetPath: string,
  plan: RehydrationPlan,
): Promise<RehydrationResult> {
  await assertVerifiedFile(stagedPath, plan.snapshotByteSize, plan.snapshotChecksum);
  const temporaryDirectory = await mkdtemp(join(dirname(targetPath), ".minu-rehydrate-"));
  const temporaryPath = join(temporaryDirectory, basename(targetPath));

  try {
    await chmod(temporaryDirectory, 0o700);
    try {
      await link(stagedPath, temporaryPath);
    } catch (error) {
      if (!isNodeError(error, "EXDEV")) throw error;
      await copyVerifiedFile(stagedPath, temporaryPath);
    }
    await assertVerifiedFile(temporaryPath, plan.snapshotByteSize, plan.snapshotChecksum);

    try {
      await link(temporaryPath, targetPath);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const state = await compareSnapshot(targetPath, contextFromPlan(plan));
      if (state === "identical") return { status: "already_present", targetPath };
      throw new Error(`Pi rehydration target already exists with different bytes: ${targetPath}`);
    }
    await unlink(temporaryPath);
    return { status: "installed", targetPath };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function copyVerifiedFile(sourcePath: string, destinationPath: string): Promise<void> {
  const source = await open(sourcePath, "r");
  const destination = await open(destinationPath, "wx", 0o600);
  try {
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      await writeAll(destination, buffer.subarray(0, bytesRead));
    }
    await destination.sync();
  } finally {
    await Promise.allSettled([source.close(), destination.close()]);
  }
}

async function assertVerifiedFile(path: string, byteSize: number, checksum: string): Promise<void> {
  const fileStats = await lstat(path);
  if (fileStats.isSymbolicLink() || !fileStats.isFile() || fileStats.size !== byteSize) {
    throw new Error("Pi snapshot size does not match the verified restore result");
  }
  if ((await sha256File(path)) !== checksum.toLowerCase()) {
    throw new Error("Pi snapshot checksum does not match the verified restore result");
  }
}

async function writeAll(file: Awaited<ReturnType<typeof open>>, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset);
    if (bytesWritten === 0) throw new Error("Failed to copy Pi session bytes");
    offset += bytesWritten;
  }
}

function piPlan(
  context: RehydrationContext,
  workingDirectory: string,
  input: Omit<RehydrationPlan, "harness" | "sessionId" | "externalId" | "sessionObjectId" | "snapshotChecksum" | "snapshotByteSize" | "workingDirectory">,
): RehydrationPlan {
  return {
    harness: "pi",
    sessionId: context.sessionId,
    externalId: context.externalId,
    sessionObjectId: context.sessionObjectId,
    snapshotChecksum: context.snapshotChecksum,
    snapshotByteSize: context.byteSize,
    workingDirectory,
    ...input,
  };
}

function requireWorkingDirectory(context: RehydrationContext): string {
  if (!context.workingDirectory) {
    throw new Error("Pi rehydration requires the archived session working directory");
  }
  return resolve(context.workingDirectory);
}

function piProjectDirectoryName(workingDirectory: string): string {
  return `--${workingDirectory.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function piSessionFilename(context: RehydrationContext): string {
  const original = context.originalFilename;
  const idSuffix = `_${encodeURIComponent(context.externalId)}.jsonl`;
  if (original && original === basenameOnly(original) && original.endsWith(idSuffix)) return original;
  return `rehydrated_${encodeURIComponent(context.externalId)}.jsonl`;
}

function basenameOnly(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separator < 0 ? path : path.slice(separator + 1);
}

async function validateSessionRoot(root: string, isExplicit: boolean): Promise<string> {
  if (isExplicit && !isAbsolute(root)) {
    throw new Error("--session-root must be an absolute path");
  }
  const rootStats = await lstat(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error("Pi session root must be an existing non-symlink directory");
  }
  await access(root, constants.W_OK);
  return realpath(root);
}

async function assertSafeTargetDirectory(root: string, targetDirectory: string): Promise<void> {
  const pathFromRoot = relative(root, targetDirectory);
  if (pathFromRoot.startsWith("..") || pathFromRoot === "" || pathFromRoot.includes(`..${sep}`)) {
    throw new Error("Pi target directory escapes the selected session root");
  }

  let current = root;
  for (const segment of pathFromRoot.split(sep)) {
    current = join(current, segment);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) throw new Error(`Pi target path contains a symlink: ${current}`);
      if (!entry.isDirectory()) throw new Error(`Pi target parent is not a directory: ${current}`);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
  }
}

async function findSessionCollisions(
  root: string,
  targetPath: string,
  context: RehydrationContext,
): Promise<{ identicalPaths: string[]; conflictingPaths: string[]; hasConflict: boolean }> {
  const candidatePaths = new Set<string>([targetPath]);
  for await (const path of walkJsonlFiles(root)) {
    const header = await tryReadPiHeader(path);
    if (header?.id === context.externalId) candidatePaths.add(path);
  }

  const identicalPaths: string[] = [];
  const conflictingPaths: string[] = [];
  for (const path of [...candidatePaths].sort()) {
    const comparison = await compareSnapshot(path, context);
    if (comparison === "missing") continue;
    if (comparison === "identical") identicalPaths.push(path);
    else conflictingPaths.push(path);
  }
  return {
    identicalPaths,
    conflictingPaths,
    hasConflict: conflictingPaths.length > 0,
  };
}

async function* walkJsonlFiles(root: string): AsyncIterable<string> {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        yield path;
      }
    }
  }
}

async function compareSnapshot(
  path: string,
  context: RehydrationContext,
): Promise<"missing" | "identical" | "different"> {
  let fileStats;
  try {
    fileStats = await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return "missing";
    throw error;
  }
  if (fileStats.isSymbolicLink() || !fileStats.isFile() || fileStats.size !== context.byteSize) {
    return "different";
  }
  return (await sha256File(path)) === context.snapshotChecksum.toLowerCase()
    ? "identical"
    : "different";
}

async function tryReadPiHeader(path: string): Promise<{ id: string } | undefined> {
  try {
    const line = await readCompleteFirstLine(path, MAX_HEADER_BYTES);
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed) || parsed.type !== "session" || typeof parsed.id !== "string" || !parsed.id) {
      return undefined;
    }
    return { id: parsed.id };
  } catch {
    return undefined;
  }
}

async function readPiV3Header(path: string, maximumBytes: number): Promise<PiSessionHeader> {
  const line = await readCompleteFirstLine(path, maximumBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("Pi snapshot has a malformed JSONL header");
  }
  if (
    !isRecord(parsed) ||
    parsed.type !== "session" ||
    parsed.version !== 3 ||
    typeof parsed.id !== "string" ||
    !parsed.id ||
    typeof parsed.cwd !== "string" ||
    !parsed.cwd ||
    !isAbsolute(parsed.cwd)
  ) {
    throw new Error("Pi snapshot does not have a supported v3 session header");
  }
  return { type: "session", version: 3, id: parsed.id, cwd: parsed.cwd };
}

async function readCompleteFirstLine(path: string, maximumBytes: number): Promise<string> {
  const file = await open(path, "r");
  try {
    const chunks: Buffer[] = [];
    let bytesReadTotal = 0;
    const buffer = Buffer.allocUnsafe(Math.min(READ_BUFFER_BYTES, maximumBytes));
    while (bytesReadTotal < maximumBytes) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, maximumBytes - bytesReadTotal),
        bytesReadTotal,
      );
      if (bytesRead === 0) break;
      const chunk = Buffer.from(buffer.subarray(0, bytesRead));
      const newline = chunk.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(chunk.subarray(0, newline));
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.push(chunk);
      bytesReadTotal += bytesRead;
    }
  } finally {
    await file.close();
  }
  throw new Error("Pi snapshot does not begin with a complete JSONL header");
}

async function assertCompleteJsonlBoundary(path: string, byteSize: number): Promise<void> {
  if (byteSize === 0) throw new Error("Pi snapshot is empty");
  const file = await open(path, "r");
  try {
    const byte = Buffer.allocUnsafe(1);
    await file.read(byte, 0, 1, byteSize - 1);
    if (byte[0] !== 0x0a) throw new Error("Pi snapshot ends with a partial JSONL entry");
  } finally {
    await file.close();
  }
}

async function sha256File(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    let position = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) return hash.digest("hex");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await file.close();
  }
}

function collisionWarnings(collisions: { conflictingPaths: string[] }): string[] {
  return collisions.conflictingPaths.map((path) => `Conflicting Pi session exists at ${path}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
