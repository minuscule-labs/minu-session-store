import { createReadStream } from "node:fs";
import { fromIni } from "@aws-sdk/credential-providers";
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
  type ServerSideEncryption,
} from "@aws-sdk/client-s3";
import { normalizeSha256Hex, sha256HexToBase64 } from "../../core/checksum.js";
import type {
  DeleteStoredObjectVersionInput,
  StoredObject,
  StoreSnapshotInput,
  VersionedObjectStore,
} from "../../core/contracts.js";

export { sha256HexToBase64 } from "../../core/checksum.js";

export type S3ObjectStoreOptions = {
  bucket: string;
  client?: S3Client;
  clientConfig?: S3ClientConfig;
  profile?: string;
  serverSideEncryption?: ServerSideEncryption;
  kmsKeyId?: string;
};

export class S3ObjectStore implements VersionedObjectStore {
  private readonly bucket: string;
  private readonly client: S3Client;
  private readonly serverSideEncryption: ServerSideEncryption;
  private readonly kmsKeyId: string | undefined;

  constructor(options: S3ObjectStoreOptions) {
    if (!options.bucket.trim()) throw new Error("S3 bucket is required");
    if (options.client && (options.clientConfig || options.profile)) {
      throw new Error("A provided S3 client cannot be combined with client configuration or a profile");
    }

    this.bucket = options.bucket;
    this.client =
      options.client ??
      new S3Client({
        ...(options.clientConfig ?? {}),
        ...(options.profile ? { credentials: fromIni({ profile: options.profile }) } : {}),
      });
    this.serverSideEncryption = options.serverSideEncryption ?? (options.kmsKeyId ? "aws:kms" : "AES256");
    if (
      options.kmsKeyId &&
      this.serverSideEncryption !== "aws:kms" &&
      this.serverSideEncryption !== "aws:kms:dsse"
    ) {
      throw new Error("An S3 KMS key requires KMS server-side encryption");
    }
    this.kmsKeyId = options.kmsKeyId;
  }

  async putImmutable(
    input: StoreSnapshotInput,
  ): Promise<{ status: "stored" | "already_exists"; objectKey: string }> {
    const objectKey = input.objectKey;
    assertSafeObjectKey(objectKey);
    const checksum = sha256HexToBase64(input.checksum);

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
          Body: createReadStream(input.snapshotPath),
          ContentLength: input.byteSize,
          ContentType: input.contentType,
          ChecksumSHA256: checksum,
          IfNoneMatch: "*",
          ServerSideEncryption: this.serverSideEncryption,
          ...(this.kmsKeyId === undefined ? {} : { SSEKMSKeyId: this.kmsKeyId }),
          Metadata: {
            "minu-sha256": input.checksum,
          },
        }),
      );
      return { status: "stored", objectKey };
    } catch (error) {
      if (isPreconditionFailure(error)) return { status: "already_exists", objectKey };
      throw error;
    }
  }

  async verify(input: StoredObject): Promise<{ storageVersionId?: string }> {
    assertSafeObjectKey(input.objectKey);
    const response = await this.client.send(
      new HeadObjectCommand({
        Bucket: this.bucket,
        Key: input.objectKey,
        ...(input.storageVersionId === undefined ? {} : { VersionId: input.storageVersionId }),
        ChecksumMode: "ENABLED",
      }),
    );

    if (input.storageVersionId && response.VersionId !== input.storageVersionId) {
      throw new Error(
        `S3 object VersionId mismatch for ${input.objectKey}: expected ${input.storageVersionId}, received ${String(response.VersionId)}`,
      );
    }
    if (response.ContentLength !== input.byteSize) {
      throw new Error(
        `S3 object size mismatch for ${input.objectKey}: expected ${input.byteSize}, received ${String(response.ContentLength)}`,
      );
    }

    const expectedChecksum = sha256HexToBase64(input.checksum);
    if (response.ChecksumSHA256 !== expectedChecksum) {
      throw new Error(`S3 object SHA-256 mismatch for ${input.objectKey}`);
    }

    if (response.ContentType !== input.contentType) {
      throw new Error(
        `S3 object content type mismatch for ${input.objectKey}: expected ${input.contentType}, received ${String(response.ContentType)}`,
      );
    }

    if (response.ServerSideEncryption !== this.serverSideEncryption) {
      throw new Error(`S3 object encryption mismatch for ${input.objectKey}`);
    }
    if (this.kmsKeyId && response.SSEKMSKeyId !== this.kmsKeyId) {
      throw new Error(`S3 object KMS key mismatch for ${input.objectKey}`);
    }
    return response.VersionId === undefined ? {} : { storageVersionId: response.VersionId };
  }

  async deleteVersion(input: DeleteStoredObjectVersionInput): Promise<void> {
    assertSafeObjectKey(input.objectKey);
    if (!input.storageVersionId.trim()) throw new Error("S3 version ID is required for deletion");

    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: input.objectKey,
        VersionId: input.storageVersionId,
      }),
    );
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: input.objectKey,
          VersionId: input.storageVersionId,
        }),
      );
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    throw new Error(`S3 object version still exists after deletion: ${input.objectKey}`);
  }
}

export function buildRawSessionObjectKey(input: {
  ownerId: string;
  sessionId: string;
  checksum: string;
  extension?: string;
}): string {
  const ownerId = objectKeySegment(input.ownerId, "owner ID");
  const sessionId = objectKeySegment(input.sessionId, "session ID");
  const checksum = normalizeSha256Hex(input.checksum);
  const extension = objectKeySegment(input.extension ?? "jsonl", "extension");
  return `sessions/${ownerId}/${sessionId}/raw/${checksum}.${extension}`;
}

function assertSafeObjectKey(value: string): void {
  const segments = value.split("/");
  if (
    value.length === 0 ||
    value.length > 1024 ||
    value.startsWith("/") ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Unsafe S3 object key");
  }
}

function objectKeySegment(value: string, label: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) {
    throw new Error(`Invalid ${label} for S3 object key`);
  }
  return value;
}

function isPreconditionFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return candidate.name === "PreconditionFailed" || candidate.$metadata?.httpStatusCode === 412;
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return (
    candidate.name === "NoSuchKey" ||
    candidate.name === "NoSuchVersion" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}
