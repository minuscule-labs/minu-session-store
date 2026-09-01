import {
  CreateBucketCommand,
  GetBucketEncryptionCommand,
  GetBucketLocationCommand,
  GetBucketOwnershipControlsCommand,
  GetBucketPolicyCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
  HeadBucketCommand,
  PutBucketEncryptionCommand,
  PutBucketOwnershipControlsCommand,
  PutBucketPolicyCommand,
  PutBucketVersioningCommand,
  PutPublicAccessBlockCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { S3BucketProvisioner } from "../src/adapters/s3/s3-bucket-provisioner.js";

describe("S3BucketProvisioner", () => {
  it("creates and verifies a hardened private bucket", async () => {
    let policy: string | undefined;
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof HeadBucketCommand) {
        throw { $metadata: { httpStatusCode: 404 } };
      }
      if (
        command instanceof CreateBucketCommand ||
        command instanceof PutPublicAccessBlockCommand ||
        command instanceof PutBucketOwnershipControlsCommand ||
        command instanceof PutBucketVersioningCommand ||
        command instanceof PutBucketEncryptionCommand
      ) {
        return {};
      }
      if (command instanceof PutBucketPolicyCommand) {
        policy = command.input.Policy;
        return {};
      }
      if (command instanceof GetBucketPolicyCommand) {
        if (!policy) throw { name: "NoSuchBucketPolicy", $metadata: { httpStatusCode: 404 } };
        return { Policy: policy };
      }
      if (command instanceof GetPublicAccessBlockCommand) {
        return {
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            IgnorePublicAcls: true,
            BlockPublicPolicy: true,
            RestrictPublicBuckets: true,
          },
        };
      }
      if (command instanceof GetBucketOwnershipControlsCommand) {
        return { OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] } };
      }
      if (command instanceof GetBucketVersioningCommand) return { Status: "Enabled" };
      if (command instanceof GetBucketEncryptionCommand) {
        return {
          ServerSideEncryptionConfiguration: {
            Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }],
          },
        };
      }
      throw new Error(`Unexpected command: ${String(command)}`);
    });
    const provisioner = new S3BucketProvisioner({
      bucket: "example-session-archive",
      region: "us-east-1",
      client: { send } as unknown as S3Client,
    });

    const plan = await provisioner.plan();
    const result = await provisioner.provision(plan);

    expect(plan).toMatchObject({ adapter: "s3", exists: false, encryption: "AES256" });
    expect(result).toMatchObject({ created: true, verified: true });
    const create = send.mock.calls.map(([command]) => command).find(
      (command) => command instanceof CreateBucketCommand,
    ) as CreateBucketCommand;
    expect(create.input).toMatchObject({
      Bucket: "example-session-archive",
      ObjectOwnership: "BucketOwnerEnforced",
    });
    expect(create.input.CreateBucketConfiguration).toBeUndefined();
    expect(JSON.parse(policy ?? "{}").Statement).toContainEqual(
      expect.objectContaining({
        Sid: "MinuSessionStoreDenyInsecureTransport",
        Effect: "Deny",
      }),
    );
  });

  it("refuses to provision an existing bucket in a different region", async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof HeadBucketCommand) return {};
      if (command instanceof GetBucketLocationCommand) return { LocationConstraint: "eu-west-1" };
      throw new Error("Unexpected command");
    });
    const provisioner = new S3BucketProvisioner({
      bucket: "existing-bucket",
      region: "us-east-1",
      client: { send } as unknown as S3Client,
    });

    await expect(provisioner.plan()).rejects.toThrow("is in eu-west-1");
  });
});
