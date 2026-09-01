import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  CapturedSession,
  DiscoverSessionsInput,
  DiscoveredSession,
  DiscoveryIssue,
  SessionSourceAdapter,
} from "../../core/contracts.js";

const MAX_HEADER_BYTES = 1024 * 1024;
const DEFAULT_MAX_SESSION_BYTES = 256 * 1024 * 1024;
const COPY_BUFFER_BYTES = 64 * 1024;

export type PiSessionSourceOptions = {
  sessionRoots?: string[];
  agentDirectory?: string;
  temporaryDirectory?: string;
  maxSessionBytes?: number;
  captureAttempts?: number;
  onDiscoveryIssue?: (issue: DiscoveryIssue) => void;
  now?: () => Date;
};

type PiSessionHeader = {
  type: "session";
  id: string;
  version?: number;
  timestamp?: string;
  cwd?: string;
};

type SnapshotMetadata = {
  header: PiSessionHeader;
  title?: string;
};

class RetryableCaptureError extends Error {}

export class PiSessionSource implements SessionSourceAdapter {
  readonly harness = "pi";
  readonly adapterVersion = "0.1.0";

  private readonly options: Required<
    Pick<PiSessionSourceOptions, "maxSessionBytes" | "captureAttempts" | "now">
  > &
    Omit<PiSessionSourceOptions, "maxSessionBytes" | "captureAttempts" | "now">;

  constructor(options: PiSessionSourceOptions = {}) {
    this.options = {
      ...options,
      maxSessionBytes: options.maxSessionBytes ?? DEFAULT_MAX_SESSION_BYTES,
      captureAttempts: options.captureAttempts ?? 3,
      now: options.now ?? (() => new Date()),
    };
  }

  async *discover(input: DiscoverSessionsInput = {}): AsyncIterable<DiscoveredSession> {
    const roots = await this.resolveSessionRoots();
    const candidatesByPath = new Map<string, DiscoveredSession>();

    for (const root of roots) {
      for await (const filePath of this.walkSessionFiles(root)) {
        try {
          const fileStats = await lstat(filePath);
          if (!fileStats.isFile() || fileStats.isSymbolicLink()) continue;
          if (input.modifiedSince && fileStats.mtime < input.modifiedSince) continue;

          const header = await readPiSessionHeader(filePath);
          if (!header) continue;
          if (input.workingDirectory && header.cwd !== input.workingDirectory) continue;

          candidatesByPath.set(filePath, {
            path: filePath,
            externalId: header.id,
            ...(header.version === undefined ? {} : { formatVersion: String(header.version) }),
            modifiedAt: fileStats.mtime,
            byteSize: fileStats.size,
          });
        } catch (error) {
          this.reportIssue(filePath, error);
        }
      }
    }

    const candidates = [...candidatesByPath.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    );
    yield* candidates;
  }

  async capture(session: DiscoveredSession): Promise<CapturedSession> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.options.captureAttempts; attempt++) {
      try {
        return await this.captureOnce(session);
      } catch (error) {
        lastError = error;
        if (!(error instanceof RetryableCaptureError) || attempt === this.options.captureAttempts) {
          throw error;
        }
        await new Promise((resolveRetry) => setTimeout(resolveRetry, 10));
      }
    }

    throw lastError;
  }

  private async captureOnce(session: DiscoveredSession): Promise<CapturedSession> {
    const sourcePath = resolve(session.path);
    const sourceLstat = await lstat(sourcePath);
    if (!sourceLstat.isFile() || sourceLstat.isSymbolicLink()) {
      throw new Error(`Pi session is not a regular file: ${sourcePath}`);
    }

    const tempRoot = this.options.temporaryDirectory ?? tmpdir();
    const captureDirectory = await mkdtemp(join(tempRoot, "minu-session-"));
    await chmod(captureDirectory, 0o700);
    const snapshotPath = join(captureDirectory, basename(sourcePath));

    try {
      const copied = await copyStablePrefix(sourcePath, snapshotPath, this.options.maxSessionBytes);
      const metadata = await inspectSnapshot(snapshotPath);
      if (metadata.header.id !== session.externalId) {
        throw new RetryableCaptureError(`Pi session identity changed during capture: ${sourcePath}`);
      }

      const observedAt = this.options.now().toISOString();
      const header = metadata.header;

      return {
        externalId: header.id,
        harness: this.harness,
        ...(header.version === undefined ? {} : { formatVersion: String(header.version) }),
        adapterVersion: this.adapterVersion,
        ...(metadata.title === undefined ? {} : { title: metadata.title }),
        lifecycleStatus: "unknown",
        ...(isIsoDate(header.timestamp) ? { startedAt: header.timestamp } : {}),
        ...(header.cwd ? { workingDirectory: header.cwd } : {}),
        observedAt,
        snapshot: {
          path: snapshotPath,
          checksumAlgorithm: "sha256",
          checksum: copied.checksum,
          byteSize: copied.byteSize,
          contentType: "application/x-ndjson",
          originalFilename: basename(sourcePath),
          async dispose() {
            await rm(captureDirectory, { recursive: true, force: true });
          },
        },
      };
    } catch (error) {
      await rm(captureDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  private async resolveSessionRoots(): Promise<string[]> {
    if (this.options.sessionRoots?.length) {
      return uniqueResolvedPaths(this.options.sessionRoots);
    }

    const agentDirectory = resolveTilde(
      this.options.agentDirectory ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
    );
    const roots = new Set<string>();
    roots.add(resolve(agentDirectory, "sessions"));

    const environmentRoot = process.env.PI_CODING_AGENT_SESSION_DIR;
    if (environmentRoot) roots.add(resolveTilde(environmentRoot));

    const configuredRoot = await readConfiguredSessionRoot(join(agentDirectory, "settings.json"));
    if (configuredRoot) roots.add(configuredRoot);

    return [...roots].sort();
  }

  private async *walkSessionFiles(root: string): AsyncIterable<string> {
    const resolvedRoot = resolve(root);
    let rootRealPath: string;

    try {
      rootRealPath = await realpath(resolvedRoot);
    } catch (error) {
      this.reportIssue(resolvedRoot, error);
      return;
    }

    const pending = [rootRealPath];
    while (pending.length > 0) {
      const directory = pending.pop();
      if (!directory) continue;

      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        this.reportIssue(directory, error);
        continue;
      }

      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const entryPath = join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (isWithinRoot(rootRealPath, entryPath)) pending.push(entryPath);
          continue;
        }
        if (entry.isFile() && entry.name.endsWith(".jsonl")) yield entryPath;
      }
    }
  }

  private reportIssue(path: string, error: unknown): void {
    this.options.onDiscoveryIssue?.({ path, message: errorMessage(error) });
  }
}

async function copyStablePrefix(
  sourcePath: string,
  snapshotPath: string,
  maxSessionBytes: number,
): Promise<{ checksum: string; byteSize: number }> {
  const source = await open(sourcePath, "r");
  const destination = await open(snapshotPath, "wx", 0o600);

  try {
    const initial = await source.stat({ bigint: true });
    if (!initial.isFile()) throw new Error(`Pi session is not a regular file: ${sourcePath}`);
    if (initial.size <= 0n) throw new RetryableCaptureError(`Pi session is empty: ${sourcePath}`);
    if (initial.size > BigInt(maxSessionBytes)) {
      throw new Error(`Pi session exceeds ${maxSessionBytes} bytes: ${sourcePath}`);
    }

    const byteSize = Number(initial.size);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let position = 0;
    let finalByte: number | undefined;

    while (position < byteSize) {
      const requested = Math.min(buffer.length, byteSize - position);
      const { bytesRead } = await source.read(buffer, 0, requested, position);
      if (bytesRead === 0) {
        throw new RetryableCaptureError(`Pi session changed while being captured: ${sourcePath}`);
      }

      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      await writeAll(destination, chunk);
      finalByte = chunk.at(-1);
      position += bytesRead;
    }

    await destination.sync();
    const after = await source.stat({ bigint: true });
    const currentPathStats = await stat(sourcePath, { bigint: true });
    if (after.size < initial.size || currentPathStats.dev !== initial.dev || currentPathStats.ino !== initial.ino) {
      throw new RetryableCaptureError(`Pi session was replaced or truncated during capture: ${sourcePath}`);
    }
    if (finalByte !== 0x0a) {
      throw new RetryableCaptureError(`Pi session ended with a partial JSONL entry: ${sourcePath}`);
    }

    return { checksum: hash.digest("hex"), byteSize };
  } finally {
    await Promise.allSettled([source.close(), destination.close()]);
  }
}

async function writeAll(file: Awaited<ReturnType<typeof open>>, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset);
    if (bytesWritten === 0) throw new Error("Failed to write captured Pi session snapshot");
    offset += bytesWritten;
  }
}

async function inspectSnapshot(snapshotPath: string): Promise<SnapshotMetadata> {
  let header: PiSessionHeader | undefined;
  let title: string | undefined;

  for await (const line of readBoundedMetadataLines(snapshotPath)) {
    if (!line.text?.trim()) {
      if (!header && line.oversized) {
        throw new Error(`Pi session header exceeds ${MAX_HEADER_BYTES} bytes: ${snapshotPath}`);
      }
      continue;
    }

    if (!header) {
      let entry: unknown;
      try {
        entry = JSON.parse(line.text);
      } catch {
        throw new RetryableCaptureError(`Malformed Pi session header: ${snapshotPath}`);
      }
      const parsedHeader = parsePiSessionHeader(entry);
      if (!parsedHeader) throw new Error(`Invalid Pi session header: ${snapshotPath}`);
      header = parsedHeader;
      continue;
    }

    if (line.oversized || !/"type"\s*:\s*"session_info"/.test(line.text.slice(0, 4096))) {
      continue;
    }
    try {
      const entry: unknown = JSON.parse(line.text);
      if (isRecord(entry) && entry.type === "session_info") {
        title = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : undefined;
      }
    } catch {
      throw new RetryableCaptureError(`Malformed Pi session metadata: ${snapshotPath}:${line.lineNumber}`);
    }
  }

  if (!header) throw new Error(`Pi session has no header: ${snapshotPath}`);
  return { header, ...(title === undefined ? {} : { title }) };
}

async function* readBoundedMetadataLines(
  snapshotPath: string,
): AsyncIterable<{ lineNumber: number; text?: string; oversized: boolean }> {
  const stream = createReadStream(snapshotPath);
  let parts: Buffer[] = [];
  let bufferedBytes = 0;
  let oversized = false;
  let lineNumber = 0;

  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.length : newline;
      const segment = chunk.subarray(offset, end);
      if (!oversized) {
        if (bufferedBytes + segment.length <= MAX_HEADER_BYTES) {
          parts.push(Buffer.from(segment));
          bufferedBytes += segment.length;
        } else {
          parts = [];
          bufferedBytes = 0;
          oversized = true;
        }
      }
      if (newline < 0) break;

      lineNumber += 1;
      yield {
        lineNumber,
        ...(oversized ? {} : { text: Buffer.concat(parts, bufferedBytes).toString("utf8") }),
        oversized,
      };
      parts = [];
      bufferedBytes = 0;
      oversized = false;
      offset = newline + 1;
    }
  }

  if (parts.length > 0 || oversized) {
    lineNumber += 1;
    yield {
      lineNumber,
      ...(oversized ? {} : { text: Buffer.concat(parts, bufferedBytes).toString("utf8") }),
      oversized,
    };
  }
}

async function readPiSessionHeader(filePath: string): Promise<PiSessionHeader | null> {
  const file = await open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(Math.min(4096, MAX_HEADER_BYTES));
    const chunks: Buffer[] = [];
    let bytesReadTotal = 0;

    while (bytesReadTotal < MAX_HEADER_BYTES) {
      const requested = Math.min(buffer.length, MAX_HEADER_BYTES - bytesReadTotal);
      const { bytesRead } = await file.read(buffer, 0, requested, bytesReadTotal);
      if (bytesRead === 0) break;

      const chunk = Buffer.from(buffer.subarray(0, bytesRead));
      const newline = chunk.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(chunk.subarray(0, newline));
        break;
      }

      chunks.push(chunk);
      bytesReadTotal += bytesRead;
    }

    const line = Buffer.concat(chunks).toString("utf8").trim();
    if (!line) return null;
    return parsePiSessionHeader(JSON.parse(line));
  } catch {
    return null;
  } finally {
    await file.close();
  }
}

function parsePiSessionHeader(value: unknown): PiSessionHeader | null {
  if (!isRecord(value) || value.type !== "session" || typeof value.id !== "string" || !value.id) {
    return null;
  }

  return {
    type: "session",
    id: value.id,
    ...(typeof value.version === "number" ? { version: value.version } : {}),
    ...(typeof value.timestamp === "string" ? { timestamp: value.timestamp } : {}),
    ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
  };
}

async function readConfiguredSessionRoot(settingsPath: string): Promise<string | undefined> {
  try {
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
    if (!isRecord(settings) || typeof settings.sessionDir !== "string" || !settings.sessionDir.trim()) {
      return undefined;
    }
    return resolve(dirname(settingsPath), resolveTilde(settings.sessionDir));
  } catch {
    return undefined;
  }
}

function uniqueResolvedPaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolveTilde(path)))].sort();
}

function resolveTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(path);
}

function isWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isIsoDate(value: string | undefined): value is string {
  return value !== undefined && !Number.isNaN(Date.parse(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
