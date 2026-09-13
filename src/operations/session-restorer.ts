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
import { tmpdir } from "node:os";
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

export type RetrieveVerifiedSessionObjectInput = {
  target: CatalogStorageLocation;
  objectStore: RetrievableObjectStore;
  stagingDirectory?: string;
  filename?: string;
};

export type VerifiedRestoredFile = {
  path: string;
  checksum: string;
  byteSize: number;
  storageVersionId: string;
  dispose(): Promise<void>;
};

export async function restoreSessionObject(
  input: RestoreSessionObjectInput,
): Promise<RestoredSessionObject> {
  assertRestorable(input.target);

  const destinationPath = resolve(input.destinationPath);
  const destinationName = fileName(destinationPath, "Restore destination must name a file");
  const parentDirectory = dirname(destinationPath);
  await mkdir(parentDirectory, { recursive: true, mode: 0o700 });
  if (!input.overwrite && (await pathExists(destinationPath))) {
    throw new Error(`Restore destination already exists: ${destinationPath}`);
  }

  const restored = await retrieveVerifiedSessionObject({
    target: input.target,
    objectStore: input.objectStore,
    stagingDirectory: parentDirectory,
    filename: destinationName,
  });
  try {
    await publishVerifiedSessionObject({
      restored,
      destinationPath,
      ...(input.overwrite === undefined ? {} : { overwrite: input.overwrite }),
    });
    return {
      sessionId: input.target.sessionId,
      externalId: input.target.externalId,
      version: input.target.version.version,
      storageVersionId: restored.storageVersionId,
      checksum: restored.checksum,
      byteSize: restored.byteSize,
      destinationPath,
    };
  } finally {
    await restored.dispose();
  }
}

export async function retrieveVerifiedSessionObject(
  input: RetrieveVerifiedSessionObjectInput,
): Promise<VerifiedRestoredFile> {
  assertRestorable(input.target);

  const stagingRoot = resolve(input.stagingDirectory ?? tmpdir());
  const temporaryDirectory = await mkdtemp(join(stagingRoot, ".minu-restore-"));

  try {
    await chmod(temporaryDirectory, 0o700);
    const temporaryPath = join(
      temporaryDirectory,
      fileName(input.filename ?? "session", "Restore staging filename must name a file"),
    );
    const retrieved = await input.objectStore.retrieveVersion({
      objectKey: input.target.version.objectKey,
      storageVersionId: input.target.version.storageVersionId!,
      checksum: input.target.version.checksum,
      byteSize: input.target.version.byteSize,
      contentType: input.target.version.contentType,
    });
    if (retrieved.storageVersionId !== input.target.version.storageVersionId) {
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
        if (byteSize > input.target.version.byteSize) {
          throw new Error("Restored object exceeds its cataloged byte size");
        }
        hash.update(chunk);
        await writeAll(file, chunk);
      }
      await file.sync();
    } finally {
      await file.close();
    }

    if (byteSize !== input.target.version.byteSize) {
      throw new Error(
        `Restored object size mismatch: expected ${input.target.version.byteSize}, received ${byteSize}`,
      );
    }
    const checksum = hash.digest("hex");
    if (checksum !== input.target.version.checksum.toLowerCase()) {
      throw new Error(`Restored object SHA-256 mismatch for session ${input.target.sessionId}`);
    }

    let disposed = false;
    return {
      path: temporaryPath,
      checksum,
      byteSize,
      storageVersionId: retrieved.storageVersionId,
      async dispose() {
        if (disposed) return;
        disposed = true;
        await rm(temporaryDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function publishVerifiedSessionObject(input: {
  restored: VerifiedRestoredFile;
  destinationPath: string;
  overwrite?: boolean;
}): Promise<void> {
  if (!input.overwrite && (await pathExists(input.destinationPath))) {
    throw new Error(`Restore destination already exists: ${input.destinationPath}`);
  }

  if (input.overwrite) {
    await rename(input.restored.path, input.destinationPath);
    return;
  }

  try {
    await link(input.restored.path, input.destinationPath);
  } catch (error) {
    if (isNodeError(error, "EEXIST")) {
      throw new Error(`Restore destination already exists: ${input.destinationPath}`);
    }
    throw error;
  }
  await unlink(input.restored.path);
}

function assertRestorable(target: CatalogStorageLocation): asserts target is CatalogStorageLocation & {
  version: CatalogStorageLocation["version"] & { storageVersionId: string };
} {
  if (target.version.storageStatus === "deleted") {
    throw new Error("The selected session object has been deleted from storage");
  }
  if (!target.version.storageVersionId?.trim()) {
    throw new Error("Restore requires an exact cataloged S3 VersionId");
  }
}

function fileName(path: string, message: string): string {
  const name = basename(path);
  if (!name || name === "." || name === "..") throw new Error(message);
  return name;
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
