import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
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

  it("retrieves and validates one exact S3 object version", async () => {
    const checksum = "f".repeat(64);
    async function* body() {
      yield Buffer.from("test");
    }
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetObjectCommand) {
        return {
          Body: body(),
          ContentLength: 4,
          ContentType: "application/x-ndjson",
          ChecksumSHA256: sha256HexToBase64(checksum),
          ServerSideEncryption: "AES256",
          VersionId: "s3-version-3",
        };
      }
      throw new Error("Unexpected command");
    });
    const store = new S3ObjectStore({
      bucket: "sessions",
      client: { send } as unknown as S3Client,
    });
    const objectKey = `sessions/local/ses_123/raw/${checksum}.jsonl`;

    const retrieved = await store.retrieveVersion({
      objectKey,
      checksum,
      byteSize: 4,
      contentType: "application/x-ndjson",
      storageVersionId: "s3-version-3",
    });

    const received: Buffer[] = [];
    for await (const chunk of retrieved.content) received.push(Buffer.from(chunk));
    expect(Buffer.concat(received).toString()).toBe("test");
    expect((send.mock.calls[0]?.[0] as GetObjectCommand).input).toEqual({
      Bucket: "sessions",
      Key: objectKey,
      VersionId: "s3-version-3",
      ChecksumMode: "ENABLED",
    });
  });

  it("rejects invalid retrieval metadata and destroys rejected response bodies", async () => {
    const checksum = "f".repeat(64);
    const objectKey = `sessions/local/ses_123/raw/${checksum}.jsonl`;
    const cases: Array<{
      name: string;
      response: Record<string, unknown>;
      error: string;
      destroysBody: boolean;
    }> = [
      {
        name: "a different version",
        response: { VersionId: "s3-version-other" },
        error: "VersionId mismatch",
        destroysBody: true,
      },
      {
        name: "a different size",
        response: { ContentLength: 5 },
        error: "size mismatch",
        destroysBody: true,
      },
      {
        name: "a different checksum",
        response: { ChecksumSHA256: sha256HexToBase64("e".repeat(64)) },
        error: "SHA-256 mismatch",
        destroysBody: true,
      },
      {
        name: "a different content type",
        response: { ContentType: "text/plain" },
        error: "content type mismatch",
        destroysBody: true,
      },
      {
        name: "a non-streaming body",
        response: { Body: { destroy() {} } },
        error: "body is unavailable",
        destroysBody: true,
      },
      {
        name: "a missing body",
        response: { Body: undefined },
        error: "body is unavailable",
        destroysBody: false,
      },
    ];

    for (const testCase of cases) {
      const destroy = vi.fn();
      const body = {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from("test");
        },
        destroy,
      };
      const response: Record<string, unknown> = {
        Body: body,
        ContentLength: 4,
        ContentType: "application/x-ndjson",
        ChecksumSHA256: sha256HexToBase64(checksum),
        ServerSideEncryption: "AES256",
        VersionId: "s3-version-3",
        ...testCase.response,
      };
      if (testCase.name === "a non-streaming body") response.Body = { destroy };
      const store = new S3ObjectStore({
        bucket: "sessions",
        client: { send: vi.fn(async () => response) } as unknown as S3Client,
      });

      await expect(
        store.retrieveVersion({
          objectKey,
          checksum,
          byteSize: 4,
          contentType: "application/x-ndjson",
          storageVersionId: "s3-version-3",
        }),
        testCase.name,
      ).rejects.toThrow(testCase.error);
      expect(destroy).toHaveBeenCalledTimes(testCase.destroysBody ? 1 : 0);
    }
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
