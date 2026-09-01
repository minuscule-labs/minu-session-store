import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function localDatabasePath(url: string): string | undefined {
  if (!url.startsWith("file:") || url === "file::memory:") return undefined;
  if (url.startsWith("file://")) return fileURLToPath(url);
  return resolve(url.slice("file:".length));
}
