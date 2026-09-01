#!/usr/bin/env node

import { access } from "node:fs/promises";
import packageMetadata from "../package.json" with { type: "json" };
import { createInterface } from "node:readline/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { PiSessionSource } from "./adapters/pi/pi-session-source.js";
import {
  S3BucketProvisioner,
  type S3BucketProvisioningPlan,
} from "./adapters/s3/s3-bucket-provisioner.js";
import {
  SessionCatalog,
  type CatalogSessionDetails,
  type CatalogSessionSummary,
  type CatalogStorageLocation,
} from "./catalog/session-catalog.js";
import { localDatabasePath } from "./catalog/catalog-url.js";
import {
  catalogAuthToken,
  loadConfig,
  createConfig,
  defaultConfigPath,
  writeConfig,
  type SessionStoreConfig,
} from "./config/config.js";
import type { DiscoveredSession } from "./core/contracts.js";
import { RetentionService, type RetentionRunSummary } from "./core/retention-service.js";
import {
  DaemonControlServer,
  defaultControlSocketPath,
  isDaemonControlAvailable,
  requestDaemonSync,
  requestStorageVersionReconciliation,
} from "./daemon/control-socket.js";
import { LaunchdService, launchdServicePaths } from "./daemon/launchd-service.js";
import { maintainDaemonLogs } from "./daemon/log-maintenance.js";
import { SessionDaemon, type DaemonScanSummary } from "./daemon/session-daemon.js";
import { runDoctor } from "./operations/doctor.js";
import {
  reconcileStorageVersionIds,
  type StorageVersionReconciliationReport,
} from "./operations/storage-reconciler.js";
import {
  verifyStorageObjects,
  type StorageVerificationReport,
} from "./operations/storage-verifier.js";
import { createObjectStore, createRuntime } from "./runtime/create-runtime.js";

async function main(args: string[]): Promise<number> {
  const [command, ...commandArgs] = args;
  switch (command) {
    case "configure":
      return configureCommand(commandArgs);
    case "discover":
      return discoverCommand(commandArgs);
    case "sync":
      return syncCommand(commandArgs);
    case "storage":
      return storageCommand(commandArgs);
    case "sessions":
      return sessionsCommand(commandArgs);
    case "retention":
      return retentionCommand(commandArgs);
    case "reconcile":
      return reconcileCommand(commandArgs);
    case "catalog":
      return catalogCommand(commandArgs);
    case "doctor":
      return doctorCommand(commandArgs);
    case "daemon":
      return daemonCommand(commandArgs);
    case "--version":
    case "-v":
      process.stdout.write(`${packageMetadata.version}\n`);
      return 0;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printUsage();
      return 0;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function configureCommand(args: string[]): Promise<number> {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      bucket: { type: "string" },
      region: { type: "string" },
      profile: { type: "string" },
      catalog: { type: "string" },
      owner: { type: "string" },
      "device-name": { type: "string" },
      "session-root": { type: "string", multiple: true },
      interval: { type: "string" },
      config: { type: "string" },
    },
  });
  if (parsed.positionals[0] !== "pi") throw new Error("The first source must be: configure pi");
  if (!parsed.values.bucket) throw new Error("configure requires --bucket");
  if (!parsed.values.region) throw new Error("configure requires --region");

  const config = createConfig({
    bucket: parsed.values.bucket,
    region: parsed.values.region,
    ...(parsed.values.profile === undefined ? {} : { profile: parsed.values.profile }),
    ...(parsed.values.catalog === undefined ? {} : { catalogUrl: parsed.values.catalog }),
    ...(parsed.values.owner === undefined ? {} : { ownerId: parsed.values.owner }),
    ...(parsed.values["device-name"] === undefined
      ? {}
      : { deviceName: parsed.values["device-name"] }),
    ...(parsed.values["session-root"] === undefined
      ? {}
      : { sessionRoots: parsed.values["session-root"] }),
    ...(parsed.values.interval === undefined
      ? {}
      : { scanIntervalSeconds: positiveInteger(parsed.values.interval, "interval") }),
  });
  const configPath = parsed.values.config ?? defaultConfigPath();
  await writeConfig(config, configPath);
  process.stdout.write(`Configured Pi sessions at ${configPath}\n`);
  process.stdout.write(`AWS profile: ${config.s3.profile ?? "default provider chain"}\n`);
  return 0;
}

async function storageCommand(args: string[]): Promise<number> {
  const [adapterOrAction, ...remainingArgs] = args;
  if (adapterOrAction === "locate") return storageLocateCommand(remainingArgs);
  if (adapterOrAction === "verify") return storageVerifyCommand(remainingArgs);

  const [action, ...actionArgs] = remainingArgs;
  if (adapterOrAction !== "s3" || action !== "provision") {
    throw new Error("storage requires one of: storage locate, storage verify, storage s3 provision");
  }
  const parsed = parseArgs({
    args: actionArgs,
    options: {
      bucket: { type: "string" },
      region: { type: "string" },
      profile: { type: "string" },
      "kms-key-id": { type: "string" },
      yes: { type: "boolean", short: "y", default: false },
      json: { type: "boolean", default: false },
    },
  });
  if (!parsed.values.bucket) throw new Error("S3 provisioning requires --bucket");
  if (!parsed.values.region) throw new Error("S3 provisioning requires --region");

  const provisioner = new S3BucketProvisioner({
    bucket: parsed.values.bucket,
    region: parsed.values.region,
    ...(parsed.values.profile === undefined ? {} : { profile: parsed.values.profile }),
    ...(parsed.values["kms-key-id"] === undefined
      ? {}
      : { kmsKeyId: parsed.values["kms-key-id"] }),
  });
  const plan = await provisioner.plan();
  printProvisioningPlan(plan, parsed.values.json);

  if (!parsed.values.yes && !(await confirmProvisioning(plan.bucket))) {
    process.stdout.write("Provisioning cancelled; no changes were made.\n");
    return 0;
  }

  const result = await provisioner.provision(plan);
  if (parsed.values.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(
      `${result.created ? "Created" : "Updated"} and verified private S3 bucket ${result.bucket}\n`,
    );
  }
  return 0;
}

async function storageLocateCommand(args: string[]): Promise<number> {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      json: { type: "boolean", default: false },
      version: { type: "string" },
    },
  });
  const identifier = parsed.positionals[0];
  if (!identifier) throw new Error("storage locate requires a session ID or external ID");
  const config = await loadConfig(parsed.values.config);
  const databasePath = localDatabasePath(config.catalog.url);
  if (databasePath && !(await fileExists(databasePath))) {
    throw new Error(`Session catalog does not exist: ${databasePath}`);
  }
  const authToken = catalogAuthToken(config);
  const catalog = new SessionCatalog({
    url: config.catalog.url,
    ...(authToken === undefined ? {} : { authToken }),
  });
  try {
    const location = await catalog.locateSessionObject(
      config.ownerId,
      identifier,
      parsed.values.version === undefined
        ? undefined
        : positiveInteger(parsed.values.version, "version"),
    );
    if (!location) throw new Error(`Stored session object not found: ${identifier}`);
    printStorageLocation(config, location, parsed.values.json);
    return 0;
  } finally {
    catalog.close();
  }
}

async function storageVerifyCommand(args: string[]): Promise<number> {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      all: { type: "boolean", default: false },
      config: { type: "string" },
      json: { type: "boolean", default: false },
      sample: { type: "string" },
    },
  });
  if (parsed.positionals.length > 1) {
    throw new Error("storage verify accepts at most one session ID or external ID");
  }
  if (parsed.values.all && parsed.values.sample !== undefined) {
    throw new Error("storage verify accepts either --all or --sample, not both");
  }

  const identifier = parsed.positionals[0];
  const config = await loadConfig(parsed.values.config);
  const databasePath = localDatabasePath(config.catalog.url);
  if (databasePath && !(await fileExists(databasePath))) {
    throw new Error(`Session catalog does not exist: ${databasePath}`);
  }
  const authToken = catalogAuthToken(config);
  const catalog = new SessionCatalog({
    url: config.catalog.url,
    ...(authToken === undefined ? {} : { authToken }),
  });
  try {
    const requestedSample =
      parsed.values.sample === undefined
        ? undefined
        : positiveInteger(parsed.values.sample, "sample");
    const limit = identifier ? requestedSample : parsed.values.all ? undefined : requestedSample ?? 20;
    const targets = await catalog.listStorageObjectsForVerification({
      ownerId: config.ownerId,
      ...(identifier === undefined ? {} : { identifier }),
      ...(limit === undefined ? {} : { limit }),
    });
    if (identifier && targets.length === 0) {
      throw new Error(`Verifiable stored session objects not found: ${identifier}`);
    }
    const report = await verifyStorageObjects({
      targets,
      objectStore: createObjectStore(config),
    });
    printStorageVerificationReport(report, parsed.values.json);
    return report.failed === 0 && report.warnings === 0 ? 0 : 1;
  } finally {
    catalog.close();
  }
}

async function discoverCommand(args: string[]): Promise<number> {
  const parsed = parseArgs({
    args,
    options: {
      config: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const config = await loadConfig(parsed.values.config);
  const issues: Array<{ path: string; message: string }> = [];
  const source = new PiSessionSource({
    ...(config.pi.sessionRoots === undefined ? {} : { sessionRoots: config.pi.sessionRoots }),
    onDiscoveryIssue: (issue) => issues.push(issue),
  });
  const sessions = await collectSessions(source);

  if (parsed.values.json) {
    process.stdout.write(`${JSON.stringify({ sessions, issues }, null, 2)}\n`);
  } else {
    for (const session of sessions) {
      process.stdout.write(`${session.externalId}\t${session.byteSize}\t${session.path}\n`);
    }
    process.stdout.write(`Discovered ${sessions.length} Pi sessions\n`);
    for (const issue of issues) process.stderr.write(`Discovery warning: ${issue.path}: ${issue.message}\n`);
  }
  return 0;
}

async function syncCommand(args: string[]): Promise<number> {
  const parsed = parseArgs({
    args,
    options: {
      config: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      limit: { type: "string" },
    },
  });
  const config = await loadConfig(parsed.values.config);
  const limit = parsed.values.limit ? positiveInteger(parsed.values.limit, "limit") : undefined;
  if (parsed.values["dry-run"]) {
    return dryRunSync(config, limit, parsed.values.json);
  }

  if (limit !== undefined) throw new Error("--limit is only supported with --dry-run");
  try {
    const summary = await requestDaemonSync({ force: parsed.values.force });
    printDaemonSummary(summary, parsed.values.json);
    return summary.failed === 0 ? 0 : 1;
  } catch (error) {
    if (isMissingControlSocket(error)) {
      throw new Error("The session-store daemon is not running. Start it with: minu-sessions daemon start");
    }
    throw error;
  }
}

async function dryRunSync(
  config: SessionStoreConfig,
  limit: number | undefined,
  json: boolean,
): Promise<number> {
  const source = new PiSessionSource({
    ...(config.pi.sessionRoots === undefined ? {} : { sessionRoots: config.pi.sessionRoots }),
  });
  const localPath = localDatabasePath(config.catalog.url);
  const hasCatalog = localPath === undefined || (await fileExists(localPath));
  const authToken = hasCatalog ? catalogAuthToken(config) : undefined;
  const catalog = hasCatalog
    ? new SessionCatalog({
        url: config.catalog.url,
        ...(authToken === undefined ? {} : { authToken }),
      })
    : undefined;
  let sourceInstallationId: string | undefined;
  const results: Array<Record<string, unknown>> = [];
  let failures = 0;

  try {
    if (catalog) {
      try {
        sourceInstallationId = await catalog.findSourceInstallationId({
          ownerId: config.ownerId,
          harness: "pi",
          deviceId: config.deviceId,
        });
      } catch (error) {
        if (!isMissingCatalogSchema(error)) throw error;
      }
    }

    let processed = 0;
    for await (const session of source.discover()) {
      if (limit !== undefined && processed >= limit) break;
      processed += 1;

      try {
        const captured = await source.capture(session);
        try {
          const plan =
            catalog && sourceInstallationId
              ? await catalog.planSnapshot({
                  ownerId: config.ownerId,
                  sourceInstallationId,
                  captured,
                })
              : { status: "new_session" as const };
          results.push({ path: session.path, checksum: captured.snapshot.checksum, ...plan });
        } finally {
          await captured.snapshot.dispose();
        }
      } catch (error) {
        failures += 1;
        results.push({ path: session.path, status: "failed", error: errorMessage(error) });
      }
    }
  } finally {
    catalog?.close();
  }

  printSyncResults(results, json);
  return failures === 0 ? 0 : 1;
}

async function sessionsCommand(args: string[]): Promise<number> {
  const [action, ...actionArgs] = args;
  if (action !== "list" && action !== "show") {
    throw new Error("sessions requires one of: list, show");
  }
  const parsed = parseArgs({
    args: actionArgs,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      json: { type: "boolean", default: false },
      limit: { type: "string" },
      search: { type: "string" },
      harness: { type: "string" },
      device: { type: "string" },
      source: { type: "string" },
      versions: { type: "string" },
    },
  });
  const config = await loadConfig(parsed.values.config);
  const databasePath = localDatabasePath(config.catalog.url);
  if (databasePath && !(await fileExists(databasePath))) {
    throw new Error(`Session catalog does not exist: ${databasePath}`);
  }
  const authToken = catalogAuthToken(config);
  const catalog = new SessionCatalog({
    url: config.catalog.url,
    ...(authToken === undefined ? {} : { authToken }),
  });

  try {
    if (action === "list") {
      const sessions = await catalog.listSessions({
        ownerId: config.ownerId,
        ...(parsed.values.limit === undefined
          ? {}
          : { limit: positiveInteger(parsed.values.limit, "limit") }),
        ...(parsed.values.search === undefined ? {} : { search: parsed.values.search }),
        ...(parsed.values.harness === undefined ? {} : { harness: parsed.values.harness }),
        ...(parsed.values.device === undefined ? {} : { deviceId: parsed.values.device }),
        ...(parsed.values.source === undefined
          ? {}
          : { sourceInstallationId: parsed.values.source }),
      });
      printSessionList(sessions, parsed.values.json);
      return 0;
    }

    const identifier = parsed.positionals[0];
    if (!identifier) throw new Error("sessions show requires a session ID or external ID");
    const session = await catalog.getSession(
      config.ownerId,
      identifier,
      parsed.values.versions === undefined
        ? 20
        : positiveInteger(parsed.values.versions, "versions"),
    );
    if (!session) throw new Error(`Session not found: ${identifier}`);
    printSessionDetails(session, parsed.values.json);
    return 0;
  } finally {
    catalog.close();
  }
}

async function doctorCommand(args: string[]): Promise<number> {
  const parsed = parseArgs({
    args,
    options: {
      config: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const configPath = parsed.values.config ?? defaultConfigPath();
  const config = await loadConfig(configPath);
  const report = await runDoctor({ config, configPath });
  if (parsed.values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const check of report.checks) {
      const marker = check.status === "pass" ? "PASS" : check.status === "warning" ? "WARN" : "FAIL";
      process.stdout.write(`${marker}\t${check.id}\t${check.message}\n`);
    }
    process.stdout.write(report.healthy ? "Doctor completed successfully.\n" : "Doctor found blocking failures.\n");
  }
  return report.healthy ? 0 : 1;
}

async function catalogCommand(args: string[]): Promise<number> {
  const [action, ...actionArgs] = args;
  if (action !== "backup") throw new Error("catalog currently supports: catalog backup");
  const parsed = parseArgs({
    args: actionArgs,
    options: {
      config: { type: "string" },
      output: { type: "string", short: "o" },
    },
  });
  const config = await loadConfig(parsed.values.config);
  const databasePath = localDatabasePath(config.catalog.url);
  if (!databasePath) throw new Error("Catalog backup currently requires local SQLite");
  if (!(await fileExists(databasePath))) throw new Error(`Session catalog does not exist: ${databasePath}`);
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const output = resolve(
    parsed.values.output ?? join(dirname(databasePath), "backups", `catalog-${timestamp}.db`),
  );
  const catalog = new SessionCatalog({ url: config.catalog.url });
  try {
    const destination = await catalog.backup(output);
    process.stdout.write(`Catalog backup created: ${destination}\n`);
  } finally {
    catalog.close();
  }
  return 0;
}

async function reconcileCommand(args: string[]): Promise<number> {
  const [action, ...actionArgs] = args;
  if (action === "plan") return reconcilePlanCommand(actionArgs);
  if (action === "apply") return reconcileApplyCommand(actionArgs);
  throw new Error("reconcile requires one of: reconcile plan, reconcile apply");
}

async function reconcilePlanCommand(args: string[]): Promise<number> {
  const parsed = parseArgs({
    args,
    options: {
      all: { type: "boolean", default: false },
      config: { type: "string" },
      json: { type: "boolean", default: false },
      sample: { type: "string" },
    },
  });
  if (parsed.values.all && parsed.values.sample !== undefined) {
    throw new Error("reconcile plan accepts either --all or --sample, not both");
  }
  const config = await loadConfig(parsed.values.config);
  const databasePath = localDatabasePath(config.catalog.url);
  if (databasePath && !(await fileExists(databasePath))) {
    throw new Error(`Session catalog does not exist: ${databasePath}`);
  }
  const authToken = catalogAuthToken(config);
  const catalog = new SessionCatalog({
    url: config.catalog.url,
    ...(authToken === undefined ? {} : { authToken }),
  });
  try {
    const sample =
      parsed.values.sample === undefined
        ? undefined
        : positiveInteger(parsed.values.sample, "sample");
    const limit = parsed.values.all ? undefined : sample ?? 20;
    const targets = await catalog.listStorageObjectsForVerification({
      ownerId: config.ownerId,
      missingStorageVersionId: true,
      ...(limit === undefined ? {} : { limit }),
    });
    const verification = await verifyStorageObjects({
      targets,
      objectStore: createObjectStore(config),
    });
    const plan = {
      candidates: targets.length,
      ready: verification.warnings,
      failed: verification.failed,
      results: verification.results,
    };
    if (parsed.values.json) {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    } else {
      for (const result of verification.results) {
        const status = result.status === "warning" ? "READY" : "FAIL";
        process.stdout.write(
          `${status}\t${result.sessionId}\tv${result.version}\t${result.objectKey}` +
            `${result.error ? `\t${singleLine(result.error)}` : ""}\n`,
        );
      }
      process.stdout.write(
        `Reconciliation plan: ${plan.ready} ready, ${plan.failed} failed, ` +
          `${plan.candidates} checked.\n`,
      );
    }
    return plan.failed === 0 ? 0 : 1;
  } finally {
    catalog.close();
  }
}

async function reconcileApplyCommand(args: string[]): Promise<number> {
  const parsed = parseArgs({
    args,
    options: {
      all: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      limit: { type: "string" },
      yes: { type: "boolean", short: "y", default: false },
    },
  });
  if (!parsed.values.yes) throw new Error("reconcile apply requires the explicit --yes flag");
  if (parsed.values.all && parsed.values.limit !== undefined) {
    throw new Error("reconcile apply accepts either --all or --limit, not both");
  }
  const limit = parsed.values.all
    ? undefined
    : parsed.values.limit === undefined
      ? 100
      : positiveInteger(parsed.values.limit, "limit");
  try {
    const report = await requestStorageVersionReconciliation({
      ...(limit === undefined ? {} : { limit }),
    });
    printStorageVersionReconciliationReport(report, parsed.values.json);
    return report.failed === 0 ? 0 : 1;
  } catch (error) {
    if (isMissingControlSocket(error)) {
      throw new Error("The session-store daemon is not running. Start it before reconciliation.");
    }
    throw error;
  }
}

async function retentionCommand(args: string[]): Promise<number> {
  const [action, ...actionArgs] = args;
  if (action !== "plan") throw new Error("retention currently supports: retention plan");
  const parsed = parseArgs({
    args: actionArgs,
    options: {
      config: { type: "string" },
      json: { type: "boolean", default: false },
      "keep-days": { type: "string" },
      "keep-versions": { type: "string" },
    },
  });
  const config = await loadConfig(parsed.values.config);
  const databasePath = localDatabasePath(config.catalog.url);
  if (databasePath && !(await fileExists(databasePath))) {
    throw new Error(`Session catalog does not exist: ${databasePath}`);
  }
  const authToken = catalogAuthToken(config);
  const catalog = new SessionCatalog({
    url: config.catalog.url,
    ...(authToken === undefined ? {} : { authToken }),
  });
  const configured = config.retention ?? {
    enabled: false,
    keepAllForDays: 7,
    keepLatestVersions: 10,
    keepFirstVersion: true,
    gracePeriodHours: 24,
  };

  try {
    const policy = {
      keepAllForDays:
        parsed.values["keep-days"] === undefined
          ? configured.keepAllForDays
          : positiveInteger(parsed.values["keep-days"], "keep-days"),
      keepLatestVersions:
        parsed.values["keep-versions"] === undefined
          ? configured.keepLatestVersions
          : positiveInteger(parsed.values["keep-versions"], "keep-versions"),
      keepFirstVersion: configured.keepFirstVersion,
    };
    const plan = await catalog.planRetention(config.ownerId, policy);
    if (parsed.values.json) {
      process.stdout.write(
        `${JSON.stringify({ enabled: configured.enabled, gracePeriodHours: configured.gracePeriodHours, policy, ...plan }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(`Retention enabled: ${configured.enabled ? "yes" : "no"}\n`);
      process.stdout.write(
        `Policy: keep ${policy.keepLatestVersions} latest, all for ${policy.keepAllForDays} days, ` +
          `first=${policy.keepFirstVersion ? "yes" : "no"}\n`,
      );
      process.stdout.write(`Candidates: ${plan.candidates.length}\n`);
      process.stdout.write(`Estimated reclaimable: ${formatBytes(plan.reclaimableBytes)}\n`);
      if (plan.missingStorageVersionIds > 0) {
        process.stdout.write(
          `Blocked pending S3 VersionId reconciliation: ${plan.missingStorageVersionIds}\n`,
        );
      }
      for (const candidate of plan.candidates.slice(0, 50)) {
        process.stdout.write(
          `${candidate.sessionId}\tv${candidate.version}\t${formatBytes(candidate.byteSize)}\t` +
            `${candidate.verifiedAt}\n`,
        );
      }
      if (plan.candidates.length > 50) {
        process.stdout.write(`...and ${plan.candidates.length - 50} more\n`);
      }
    }
    return 0;
  } finally {
    catalog.close();
  }
}

async function daemonStatusCommand(
  config: SessionStoreConfig,
  configPath: string,
  compactJson: boolean,
): Promise<number> {
  const databasePath = localDatabasePath(config.catalog.url);
  if (databasePath && !(await fileExists(databasePath))) {
    throw new Error(`Session catalog does not exist: ${databasePath}`);
  }
  const authToken = catalogAuthToken(config);
  const catalog = new SessionCatalog({
    url: config.catalog.url,
    ...(authToken === undefined ? {} : { authToken }),
  });
  try {
    const [jobs, storage] = await Promise.all([
      catalog.getSyncJobSummary(),
      catalog.getStorageStatusSummary(),
    ]);
    const launchdRunning =
      process.platform === "darwin"
        ? await new LaunchdService({ configPath }).isRunning()
        : undefined;
    const controlSocketActive = await isDaemonControlAvailable();
    const status = {
      service: {
        ...(launchdRunning === undefined ? {} : { launchdRunning }),
        controlSocketActive,
      },
      jobs,
      storage,
      retentionEnabled: config.retention?.enabled ?? false,
    };
    process.stdout.write(`${JSON.stringify(status, null, compactJson ? 0 : 2)}\n`);
    return jobs.failed > 0 || !controlSocketActive ? 1 : 0;
  } finally {
    catalog.close();
  }
}

async function daemonCommand(args: string[]): Promise<number> {
  const [action, ...actionArgs] = args;
  const supportedActions = ["run", "once", "status", "install", "start", "stop", "uninstall"];
  if (!action || !supportedActions.includes(action)) {
    throw new Error(`daemon requires one of: ${supportedActions.join(", ")}`);
  }
  const parsed = parseArgs({
    args: actionArgs,
    options: {
      config: { type: "string" },
      json: { type: "boolean", default: false },
      interval: { type: "string" },
    },
  });
  const configPath = parsed.values.config ?? defaultConfigPath();
  const config = await loadConfig(configPath);
  if (["install", "start", "stop", "uninstall"].includes(action)) {
    const service = new LaunchdService({ configPath });
    if (action === "install") await service.install();
    if (action === "start") await service.start();
    if (action === "stop") await service.stop();
    if (action === "uninstall") await service.uninstall();
    process.stdout.write(`launchd service ${action} complete\n`);
    return 0;
  }
  if (action === "status") {
    return daemonStatusCommand(config, configPath, parsed.values.json);
  }
  if (action === "once") {
    try {
      const summary = await requestDaemonSync();
      printDaemonSummary(summary, parsed.values.json);
      return summary.failed === 0 ? 0 : 1;
    } catch (error) {
      if (!isMissingControlSocket(error)) throw error;
    }
  }

  const runtime = await createRuntime(config);

  try {
    const scanIntervalSeconds = parsed.values.interval
      ? positiveInteger(parsed.values.interval, "interval")
      : config.daemon.scanIntervalSeconds;
    const retention = config.retention;
    const retentionService = retention?.enabled
      ? new RetentionService({
          ownerId: config.ownerId,
          catalog: runtime.catalog,
          objectStore: runtime.objectStore,
          policy: {
            keepAllForDays: retention.keepAllForDays,
            keepLatestVersions: retention.keepLatestVersions,
            keepFirstVersion: retention.keepFirstVersion,
          },
          gracePeriodMs: retention.gracePeriodHours * 60 * 60 * 1000,
          onError: (error) =>
            process.stderr.write(`RETENTION_FAILED ${error.sessionObjectId}: ${error.message}\n`),
        })
      : undefined;
    let nextRetentionRunAt = 0;
    const daemon = new SessionDaemon({
      sourceInstallationId: runtime.sourceInstallationId,
      source: runtime.source,
      catalog: runtime.catalog,
      syncService: runtime.syncService,
      scanIntervalMs: scanIntervalSeconds * 1000,
      quietPeriodMs: (config.daemon.quietPeriodSeconds ?? 120) * 1000,
      maximumWaitMs: (config.daemon.maximumWaitSeconds ?? 1800) * 1000,
      onScanComplete: async (summary) => {
        printDaemonSummary(summary, parsed.values.json);
        if (retentionService && Date.now() >= nextRetentionRunAt) {
          const retentionSummary = await retentionService.run();
          printRetentionRunSummary(retentionSummary, parsed.values.json);
          nextRetentionRunAt = Date.now() + 24 * 60 * 60 * 1000;
        }
        if (process.platform === "darwin") {
          try {
            await maintainDaemonLogs(launchdServicePaths());
          } catch (error) {
            process.stderr.write(`LOG_MAINTENANCE_FAILED: ${errorMessage(error)}\n`);
          }
        }
      },
      onError: (error) => process.stderr.write(`${error.code}: ${error.message}\n`),
    });

    if (action === "once") {
      const summary = await daemon.scanOnce();
      return summary.failed === 0 ? 0 : 1;
    }

    const controlServer = new DaemonControlServer(
      defaultControlSocketPath(),
      (force) => daemon.scanOnce({ force }),
      (limit) =>
        daemon.runExclusive(() =>
          reconcileStorageVersionIds({
            ownerId: config.ownerId,
            catalog: runtime.catalog,
            objectStore: runtime.objectStore,
            ...(limit === undefined ? {} : { limit }),
          }),
        ),
    );
    await controlServer.start();
    const abortController = new AbortController();
    const stop = () => abortController.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await daemon.run(abortController.signal);
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      await controlServer.stop();
    }
    return 0;
  } finally {
    runtime.close();
  }
}

function printStorageVersionReconciliationReport(
  report: StorageVersionReconciliationReport,
  json: boolean,
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  for (const failure of report.failures) {
    process.stdout.write(
      `FAIL\t${failure.sessionId}\tv${failure.version}\t${failure.objectKey}\t` +
        `${singleLine(failure.error)}\n`,
    );
  }
  process.stdout.write(
    `Reconciliation applied: ${report.reconciled} recorded, ${report.skipped} skipped, ` +
      `${report.failed} failed, ${report.checked} checked.\n`,
  );
}

function printStorageVerificationReport(
  report: StorageVerificationReport,
  json: boolean,
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  for (const result of report.results) {
    const status =
      result.status === "passed" ? "PASS" : result.status === "warning" ? "WARN" : "FAIL";
    process.stdout.write(
      `${status}\t${result.harness}\t${result.sessionId}\tv${result.version}\t${result.objectKey}` +
        `${result.error ? `\t${singleLine(result.error)}` : ""}\n`,
    );
  }
  process.stdout.write(
    `Verified ${report.checked} objects: ${report.passed} passed, ` +
      `${report.warnings} warnings, ${report.failed} failed.\n`,
  );
}

function printStorageLocation(
  config: SessionStoreConfig,
  location: CatalogStorageLocation,
  json: boolean,
): void {
  const s3Uri = `s3://${config.s3.bucket}/${location.version.objectKey}`;
  const consoleUrl = new URL(
    `https://${config.s3.region}.console.aws.amazon.com/s3/object/${encodeURIComponent(config.s3.bucket)}`,
  );
  consoleUrl.searchParams.set("region", config.s3.region);
  consoleUrl.searchParams.set("prefix", location.version.objectKey);
  consoleUrl.searchParams.set("showversions", "true");
  if (location.version.storageVersionId) {
    consoleUrl.searchParams.set("versionId", location.version.storageVersionId);
  }
  const output = {
    ...location,
    bucket: config.s3.bucket,
    region: config.s3.region,
    s3Uri,
    consoleUrl: consoleUrl.href,
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }

  process.stdout.write(`Owner: ${location.ownerId}\n`);
  process.stdout.write(`Harness: ${location.harness}\n`);
  process.stdout.write(`Session: ${location.sessionId}\n`);
  process.stdout.write(`External ID: ${location.externalId}\n`);
  process.stdout.write(`Source installation: ${location.sourceInstallationId}\n`);
  process.stdout.write(`Version: ${location.version.version}\n`);
  process.stdout.write(`Storage status: ${location.version.storageStatus}\n`);
  process.stdout.write(`S3 VersionId: ${location.version.storageVersionId ?? "-"}\n`);
  process.stdout.write(`SHA-256: ${location.version.checksum}\n`);
  process.stdout.write(`S3 URI: ${s3Uri}\n`);
  process.stdout.write(`S3 console: ${consoleUrl.href}\n`);
}

function printSessionList(sessions: CatalogSessionSummary[], json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
    return;
  }
  if (sessions.length === 0) {
    process.stdout.write("No sessions found.\n");
    return;
  }

  process.stdout.write("HARNESS\tSESSION ID\tVER\tSIZE\tVERIFIED\tNAME\n");
  for (const session of sessions) {
    process.stdout.write(
      `${session.harness}\t${session.id}\t${session.latestVersion ?? "-"}\t${formatBytes(session.latestByteSize)}\t` +
        `${session.latestVerifiedAt ?? "-"}\t${singleLine(session.title ?? "(unnamed)")}\n`,
    );
  }
}

function printSessionDetails(session: CatalogSessionDetails, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(session, null, 2)}\n`);
    return;
  }

  process.stdout.write(`Session: ${session.id}\n`);
  process.stdout.write(`External ID: ${session.externalId}\n`);
  process.stdout.write(`Name: ${singleLine(session.title ?? "(unnamed)")}\n`);
  process.stdout.write(`Owner: ${session.ownerId}\n`);
  process.stdout.write(`Harness: ${session.harness}\n`);
  process.stdout.write(`Source installation: ${session.sourceInstallationId}\n`);
  process.stdout.write(`Source device: ${session.sourceDisplayName ?? session.sourceDeviceId}\n`);
  process.stdout.write(`Working directory: ${singleLine(session.workingDirectory ?? "-")}\n`);
  process.stdout.write(`Lifecycle: ${session.lifecycleStatus}\n`);
  process.stdout.write(`Started: ${session.startedAt ?? "-"}\n`);
  process.stdout.write(`Last observed: ${session.lastObservedAt}\n`);
  process.stdout.write(`Versions: ${session.versionCount} (showing ${session.versions.length})\n\n`);
  process.stdout.write("VER\tSIZE\tVERIFIED\tSHA-256\tOBJECT KEY\n");
  for (const version of session.versions) {
    process.stdout.write(
      `${version.version}\t${formatBytes(version.byteSize)}\t${version.verifiedAt}\t` +
        `${version.checksum}\t${version.objectKey}\n`,
    );
  }
}

function singleLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

function printProvisioningPlan(plan: S3BucketProvisioningPlan, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ type: "plan", ...plan })}\n`);
    return;
  }
  process.stdout.write(`S3 provisioning plan for ${plan.bucket} (${plan.region}):\n`);
  for (const change of plan.changes) process.stdout.write(`  - ${change}\n`);
}

async function confirmProvisioning(bucket: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Provisioning requires an interactive terminal or the explicit --yes flag");
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(`Provision S3 bucket ${bucket}? Type yes to continue: `);
    return answer.trim().toLowerCase() === "yes";
  } finally {
    terminal.close();
  }
}

function printSyncResults(results: Array<Record<string, unknown>>, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return;
  }

  const counts = new Map<string, number>();
  for (const result of results) {
    const status = typeof result.status === "string" ? result.status : "unknown";
    counts.set(status, (counts.get(status) ?? 0) + 1);
    if (status === "failed") process.stderr.write(`Failed ${String(result.path)}: ${String(result.error)}\n`);
  }
  for (const [status, count] of [...counts].sort()) process.stdout.write(`${status}: ${count}\n`);
}

function printRetentionRunSummary(summary: RetentionRunSummary, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ type: "retention", ...summary })}\n`);
    return;
  }
  process.stdout.write(
    `Retention complete: planned=${summary.planned} reconciled=${summary.reconciledVersionIds} ` +
      `staged=${summary.staged} cancelled=${summary.cancelled} deleted=${summary.deleted} ` +
      `failed=${summary.failed} bytes=${summary.deletedBytes}\n`,
  );
}

function printDaemonSummary(summary: DaemonScanSummary, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return;
  }
  process.stdout.write(
    `Scan complete: discovered=${summary.discovered} skipped=${summary.skippedByFingerprint} ` +
      `deferred=${summary.deferred} unchanged=${summary.unchanged} uploaded=${summary.uploaded} updated=${summary.updated} ` +
      `failed=${summary.failed} bytes=${summary.bytesStored}\n`,
  );
}

async function collectSessions(source: PiSessionSource): Promise<DiscoveredSession[]> {
  const sessions: DiscoveredSession[] = [];
  for await (const session of source.discover()) sessions.push(session);
  return sessions;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function isMissingControlSocket(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ECONNREFUSED")
  );
}

function isMissingCatalogSchema(error: unknown): boolean {
  return error instanceof Error && /no such table: source_installations/i.test(error.message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printUsage(): void {
  process.stdout.write(`minu-sessions ${packageMetadata.version}\n\n`);
  process.stdout.write(`minu-sessions commands:\n\n`);
  process.stdout.write(`  configure pi --bucket <bucket> --region <region> [--profile name]\n`);
  process.stdout.write(`  doctor [--json]\n`);
  process.stdout.write(`  storage s3 provision --bucket <bucket> --region <region> [--profile name]\n`);
  process.stdout.write(`  storage locate <session-id> [--version N] [--json]\n`);
  process.stdout.write(`  storage verify [session-id] [--sample N | --all] [--json]\n`);
  process.stdout.write(
    `  sessions list [--search text] [--harness name] [--device id] [--source id] [--limit N] [--json]\n`,
  );
  process.stdout.write(`  sessions show <session-id> [--versions N] [--json]\n`);
  process.stdout.write(`  discover [--json]\n`);
  process.stdout.write(`  sync [--force] [--json]\n`);
  process.stdout.write(`  sync --dry-run [--limit N] [--json]\n`);
  process.stdout.write(`  retention plan [--keep-days N] [--keep-versions N] [--json]\n`);
  process.stdout.write(`  reconcile plan [--sample N | --all] [--json]\n`);
  process.stdout.write(`  reconcile apply --yes [--limit N | --all] [--json]\n`);
  process.stdout.write(`  catalog backup [--output path]\n`);
  process.stdout.write(`  daemon install | start | stop | uninstall\n`);
  process.stdout.write(`  daemon once [--json]\n`);
  process.stdout.write(`  daemon run [--interval seconds] [--json]\n`);
  process.stdout.write(`  daemon status [--json]\n`);
}

main(process.argv.slice(2))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    process.stderr.write(`Error: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
