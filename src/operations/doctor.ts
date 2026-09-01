import { lstat, stat } from "node:fs/promises";
import {
  GetBucketEncryptionCommand,
  GetBucketLocationCommand,
  GetBucketOwnershipControlsCommand,
  GetBucketPolicyCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { fromIni } from "@aws-sdk/credential-providers";
import { PiSessionSource } from "../adapters/pi/pi-session-source.js";
import { localDatabasePath } from "../catalog/catalog-url.js";
import { SessionCatalog } from "../catalog/session-catalog.js";
import { catalogAuthToken, type SessionStoreConfig } from "../config/config.js";
import {
  defaultControlSocketPath,
  isDaemonControlAvailable,
} from "../daemon/control-socket.js";
import { LaunchdService } from "../daemon/launchd-service.js";

export type DoctorCheckStatus = "pass" | "warning" | "fail";

export type DoctorCheck = {
  id: string;
  status: DoctorCheckStatus;
  message: string;
};

export type DoctorReport = {
  healthy: boolean;
  checks: DoctorCheck[];
};

export async function runDoctor(input: {
  config: SessionStoreConfig;
  configPath: string;
}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  checks.push(nodeVersionCheck());
  await checkPrivateFile(input.configPath, "configuration", checks);
  await checkCatalog(input.config, checks);
  await checkPi(input.config, checks);
  await checkDaemon(input.configPath, checks);
  await checkAws(input.config, checks);
  return { healthy: !checks.some((check) => check.status === "fail"), checks };
}

function nodeVersionCheck(): DoctorCheck {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const supported = major > 22 || (major === 22 && minor >= 19);
  return {
    id: "node",
    status: supported ? "pass" : "fail",
    message: supported
      ? `Node.js ${process.versions.node}`
      : `Node.js ${process.versions.node} is unsupported; 22.19 or newer is required`,
  };
}

async function checkPrivateFile(path: string, label: string, checks: DoctorCheck[]): Promise<void> {
  try {
    const metadata = await stat(path);
    const mode = metadata.mode & 0o777;
    checks.push({
      id: `${label}-permissions`,
      status: mode === 0o600 ? "pass" : "fail",
      message: `${label} permissions are ${mode.toString(8).padStart(3, "0")}; expected 600`,
    });
  } catch (error) {
    checks.push({ id: label, status: "fail", message: `${label} is unavailable: ${errorMessage(error)}` });
  }
}

async function checkCatalog(config: SessionStoreConfig, checks: DoctorCheck[]): Promise<void> {
  const path = localDatabasePath(config.catalog.url);
  if (path) await checkPrivateFile(path, "catalog", checks);
  let catalog: SessionCatalog | undefined;
  try {
    const authToken = catalogAuthToken(config);
    catalog = new SessionCatalog({
      url: config.catalog.url,
      ...(authToken === undefined ? {} : { authToken }),
    });
    const jobs = await catalog.getSyncJobSummary();
    checks.push({
      id: "catalog-query",
      status: jobs.failed > 0 ? "warning" : "pass",
      message: `catalog is readable; completed=${jobs.completed}, retry=${jobs.retry}, failed=${jobs.failed}`,
    });
  } catch (error) {
    checks.push({ id: "catalog-query", status: "fail", message: errorMessage(error) });
  } finally {
    catalog?.close();
  }
}

async function checkPi(config: SessionStoreConfig, checks: DoctorCheck[]): Promise<void> {
  const issues: string[] = [];
  const source = new PiSessionSource({
    ...(config.pi.sessionRoots === undefined ? {} : { sessionRoots: config.pi.sessionRoots }),
    onDiscoveryIssue: (issue) => issues.push(`${issue.path}: ${issue.message}`),
  });
  let count = 0;
  try {
    for await (const _session of source.discover()) count += 1;
    checks.push({
      id: "pi-discovery",
      status: count === 0 || issues.length > 0 ? "warning" : "pass",
      message: `discovered ${count} Pi sessions${issues.length ? ` with ${issues.length} warnings` : ""}`,
    });
  } catch (error) {
    checks.push({ id: "pi-discovery", status: "fail", message: errorMessage(error) });
  }
}

async function checkDaemon(configPath: string, checks: DoctorCheck[]): Promise<void> {
  if (process.platform !== "darwin") {
    checks.push({
      id: "daemon-service",
      status: "warning",
      message: "managed service installation is currently macOS-only",
    });
    return;
  }

  try {
    const service = new LaunchdService({ configPath });
    const running = await service.isRunning();
    checks.push({
      id: "launchd",
      status: running ? "pass" : "warning",
      message: running ? "LaunchAgent is running" : "LaunchAgent is not running",
    });
  } catch (error) {
    checks.push({ id: "launchd", status: "fail", message: errorMessage(error) });
  }

  try {
    const socket = await lstat(defaultControlSocketPath());
    const mode = socket.mode & 0o777;
    const responsive = await isDaemonControlAvailable();
    const valid = socket.isSocket() && mode === 0o600 && responsive;
    checks.push({
      id: "control-socket",
      status: valid ? "pass" : "fail",
      message: valid
        ? "daemon control socket is responsive with 600 permissions"
        : `control socket is unavailable or invalid (${mode.toString(8)})`,
    });
  } catch (error) {
    checks.push({ id: "control-socket", status: "warning", message: errorMessage(error) });
  }
}

async function checkAws(config: SessionStoreConfig, checks: DoctorCheck[]): Promise<void> {
  const credentials = config.s3.profile ? fromIni({ profile: config.s3.profile }) : undefined;
  const clientOptions = {
    region: config.s3.region,
    ...(credentials === undefined ? {} : { credentials }),
  };

  if (!config.s3.endpoint) {
    const sts = new STSClient(clientOptions);
    try {
      const identity = await sts.send(new GetCallerIdentityCommand({}));
      checks.push({
        id: "aws-identity",
        status: "pass",
        message: `AWS identity ${identity.Arn ?? identity.Account ?? "resolved"}`,
      });
    } catch (error) {
      checks.push({ id: "aws-identity", status: "fail", message: errorMessage(error) });
    } finally {
      sts.destroy();
    }
  } else {
    checks.push({
      id: "aws-identity",
      status: "warning",
      message: "STS identity check skipped for a custom S3 endpoint",
    });
  }

  const s3 = new S3Client({
    ...clientOptions,
    ...(config.s3.endpoint === undefined ? {} : { endpoint: config.s3.endpoint }),
    ...(config.s3.forcePathStyle === undefined ? {} : { forcePathStyle: config.s3.forcePathStyle }),
  });
  try {
    const [location, publicAccess, versioning, encryption, ownership, policy] = await Promise.all([
      s3.send(new GetBucketLocationCommand({ Bucket: config.s3.bucket })),
      s3.send(new GetPublicAccessBlockCommand({ Bucket: config.s3.bucket })),
      s3.send(new GetBucketVersioningCommand({ Bucket: config.s3.bucket })),
      s3.send(new GetBucketEncryptionCommand({ Bucket: config.s3.bucket })),
      s3.send(new GetBucketOwnershipControlsCommand({ Bucket: config.s3.bucket })),
      s3.send(new GetBucketPolicyCommand({ Bucket: config.s3.bucket })),
    ]);
    const actualRegion =
      location.LocationConstraint === "EU"
        ? "eu-west-1"
        : location.LocationConstraint || "us-east-1";
    checks.push({
      id: "s3-region",
      status: actualRegion === config.s3.region ? "pass" : "fail",
      message: `bucket region ${actualRegion}`,
    });
    const block = publicAccess.PublicAccessBlockConfiguration;
    const privateBucket =
      block?.BlockPublicAcls &&
      block.IgnorePublicAcls &&
      block.BlockPublicPolicy &&
      block.RestrictPublicBuckets;
    checks.push({
      id: "s3-public-access",
      status: privateBucket ? "pass" : "fail",
      message: privateBucket ? "all S3 public access is blocked" : "S3 public access block is incomplete",
    });
    const bucketOwnerEnforced = ownership.OwnershipControls?.Rules?.some(
      (rule) => rule.ObjectOwnership === "BucketOwnerEnforced",
    );
    checks.push({
      id: "s3-ownership",
      status: bucketOwnerEnforced ? "pass" : "fail",
      message: bucketOwnerEnforced
        ? "S3 bucket-owner-enforced ownership is active"
        : "S3 bucket ownership is not enforced",
    });
    const tlsRequired = policyDeniesInsecureTransport(policy.Policy);
    checks.push({
      id: "s3-tls-policy",
      status: tlsRequired ? "pass" : "fail",
      message: tlsRequired
        ? "S3 bucket policy denies non-TLS requests"
        : "S3 bucket policy does not deny non-TLS requests",
    });
    checks.push({
      id: "s3-versioning",
      status: versioning.Status === "Enabled" ? "pass" : "fail",
      message: `S3 versioning is ${versioning.Status ?? "not enabled"}`,
    });
    const algorithm =
      encryption.ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault
        ?.SSEAlgorithm;
    checks.push({
      id: "s3-encryption",
      status: algorithm ? "pass" : "fail",
      message: algorithm ? `S3 default encryption uses ${algorithm}` : "S3 default encryption is missing",
    });
  } catch (error) {
    checks.push({ id: "s3", status: "fail", message: errorMessage(error) });
  } finally {
    s3.destroy();
  }
}

function policyDeniesInsecureTransport(policyJson: string | undefined): boolean {
  if (!policyJson) return false;
  try {
    const policy: unknown = JSON.parse(policyJson);
    if (!isRecord(policy)) return false;
    const statements = Array.isArray(policy.Statement) ? policy.Statement : [policy.Statement];
    return statements.some(
      (statement) =>
        isRecord(statement) &&
        statement.Effect === "Deny" &&
        isRecord(statement.Condition) &&
        isRecord(statement.Condition.Bool) &&
        statement.Condition.Bool["aws:SecureTransport"] === "false",
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
}
