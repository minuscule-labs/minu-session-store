import { chmod, copyFile, stat, truncate } from "node:fs/promises";

export type DaemonLogPaths = {
  stdoutLog: string;
  stderrLog: string;
};

export async function maintainDaemonLogs(
  paths: DaemonLogPaths,
  maximumBytes = 10 * 1024 * 1024,
): Promise<void> {
  await Promise.all([
    rotateLogIfNeeded(paths.stdoutLog, maximumBytes),
    rotateLogIfNeeded(paths.stderrLog, maximumBytes),
  ]);
}

async function rotateLogIfNeeded(path: string, maximumBytes: number): Promise<void> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  if (size <= maximumBytes) return;

  const rotatedPath = `${path}.1`;
  await copyFile(path, rotatedPath);
  await chmod(rotatedPath, 0o600);
  await truncate(path, 0);
  await chmod(path, 0o600);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
