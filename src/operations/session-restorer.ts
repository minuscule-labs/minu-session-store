import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { CatalogStorageLocation } from "../catalog/session-catalog.js";
import type { RetrievableObjectStore } from "../core/contracts.js";

export type RestoreSessionObjectInput = {
  target: CatalogStorageLocation;
  objectStore: RetrievableObjectStore;
  destinationPath: string;
  overwrite?: boolean;
};

export type RestoredSessionObject = {
  sessionId: string;
  externalId: string;
  version: number;
  storageVersionId: string;
  checksum: string;
  byteSize: number;
  destinationPath: string;
};

export async function restoreSessionObject(
  input: RestoreSessionObjectInput,
): Promise<RestoredSessionObject> {
  const version = input.target.version;
  if (version.storageStatus === "deleted") {
    throw new Error("The selected session object has been deleted from storage");
  }
  if (!version.storageVersionId?.trim()) {
    throw new Error("Restore requires an exact cataloged S3 VersionId");
  }

  const destinationPath = resolve(input.destinationPath);
  const destinationName = basename(destinationPath);
  if (!destinationName) throw new Error("Restore destination must name a file");
  const parentDirectory = dirname(destinationPath);
  await mkdir(parentDirectory, { recursive: true, mode: 0o700 });
  if (!input.overwrite && (await pathExists(destinationPath))) {
    throw new Error(`Restore destination already exists: ${destinationPath}`);
  }

  const temporaryDirectory = await mkdtemp(join(parentDirectory, ".minu-restore-"));
  const temporaryPath = join(temporaryDirectory, destinationName);

  try {
    await chmod(temporaryDirectory, 0o700);
    const retrieved = await input.objectStore.retrieveVersion({
      objectKey: version.objectKey,
      storageVersionId: version.storageVersionId,
      checksum: version.checksum,
      byteSize: version.byteSize,
      contentType: version.contentType,
    });
    if (retrieved.storageVersionId !== version.storageVersionId) {
      throw new Error("Object store returned a different storage version during restore");
    }

    const file = await open(temporaryPath, "wx", 0o600);
    const hash = createHash("sha256");
    let byteSize = 0;
    try {
      for await (const value of retrieved.content) {
        if (!(value instanceof Uint8Array)) {
          throw new Error("Object store returned a non-binary restore chunk");
        }
        const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        byteSize += chunk.byteLength;
        if (byteSize > version.byteSize) {
          throw new Error("Restored object exceeds its cataloged byte size");
        }
        hash.update(chunk);
        await writeAll(file, chunk);
      }
      await file.sync();
    } finally {
      await file.close();
    }

    if (byteSize !== version.byteSize) {
      throw new Error(
        `Restored object size mismatch: expected ${version.byteSize}, received ${byteSize}`,
      );
    }
    const checksum = hash.digest("hex");
    if (checksum !== version.checksum.toLowerCase()) {
      throw new Error(`Restored object SHA-256 mismatch for session ${input.target.sessionId}`);
    }

    if (input.overwrite) {
      await rename(temporaryPath, destinationPath);
    } else {
      try {
        await link(temporaryPath, destinationPath);
      } catch (error) {
        if (isNodeError(error, "EEXIST")) {
          throw new Error(`Restore destination already exists: ${destinationPath}`);
        }
        throw error;
      }
      await unlink(temporaryPath);
    }
    return {
      sessionId: input.target.sessionId,
      externalId: input.target.externalId,
      version: version.version,
      storageVersionId: version.storageVersionId,
      checksum,
      byteSize,
      destinationPath,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function writeAll(file: Awaited<ReturnType<typeof open>>, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await file.write(buffer, offset, buffer.length - offset);
    if (result.bytesWritten === 0) throw new Error("Failed to write restored session bytes");
    offset += result.bytesWritten;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
