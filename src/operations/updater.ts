import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const DEFAULT_RELEASE_API =
  "https://api.github.com/repos/minuscule-labs/minu-session-store/releases/latest";
const MAX_RELEASE_RESPONSE_BYTES = 1_000_000;
const MAX_CHECKSUM_BYTES = 1_000_000;
const MAX_ARTIFACT_BYTES = 100_000_000;
const REQUEST_TIMEOUT_MS = 10_000;

export type UpdateCheck = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
  artifactName: string;
  artifactUrl: string;
  checksumUrl: string;
};

type CommandResult = { stdout: string; stderr: string };
type RunCommand = (command: string, args: string[]) => Promise<CommandResult>;

export type UpdateOptions = {
  currentVersion: string;
  fetch?: typeof fetch;
  releaseApiUrl?: string;
};

export type InstallUpdateOptions = {
  packageRoot?: string;
  npmCommand?: string;
  runCommand?: RunCommand;
  fetch?: typeof fetch;
  temporaryDirectory?: string;
};

export type InstalledUpdate = {
  previousVersion: string;
  version: string;
};

export async function checkForUpdate(options: UpdateOptions): Promise<UpdateCheck> {
  parseVersion(options.currentVersion);
  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchWithTimeout(
    fetchImpl,
    options.releaseApiUrl ?? DEFAULT_RELEASE_API,
  );
  if (!response.ok) {
    throw new Error(`GitHub release check failed with HTTP ${response.status}`);
  }

  const body = JSON.parse(
    (await readResponseBytes(response, MAX_RELEASE_RESPONSE_BYTES, "release response")).toString(
      "utf8",
    ),
  ) as unknown;
  if (!isObject(body)) throw new Error("GitHub returned an invalid release response");

  const tagName = requiredString(body.tag_name, "release tag");
  const latestVersion = tagName.startsWith("v") ? tagName.slice(1) : tagName;
  parseVersion(latestVersion);
  const releaseUrl = requiredHttpsUrl(body.html_url, "release URL");
  if (!Array.isArray(body.assets)) throw new Error("GitHub release response has no assets");

  const artifactName = `minuscule-labs-session-store-${latestVersion}.tgz`;
  const artifactUrl = releaseAssetUrl(body.assets, artifactName);
  const checksumUrl = releaseAssetUrl(body.assets, "SHA256SUMS");

  return {
    currentVersion: options.currentVersion,
    latestVersion,
    updateAvailable: compareVersions(latestVersion, options.currentVersion) > 0,
    releaseUrl,
    artifactName,
    artifactUrl,
    checksumUrl,
  };
}

export async function installUpdate(
  update: UpdateCheck,
  options: InstallUpdateOptions = {},
): Promise<InstalledUpdate> {
  if (!update.updateAvailable) {
    return { previousVersion: update.currentVersion, version: update.currentVersion };
  }

  const packageRoot = resolve(options.packageRoot ?? defaultPackageRoot());
  const npmCommand = options.npmCommand ?? "npm";
  const runCommand = options.runCommand ?? defaultRunCommand;
  await assertGlobalNpmInstall(packageRoot, npmCommand, runCommand, update.latestVersion);

  const fetchImpl = options.fetch ?? fetch;
  const temporaryRoot = await mkdtemp(
    join(options.temporaryDirectory ?? tmpdir(), "minu-session-store-update-"),
  );

  try {
    await chmod(temporaryRoot, 0o700);
    const artifactPath = join(temporaryRoot, basename(update.artifactName));
    const [artifactResponse, checksumResponse] = await Promise.all([
      fetchWithTimeout(fetchImpl, update.artifactUrl),
      fetchWithTimeout(fetchImpl, update.checksumUrl),
    ]);
    if (!artifactResponse.ok) {
      throw new Error(`Release artifact download failed with HTTP ${artifactResponse.status}`);
    }
    if (!checksumResponse.ok) {
      throw new Error(`Release checksum download failed with HTTP ${checksumResponse.status}`);
    }

    const [artifact, checksumFile] = await Promise.all([
      readResponseBytes(artifactResponse, MAX_ARTIFACT_BYTES, "release artifact"),
      readResponseBytes(checksumResponse, MAX_CHECKSUM_BYTES, "checksum file"),
    ]);
    const expectedChecksum = checksumForArtifact(checksumFile.toString("utf8"), update.artifactName);
    const actualChecksum = createHash("sha256").update(artifact).digest("hex");
    if (actualChecksum !== expectedChecksum) {
      throw new Error(
        `Release artifact checksum mismatch: expected ${expectedChecksum}, received ${actualChecksum}`,
      );
    }

    await writeFile(artifactPath, artifact, { mode: 0o600 });
    await runCommand(npmCommand, ["install", "-g", "--ignore-scripts", artifactPath]);

    const installedCli = join(packageRoot, "dist", "cli.js");
    const installed = await runCommand(process.execPath, [installedCli, "--version"]);
    if (installed.stdout.trim() !== update.latestVersion) {
      throw new Error(
        `Installed CLI reported ${installed.stdout.trim() || "no version"}; expected ${update.latestVersion}`,
      );
    }

    return { previousVersion: update.currentVersion, version: update.latestVersion };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

async function assertGlobalNpmInstall(
  packageRoot: string,
  npmCommand: string,
  runCommand: RunCommand,
  latestVersion: string,
): Promise<void> {
  let globalRoot: string;
  try {
    globalRoot = (await runCommand(npmCommand, ["root", "-g"])).stdout.trim();
  } catch {
    throw new Error(
      "Unable to inspect the global npm installation. Update from the package manager or source checkout that installed MinuSessionStore.",
    );
  }
  if (!globalRoot) throw new Error("npm returned an empty global package root");

  let canonicalPackageRoot: string;
  let canonicalGlobalRoot: string;
  try {
    [canonicalPackageRoot, canonicalGlobalRoot] = await Promise.all([
      realpath(packageRoot),
      realpath(globalRoot),
    ]);
  } catch {
    throw new Error("Unable to resolve the installed package and global npm paths");
  }
  if (!isWithin(canonicalGlobalRoot, canonicalPackageRoot)) {
    throw new Error(
      "This MinuSessionStore installation is not managed by global npm. Update it with the package manager or source checkout that installed it.",
    );
  }

  try {
    await Promise.all([
      access(canonicalPackageRoot, constants.W_OK),
      access(dirname(canonicalPackageRoot), constants.W_OK),
    ]);
  } catch {
    throw new Error(
      `The global npm installation is not writable. Update it manually with: npm install -g ${updateInstallUrl(latestVersion)}`,
    );
  }
}

function updateInstallUrl(version: string): string {
  return (
    "https://github.com/minuscule-labs/minu-session-store/releases/download/" +
    `v${version}/minuscule-labs-session-store-${version}.tgz`
  );
}

function defaultPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

async function defaultRunCommand(command: string, args: string[]): Promise<CommandResult> {
  return executeFile(command, args, { encoding: "utf8" });
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string): Promise<Response> {
  try {
    return await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "minu-session-store-update-check",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`Unable to reach GitHub releases: ${errorMessage(error)}`);
  }
}

async function readResponseBytes(
  response: Response,
  maximumBytes: number,
  description: string,
): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(`${description} exceeds the ${maximumBytes}-byte safety limit`);
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw new Error(`${description} exceeds the ${maximumBytes}-byte safety limit`);
    }
    chunks.push(Buffer.from(result.value));
  }
  return Buffer.concat(chunks, length);
}

function checksumForArtifact(contents: string, artifactName: string): string {
  for (const line of contents.split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})[ \t]+\*?(.+)$/.exec(line.trim());
    if (match?.[2] === artifactName) return match[1]!.toLowerCase();
  }
  throw new Error(`SHA256SUMS does not contain ${artifactName}`);
}

function releaseAssetUrl(assets: unknown[], name: string): string {
  const asset = assets.find((candidate) => isObject(candidate) && candidate.name === name);
  if (!isObject(asset)) throw new Error(`GitHub release is missing required asset ${name}`);
  return requiredHttpsUrl(asset.browser_download_url, `${name} download URL`);
}

function requiredString(value: unknown, description: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`GitHub returned an invalid ${description}`);
  return value.trim();
}

function requiredHttpsUrl(value: unknown, description: string): string {
  const url = new URL(requiredString(value, description));
  if (url.protocol !== "https:") throw new Error(`${description} must use HTTPS`);
  return url.href;
}

function parseVersion(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Unsupported release version: ${version}`);
  const parts = match.slice(1).map(Number) as [number, number, number];
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    throw new Error(`Unsupported release version: ${version}`);
  }
  return parts;
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
