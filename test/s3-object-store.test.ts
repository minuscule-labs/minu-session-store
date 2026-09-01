import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildRawSessionObjectKey,
  S3ObjectStore,
  sha256HexToBase64,
} from "../src/adapters/s3/s3-object-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("S3ObjectStore", () => {
  it("uses a conditional checksummed upload and independently verifies it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "s3-store-test-"));
    temporaryDirectories.push(directory);
    const snapshotPath = join(directory, "session.jsonl");
    await writeFile(snapshotPath, "test");

    const checksum = "a".repeat(64);
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        const body = command.input.Body as { destroy?: () => void } | undefined;
        body?.destroy?.();
        return {};
      }
      if (command instanceof HeadObjectCommand) {
        return {
          ContentLength: 4,
          ContentType: "application/x-ndjson",
          ChecksumSHA256: sha256HexToBase64(checksum),
          ServerSideEncryption: "AES256",
          VersionId: "s3-version-1",
        };
      }
      throw new Error("Unexpected command");
    });
    const store = new S3ObjectStore({
      bucket: "sessions",
      client: { send } as unknown as S3Client,
    });

    const objectKey = buildRawSessionObjectKey({
      ownerId: "local",
      sessionId: "ses_123",
      checksum,
    });
    await expect(
      store.putImmutable({
        sessionId: "ses_123",
        objectKey,
        snapshotPath,
        checksum,
        byteSize: 4,
        contentType: "application/x-ndjson",
      }),
    ).resolves.toEqual({ status: "stored", objectKey });
    await expect(
      store.verify({
        objectKey,
        checksum,
        byteSize: 4,
        contentType: "application/x-ndjson",
      }),
    ).resolves.toEqual({ storageVersionId: "s3-version-1" });

    const put = send.mock.calls[0]?.[0];
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect((put as PutObjectCommand).input).toMatchObject({
      Bucket: "sessions",
      Key: objectKey,
      ContentLength: 4,
      ChecksumSHA256: sha256HexToBase64(checksum),
      IfNoneMatch: "*",
      ServerSideEncryption: "AES256",
    });

    const head = send.mock.calls[1]?.[0];
    expect(head).toBeInstanceOf(HeadObjectCommand);
    expect((head as HeadObjectCommand).input.ChecksumMode).toBe("ENABLED");
  });

  it("verifies the exact requested S3 object version", async () => {
    const checksum = "e".repeat(64);
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        return {
          ContentLength: 4,
          ContentType: "application/x-ndjson",
          ChecksumSHA256: sha256HexToBase64(checksum),
          ServerSideEncryption: "AES256",
          VersionId: "s3-version-2",
        };
      }
      throw new Error("Unexpected command");
    });
    const store = new S3ObjectStore({
      bucket: "sessions",
      client: { send } as unknown as S3Client,
    });

    await expect(
      store.verify({
        objectKey: `sessions/local/ses_123/raw/${checksum}.jsonl`,
        checksum,
        byteSize: 4,
        contentType: "application/x-ndjson",
        storageVersionId: "s3-version-2",
      }),
    ).resolves.toEqual({ storageVersionId: "s3-version-2" });

    expect((send.mock.calls[0]?.[0] as HeadObjectCommand).input.VersionId).toBe("s3-version-2");
    await expect(
      store.verify({
        objectKey: `sessions/local/ses_123/raw/${checksum}.jsonl`,
        checksum,
        byteSize: 4,
        contentType: "application/x-ndjson",
        storageVersionId: "s3-version-1",
      }),
    ).rejects.toThrow("VersionId mismatch");
  });

  it("treats a precondition failure as an existing immutable object", async () => {
    const directory = await mkdtemp(join(tmpdir(), "s3-store-test-"));
    temporaryDirectories.push(directory);
    const snapshotPath = join(directory, "session.jsonl");
    await writeFile(snapshotPath, "x");

    const send = vi.fn(async (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        const body = command.input.Body as { destroy?: () => void } | undefined;
        body?.destroy?.();
      }
      throw { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } };
    });
    const store = new S3ObjectStore({
      bucket: "sessions",
      client: { send } as unknown as S3Client,
    });

    await expect(
      store.putImmutable({
        sessionId: "ses_123",
        objectKey: `sessions/local/ses_123/raw/${"b".repeat(64)}.jsonl`,
        snapshotPath,
        checksum: "b".repeat(64),
        byteSize: 1,
        contentType: "application/x-ndjson",
      }),
    ).resolves.toEqual({
      status: "already_exists",
      objectKey: `sessions/local/ses_123/raw/${"b".repeat(64)}.jsonl`,
    });
  });

  it("deletes and verifies one exact S3 object version", async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof DeleteObjectCommand) return {};
      if (command instanceof HeadObjectCommand) {
        throw { name: "NoSuchVersion", $metadata: { httpStatusCode: 404 } };
      }
      throw new Error("Unexpected command");
    });
    const store = new S3ObjectStore({
      bucket: "sessions",
      client: { send } as unknown as S3Client,
    });
    const objectKey = `sessions/local/ses_123/raw/${"d".repeat(64)}.jsonl`;

    await expect(
      store.deleteVersion({ objectKey, storageVersionId: "s3-version-1" }),
    ).resolves.toBeUndefined();
    expect((send.mock.calls[0]?.[0] as DeleteObjectCommand).input).toEqual({
      Bucket: "sessions",
      Key: objectKey,
      VersionId: "s3-version-1",
    });
  });

  it("rejects unsafe object-key segments", () => {
    expect(() =>
      buildRawSessionObjectKey({
        ownerId: "../owner",
        sessionId: "ses_123",
        checksum: "c".repeat(64),
      }),
    ).toThrow("Invalid owner ID");
  });
});
