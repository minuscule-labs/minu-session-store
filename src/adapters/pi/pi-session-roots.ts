import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type PiSessionRootOptions = {
  sessionRoots?: string[];
  agentDirectory?: string;
};

export async function resolvePiSessionRoots(options: PiSessionRootOptions = {}): Promise<string[]> {
  if (options.sessionRoots?.length) return uniqueResolvedPaths(options.sessionRoots);

  const agentDirectory = resolveTilde(
    options.agentDirectory ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
  );
  const roots = new Set<string>([resolve(agentDirectory, "sessions")]);
  const environmentRoot = process.env.PI_CODING_AGENT_SESSION_DIR;
  if (environmentRoot) roots.add(resolveTilde(environmentRoot));

  const configuredRoot = await readConfiguredSessionRoot(join(agentDirectory, "settings.json"));
  if (configuredRoot) roots.add(configuredRoot);
  return [...roots].sort();
}

function uniqueResolvedPaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolveTilde(path)))].sort();
}

function resolveTilde(path: string): string {
  return resolve(expandTilde(path));
}

function expandTilde(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

async function readConfiguredSessionRoot(settingsPath: string): Promise<string | undefined> {
  try {
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
    if (!isRecord(settings) || typeof settings.sessionDir !== "string" || !settings.sessionDir.trim()) {
      return undefined;
    }
    return resolve(dirname(settingsPath), expandTilde(settings.sessionDir));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
