import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogStorageLocation } from "../src/catalog/session-catalog.js";
import type { RetrievableObjectStore } from "../src/core/contracts.js";
import {
  restoreSessionObject,
  retrieveVerifiedSessionObject,
} from "../src/operations/session-restorer.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("restoreSessionObject", () => {
  it("streams and verifies exact bytes into a private destination", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "recovered", "session.jsonl");
    const content = Buffer.from("first line\nsecond line\n");
    const target = storageTarget(content);
    const retrieveVersion = vi.fn(async () => ({
      storageVersionId: "s3-version-1",
      content: chunks(content, 5),
    }));

    const result = await restoreSessionObject({
      target,
      objectStore: objectStore(retrieveVersion),
      destinationPath: destination,
    });

    expect(await readFile(destination)).toEqual(content);
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
    expect(result).toMatchObject({
      sessionId: "session-1",
      version: 2,
      storageVersionId: "s3-version-1",
      byteSize: content.length,
      destinationPath: destination,
    });
    expect(retrieveVersion).toHaveBeenCalledWith({
      objectKey: target.version.objectKey,
      storageVersionId: "s3-version-1",
      checksum: target.version.checksum,
      byteSize: content.length,
      contentType: "application/x-ndjson",
    });
  });

  it("refuses an existing destination unless overwrite is explicit", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "session.jsonl");
    await writeFile(destination, "keep me");
    const content = Buffer.from("replacement\n");
    const retrieveVersion = vi.fn(async () => ({
      storageVersionId: "s3-version-1",
      content: chunks(content),
    }));

    await expect(
      restoreSessionObject({
        target: storageTarget(content),
        objectStore: objectStore(retrieveVersion),
        destinationPath: destination,
      }),
    ).rejects.toThrow("already exists");
    expect(await readFile(destination, "utf8")).toBe("keep me");
    expect(retrieveVersion).not.toHaveBeenCalled();

    await restoreSessionObject({
      target: storageTarget(content),
      objectStore: objectStore(retrieveVersion),
      destinationPath: destination,
      overwrite: true,
    });
    expect(await readFile(destination)).toEqual(content);
  });

  it("does not publish truncated or checksum-mismatched content", async () => {
    const directory = await temporaryDirectory();
    const targetContent = Buffer.from("authoritative\n");
    for (const restoredContent of [Buffer.from("short\n"), Buffer.from("tampered data\n")]) {
      const destination = join(directory, `session-${restoredContent.length}.jsonl`);
      await expect(
        restoreSessionObject({
          target: storageTarget(targetContent),
          objectStore: objectStore(async () => ({
            storageVersionId: "s3-version-1",
            content: chunks(restoredContent),
          })),
          destinationPath: destination,
        }),
      ).rejects.toThrow(/size mismatch|SHA-256 mismatch/);
      await expect(readFile(destination)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("requires an available exact storage version", async () => {
    const content = Buffer.from("session\n");
    const directory = await temporaryDirectory();
    const store = objectStore(vi.fn());

    await expect(
      restoreSessionObject({
        target: storageTarget(content, { storageVersionId: null }),
        objectStore: store,
        destinationPath: join(directory, "missing-version.jsonl"),
      }),
    ).rejects.toThrow("exact cataloged S3 VersionId");
    await expect(
      restoreSessionObject({
        target: storageTarget(content, { storageStatus: "deleted" }),
        objectStore: store,
        destinationPath: join(directory, "deleted.jsonl"),
      }),
    ).rejects.toThrow("deleted from storage");
  });

  it("provides a verified private staging file that callers dispose", async () => {
    const directory = await temporaryDirectory();
    const content = Buffer.from("verified staging\n");
    const restored = await retrieveVerifiedSessionObject({
      target: storageTarget(content),
      objectStore: objectStore(async () => ({
        storageVersionId: "s3-version-1",
        content: chunks(content),
      })),
      stagingDirectory: directory,
      filename: "session.jsonl",
    });

    expect(await readFile(restored.path)).toEqual(content);
    expect((await stat(restored.path)).mode & 0o777).toBe(0o600);
    await restored.dispose();
    await expect(stat(restored.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans staging after retrieval and verification failures", async () => {
    const directory = await temporaryDirectory();
    const content = Buffer.from("authoritative\n");
    const cases = [
      objectStore(async () => {
        throw new Error("retrieve failed");
      }),
      objectStore(async () => ({
        storageVersionId: "s3-version-1",
        content: chunks(Buffer.from("tampered\n")),
      })),
      objectStore(async () => ({
        storageVersionId: "s3-version-1",
        content: invalidChunks(),
      })),
    ];

    for (const store of cases) {
      await expect(
        retrieveVerifiedSessionObject({
          target: storageTarget(content),
          objectStore: store,
          stagingDirectory: directory,
        }),
      ).rejects.toThrow();
      await expectNoRestoreStaging(directory);
    }

    await expect(
      retrieveVerifiedSessionObject({
        target: storageTarget(content),
        objectStore: cases[0]!,
        stagingDirectory: directory,
        filename: "/",
      }),
    ).rejects.toThrow("staging filename");
    await expectNoRestoreStaging(directory);
  });

  it("cleans staging when publication fails", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "session.jsonl");
    const content = Buffer.from("authoritative\n");

    await expect(
      restoreSessionObject({
        target: storageTarget(content),
        objectStore: objectStore(async () => {
          await writeFile(destination, "concurrent destination");
          return { storageVersionId: "s3-version-1", content: chunks(content) };
        }),
        destinationPath: destination,
      }),
    ).rejects.toThrow("already exists");

    expect(await readFile(destination, "utf8")).toBe("concurrent destination");
    await expectNoRestoreStaging(directory);
  });
});

function objectStore(
  retrieveVersion: RetrievableObjectStore["retrieveVersion"],
): RetrievableObjectStore {
  return {
    retrieveVersion,
    async putImmutable(input) {
      return { status: "stored", objectKey: input.objectKey };
    },
    async verify() {
      return {};
    },
  };
}

function storageTarget(
  content: Buffer,
  overrides: Partial<CatalogStorageLocation["version"]> = {},
): CatalogStorageLocation {
  const checksum = createHash("sha256").update(content).digest("hex");
  return {
    ownerId: "local",
    harness: "pi",
    sessionId: "session-1",
    externalId: "external-1",
    sourceInstallationId: "source-1",
    version: {
      id: "object-1",
      version: 2,
      checksum,
      byteSize: content.length,
      objectKey: `sessions/local/session-1/raw/${checksum}.jsonl`,
      storageVersionId: "s3-version-1",
      contentType: "application/x-ndjson",
      storageStatus: "verified",
      observedAt: "2026-09-01T00:00:00.000Z",
      verifiedAt: "2026-09-01T00:00:01.000Z",
      deletedAt: null,
      ...overrides,
    },
  };
}

async function* chunks(content: Buffer, size = content.length): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < content.length; offset += size) {
    yield content.subarray(offset, Math.min(offset + size, content.length));
  }
}

async function* invalidChunks(): AsyncIterable<Uint8Array> {
  yield "not bytes" as unknown as Uint8Array;
}

async function expectNoRestoreStaging(directory: string): Promise<void> {
  expect((await readdir(directory)).filter((name) => name.startsWith(".minu-restore-"))).toEqual([]);
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "session-restore-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
