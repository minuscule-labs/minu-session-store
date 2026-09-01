import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type SessionStoreConfig = {
  version: 1;
  ownerId: string;
  deviceId: string;
  deviceName?: string;
  catalog: {
    url: string;
    authTokenEnvironmentVariable?: string;
  };
  s3: {
    bucket: string;
    region: string;
    profile?: string;
    endpoint?: string;
    forcePathStyle?: boolean;
    serverSideEncryption?: "AES256" | "aws:kms" | "aws:kms:dsse";
    kmsKeyId?: string;
  };
  pi: {
    sessionRoots?: string[];
  };
  daemon: {
    scanIntervalSeconds: number;
    quietPeriodSeconds?: number;
    maximumWaitSeconds?: number;
  };
  retention?: {
    enabled: boolean;
    keepAllForDays: number;
    keepLatestVersions: number;
    keepFirstVersion: boolean;
    gracePeriodHours: number;
  };
};

export type CreateConfigInput = {
  bucket: string;
  region: string;
  profile?: string;
  catalogUrl?: string;
  ownerId?: string;
  deviceName?: string;
  sessionRoots?: string[];
  scanIntervalSeconds?: number;
};

export function defaultConfigPath(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.MINU_SESSION_STORE_CONFIG) return resolveTilde(environment.MINU_SESSION_STORE_CONFIG);
  const configHome = environment.XDG_CONFIG_HOME
    ? resolveTilde(environment.XDG_CONFIG_HOME)
    : join(homedir(), ".config");
  return join(configHome, "minu", "session-store", "config.json");
}

export function defaultCatalogPath(environment: NodeJS.ProcessEnv = process.env): string {
  const dataHome = environment.XDG_DATA_HOME
    ? resolveTilde(environment.XDG_DATA_HOME)
    : join(homedir(), ".local", "share");
  return join(dataHome, "minu", "session-store", "catalog.db");
}

export function createConfig(input: CreateConfigInput): SessionStoreConfig {
  if (!input.bucket.trim()) throw new Error("S3 bucket is required");
  if (!input.region.trim()) throw new Error("S3 region is required");
  const scanIntervalSeconds = input.scanIntervalSeconds ?? 60;
  if (!Number.isInteger(scanIntervalSeconds) || scanIntervalSeconds < 1) {
    throw new Error("Scan interval must be a positive integer number of seconds");
  }

  return {
    version: 1,
    ownerId: input.ownerId ?? "local",
    deviceId: randomUUID(),
    ...(input.deviceName === undefined ? {} : { deviceName: input.deviceName }),
    catalog: {
      url: input.catalogUrl ?? `file:${defaultCatalogPath()}`,
      ...(input.catalogUrl?.startsWith("libsql:")
        ? { authTokenEnvironmentVariable: "MINU_LIBSQL_AUTH_TOKEN" }
        : {}),
    },
    s3: {
      bucket: input.bucket,
      region: input.region,
      ...(input.profile === undefined ? {} : { profile: input.profile }),
      serverSideEncryption: "AES256",
    },
    pi: {
      ...(input.sessionRoots?.length ? { sessionRoots: input.sessionRoots.map(resolveTilde) } : {}),
    },
    daemon: {
      scanIntervalSeconds,
      quietPeriodSeconds: 120,
      maximumWaitSeconds: 1800,
    },
    retention: {
      enabled: false,
      keepAllForDays: 7,
      keepLatestVersions: 10,
      keepFirstVersion: true,
      gracePeriodHours: 24,
    },
  };
}

export async function writeConfig(
  config: SessionStoreConfig,
  path = defaultConfigPath(),
): Promise<void> {
  validateConfig(config);
  const resolvedPath = resolveTilde(path);
  await mkdir(dirname(resolvedPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(resolvedPath), 0o700);
  await writeFile(resolvedPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(resolvedPath, 0o600);
}

export async function loadConfig(path = defaultConfigPath()): Promise<SessionStoreConfig> {
  const resolvedPath = resolveTilde(path);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(resolvedPath, "utf8"));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new Error(`Session store is not configured. Create ${resolvedPath} first.`);
    }
    throw error;
  }
  validateConfig(value);
  return value;
}

export function catalogAuthToken(
  config: SessionStoreConfig,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const variable = config.catalog.authTokenEnvironmentVariable;
  if (!variable) return undefined;
  const value = environment[variable];
  if (!value) throw new Error(`Catalog authentication requires ${variable}`);
  return value;
}

function validateConfig(value: unknown): asserts value is SessionStoreConfig {
  if (!isRecord(value) || value.version !== 1) throw new Error("Unsupported session-store config version");
  if (!isNonemptyString(value.ownerId)) throw new Error("Config ownerId is required");
  if (!isNonemptyString(value.deviceId)) throw new Error("Config deviceId is required");

  const catalog = value.catalog;
  if (!isRecord(catalog) || !isNonemptyString(catalog.url)) {
    throw new Error("Config catalog.url is required");
  }
  if (
    catalog.authTokenEnvironmentVariable !== undefined &&
    !isNonemptyString(catalog.authTokenEnvironmentVariable)
  ) {
    throw new Error("Config catalog.authTokenEnvironmentVariable must be a non-empty string");
  }

  const s3 = value.s3;
  if (!isRecord(s3) || !isNonemptyString(s3.bucket)) throw new Error("Config s3.bucket is required");
  if (!isNonemptyString(s3.region)) throw new Error("Config s3.region is required");
  for (const field of ["profile", "endpoint", "kmsKeyId"] as const) {
    if (s3[field] !== undefined && !isNonemptyString(s3[field])) {
      throw new Error(`Config s3.${field} must be a non-empty string`);
    }
  }
  if (
    s3.serverSideEncryption !== undefined &&
    !["AES256", "aws:kms", "aws:kms:dsse"].includes(String(s3.serverSideEncryption))
  ) {
    throw new Error("Config s3.serverSideEncryption is unsupported");
  }
  if (s3.forcePathStyle !== undefined && typeof s3.forcePathStyle !== "boolean") {
    throw new Error("Config s3.forcePathStyle must be boolean");
  }

  const pi = value.pi;
  if (!isRecord(pi)) throw new Error("Config pi is required");
  if (
    pi.sessionRoots !== undefined &&
    (!Array.isArray(pi.sessionRoots) || !pi.sessionRoots.every(isNonemptyString))
  ) {
    throw new Error("Config pi.sessionRoots must contain non-empty paths");
  }

  const daemon = value.daemon;
  if (
    !isRecord(daemon) ||
    !Number.isInteger(daemon.scanIntervalSeconds) ||
    Number(daemon.scanIntervalSeconds) < 1
  ) {
    throw new Error("Config daemon.scanIntervalSeconds must be a positive integer");
  }
  for (const field of ["quietPeriodSeconds", "maximumWaitSeconds"] as const) {
    if (daemon[field] !== undefined && (!Number.isInteger(daemon[field]) || Number(daemon[field]) < 1)) {
      throw new Error(`Config daemon.${field} must be a positive integer`);
    }
  }
  if (
    daemon.quietPeriodSeconds !== undefined &&
    daemon.maximumWaitSeconds !== undefined &&
    Number(daemon.maximumWaitSeconds) < Number(daemon.quietPeriodSeconds)
  ) {
    throw new Error("Config daemon.maximumWaitSeconds must be at least quietPeriodSeconds");
  }

  const retention = value.retention;
  if (retention !== undefined) {
    if (!isRecord(retention) || typeof retention.enabled !== "boolean") {
      throw new Error("Config retention.enabled must be boolean");
    }
    for (const field of ["keepAllForDays", "keepLatestVersions", "gracePeriodHours"] as const) {
      if (!Number.isInteger(retention[field]) || Number(retention[field]) < 1) {
        throw new Error(`Config retention.${field} must be a positive integer`);
      }
    }
    if (typeof retention.keepFirstVersion !== "boolean") {
      throw new Error("Config retention.keepFirstVersion must be boolean");
    }
  }
}

function resolveTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
