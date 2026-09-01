import { chmod, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import type { StorageVersionReconciliationReport } from "../operations/storage-reconciler.js";
import type { DaemonScanSummary } from "./session-daemon.js";

const PROTOCOL_VERSION = 1;
const MAX_REQUEST_BYTES = 64 * 1024;

export type DaemonControlRequest =
  | {
      version: typeof PROTOCOL_VERSION;
      command: "sync";
      force?: boolean;
    }
  | {
      version: typeof PROTOCOL_VERSION;
      command: "reconcile-storage-version-ids";
      limit?: number;
    };

export type DaemonControlResponse =
  | { version: typeof PROTOCOL_VERSION; ok: true; summary: DaemonScanSummary }
  | {
      version: typeof PROTOCOL_VERSION;
      ok: true;
      reconciliation: StorageVersionReconciliationReport;
    }
  | { version: typeof PROTOCOL_VERSION; ok: false; error: string };

export function defaultControlSocketPath(environment: NodeJS.ProcessEnv = process.env): string {
  const stateHome = environment.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(stateHome, "minu", "session-store", "daemon.sock");
}

export class DaemonControlServer {
  private server: Server | undefined;

  constructor(
    private readonly socketPath: string,
    private readonly sync: (force: boolean) => Promise<DaemonScanSummary>,
    private readonly reconcileStorageVersionIds?: (
      limit: number | undefined,
    ) => Promise<StorageVersionReconciliationReport>,
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    if (await isDaemonControlAvailable(this.socketPath)) {
      throw new Error(`Another session-store daemon is already listening at ${this.socketPath}`);
    }
    await rm(this.socketPath, { force: true });

    const server = createServer((socket) => this.handleConnection(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.socketPath);
    });
    await chmod(this.socketPath, 0o600);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await rm(this.socketPath, { force: true });
  }

  private handleConnection(socket: Socket): void {
    socket.setEncoding("utf8");
    socket.setTimeout(30_000, () => socket.destroy(new Error("Control request timed out")));
    let input = "";
    let handled = false;

    socket.on("data", (chunk: string) => {
      if (handled) return;
      input += chunk;
      if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) {
        handled = true;
        this.writeResponse(socket, { version: PROTOCOL_VERSION, ok: false, error: "Request too large" });
        return;
      }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      void this.processRequest(socket, input.slice(0, newline));
    });
    socket.on("error", () => {});
  }

  private async processRequest(socket: Socket, input: string): Promise<void> {
    try {
      const request = parseRequest(input);
      if (request.command === "sync") {
        const summary = await this.sync(request.force ?? false);
        this.writeResponse(socket, { version: PROTOCOL_VERSION, ok: true, summary });
        return;
      }
      if (!this.reconcileStorageVersionIds) {
        throw new Error("Storage reconciliation is unavailable");
      }
      const reconciliation = await this.reconcileStorageVersionIds(request.limit);
      this.writeResponse(socket, { version: PROTOCOL_VERSION, ok: true, reconciliation });
    } catch (error) {
      this.writeResponse(socket, {
        version: PROTOCOL_VERSION,
        ok: false,
        error: error instanceof Error ? error.message.slice(0, 1000) : "Control request failed",
      });
    }
  }

  private writeResponse(socket: Socket, response: DaemonControlResponse): void {
    socket.end(`${JSON.stringify(response)}\n`);
  }
}

export async function requestDaemonSync(input: {
  socketPath?: string;
  force?: boolean;
  timeoutMs?: number;
} = {}): Promise<DaemonScanSummary> {
  const response = await sendRequest(
    input.socketPath ?? defaultControlSocketPath(),
    { version: PROTOCOL_VERSION, command: "sync", ...(input.force ? { force: true } : {}) },
    input.timeoutMs ?? 30 * 60_000,
  );
  if (!response.ok) throw new Error(response.error);
  if (!("summary" in response)) throw new Error("Invalid daemon sync response");
  return response.summary;
}

export async function requestStorageVersionReconciliation(input: {
  socketPath?: string;
  limit?: number;
  timeoutMs?: number;
} = {}): Promise<StorageVersionReconciliationReport> {
  const response = await sendRequest(
    input.socketPath ?? defaultControlSocketPath(),
    {
      version: PROTOCOL_VERSION,
      command: "reconcile-storage-version-ids",
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    },
    input.timeoutMs ?? 30 * 60_000,
  );
  if (!response.ok) throw new Error(response.error);
  if (!("reconciliation" in response)) {
    throw new Error("Invalid daemon storage reconciliation response");
  }
  return response.reconciliation;
}

async function sendRequest(
  socketPath: string,
  request: DaemonControlRequest,
  timeoutMs: number,
): Promise<DaemonControlResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = "";
    const timeout = setTimeout(() => socket.destroy(new Error("Daemon control request timed out")), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (Buffer.byteLength(response) > MAX_REQUEST_BYTES) {
        socket.destroy(new Error("Daemon control response was too large"));
      }
    });
    socket.on("end", () => {
      clearTimeout(timeout);
      try {
        const parsed: unknown = JSON.parse(response.trim());
        resolve(parseResponse(parsed));
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function parseRequest(input: string): DaemonControlRequest {
  const value: unknown = JSON.parse(input);
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION) {
    throw new Error("Invalid daemon control request");
  }
  if (value.command === "sync" && (value.force === undefined || typeof value.force === "boolean")) {
    return {
      version: PROTOCOL_VERSION,
      command: "sync",
      ...(value.force === undefined ? {} : { force: value.force }),
    };
  }
  if (
    value.command === "reconcile-storage-version-ids" &&
    (value.limit === undefined ||
      (typeof value.limit === "number" && Number.isInteger(value.limit) && value.limit > 0))
  ) {
    return {
      version: PROTOCOL_VERSION,
      command: "reconcile-storage-version-ids",
      ...(value.limit === undefined ? {} : { limit: value.limit }),
    };
  }
  throw new Error("Invalid daemon control request");
}

function parseResponse(value: unknown): DaemonControlResponse {
  if (!isRecord(value) || value.version !== PROTOCOL_VERSION || typeof value.ok !== "boolean") {
    throw new Error("Invalid daemon control response");
  }
  if (!value.ok) {
    if (typeof value.error !== "string") throw new Error("Invalid daemon control error response");
    return { version: PROTOCOL_VERSION, ok: false, error: value.error };
  }
  if (isRecord(value.summary)) {
    return { version: PROTOCOL_VERSION, ok: true, summary: value.summary as DaemonScanSummary };
  }
  if (isStorageVersionReconciliationReport(value.reconciliation)) {
    return { version: PROTOCOL_VERSION, ok: true, reconciliation: value.reconciliation };
  }
  throw new Error("Invalid daemon control success response");
}

export async function isDaemonControlAvailable(
  socketPath = defaultControlSocketPath(),
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function isStorageVersionReconciliationReport(
  value: unknown,
): value is StorageVersionReconciliationReport {
  return (
    isRecord(value) &&
    typeof value.checked === "number" &&
    typeof value.reconciled === "number" &&
    typeof value.skipped === "number" &&
    typeof value.failed === "number" &&
    Array.isArray(value.failures)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
