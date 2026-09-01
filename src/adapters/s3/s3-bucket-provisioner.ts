import { fromIni } from "@aws-sdk/credential-providers";
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
  type BucketLocationConstraint,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";

const TLS_POLICY_STATEMENT_ID = "MinuSessionStoreDenyInsecureTransport";

export type S3BucketProvisionerOptions = {
  bucket: string;
  region: string;
  profile?: string;
  kmsKeyId?: string;
  client?: S3Client;
  clientConfig?: S3ClientConfig;
};

export type S3BucketProvisioningPlan = {
  adapter: "s3";
  bucket: string;
  region: string;
  exists: boolean;
  encryption: "AES256" | "aws:kms";
  kmsKeyId?: string;
  changes: string[];
};

export type S3BucketProvisioningResult = S3BucketProvisioningPlan & {
  created: boolean;
  verified: true;
};

export class S3BucketProvisioner {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly region: string;
  private readonly kmsKeyId: string | undefined;

  constructor(options: S3BucketProvisionerOptions) {
    if (!options.bucket.trim()) throw new Error("S3 bucket is required");
    if (!options.region.trim()) throw new Error("S3 region is required");
    if (options.client && (options.clientConfig || options.profile)) {
      throw new Error("A provided S3 client cannot be combined with client configuration or a profile");
    }

    this.bucket = options.bucket;
    this.region = options.region;
    this.kmsKeyId = options.kmsKeyId;
    this.client =
      options.client ??
      new S3Client({
        ...(options.clientConfig ?? {}),
        region: options.region,
        ...(options.profile ? { credentials: fromIni({ profile: options.profile }) } : {}),
      });
  }

  async plan(): Promise<S3BucketProvisioningPlan> {
    const exists = await this.bucketExists();
    if (exists) await this.assertExistingBucketRegion();
    return {
      adapter: "s3",
      bucket: this.bucket,
      region: this.region,
      exists,
      encryption: this.kmsKeyId ? "aws:kms" : "AES256",
      ...(this.kmsKeyId === undefined ? {} : { kmsKeyId: this.kmsKeyId }),
      changes: [
        ...(exists ? [] : ["Create the private S3 bucket"]),
        "Block all forms of public access",
        "Enforce bucket-owner object ownership",
        "Enable object versioning",
        this.kmsKeyId ? "Enable default AWS KMS encryption" : "Enable default AES-256 encryption",
        "Deny all non-TLS requests while preserving existing policy statements",
      ],
    };
  }

  async provision(plan?: S3BucketProvisioningPlan): Promise<S3BucketProvisioningResult> {
    const currentPlan = plan ?? (await this.plan());
    this.assertPlanMatches(currentPlan);

    let created = false;
    if (!currentPlan.exists) {
      await this.createBucket();
      created = true;
    }

    await retryConflictingBucketOperation(() => this.applySecurityConfiguration());
    await retryConflictingBucketOperation(() => this.verifySecurityConfiguration());
    return { ...currentPlan, created, verified: true };
  }

  private async bucketExists(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch (error) {
      if (httpStatusCode(error) === 404) return false;
      throw error;
    }
  }

  private async assertExistingBucketRegion(): Promise<void> {
    const response = await this.client.send(new GetBucketLocationCommand({ Bucket: this.bucket }));
    const actualRegion = normalizeBucketRegion(response.LocationConstraint);
    if (actualRegion !== this.region) {
      throw new Error(
        `S3 bucket ${this.bucket} is in ${actualRegion}, not configured region ${this.region}`,
      );
    }
  }

  private async createBucket(): Promise<void> {
    await this.client.send(
      new CreateBucketCommand({
        Bucket: this.bucket,
        ...(this.region === "us-east-1"
          ? {}
          : {
              CreateBucketConfiguration: {
                LocationConstraint: this.region as BucketLocationConstraint,
              },
            }),
        ObjectOwnership: "BucketOwnerEnforced",
      }),
    );
  }

  private async applySecurityConfiguration(): Promise<void> {
    await Promise.all([
      this.client.send(
        new PutPublicAccessBlockCommand({
          Bucket: this.bucket,
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            IgnorePublicAcls: true,
            BlockPublicPolicy: true,
            RestrictPublicBuckets: true,
          },
        }),
      ),
      this.client.send(
        new PutBucketOwnershipControlsCommand({
          Bucket: this.bucket,
          OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] },
        }),
      ),
      this.client.send(
        new PutBucketVersioningCommand({
          Bucket: this.bucket,
          VersioningConfiguration: { Status: "Enabled" },
        }),
      ),
      this.client.send(
        new PutBucketEncryptionCommand({
          Bucket: this.bucket,
          ServerSideEncryptionConfiguration: {
            Rules: [
              {
                ApplyServerSideEncryptionByDefault: this.kmsKeyId
                  ? { SSEAlgorithm: "aws:kms", KMSMasterKeyID: this.kmsKeyId }
                  : { SSEAlgorithm: "AES256" },
                ...(this.kmsKeyId === undefined ? {} : { BucketKeyEnabled: true }),
              },
            ],
          },
        }),
      ),
      this.putTlsPolicy(),
    ]);
  }

  private async putTlsPolicy(): Promise<void> {
    const policy = await this.readPolicy();
    const statements = policyStatements(policy).filter(
      (statement) => statement.Sid !== TLS_POLICY_STATEMENT_ID,
    );
    statements.push({
      Sid: TLS_POLICY_STATEMENT_ID,
      Effect: "Deny",
      Principal: "*",
      Action: "s3:*",
      Resource: [`arn:aws:s3:::${this.bucket}`, `arn:aws:s3:::${this.bucket}/*`],
      Condition: { Bool: { "aws:SecureTransport": "false" } },
    });

    await this.client.send(
      new PutBucketPolicyCommand({
        Bucket: this.bucket,
        Policy: JSON.stringify({ ...policy, Version: policy.Version ?? "2012-10-17", Statement: statements }),
      }),
    );
  }

  private async readPolicy(): Promise<Record<string, unknown>> {
    try {
      const response = await this.client.send(new GetBucketPolicyCommand({ Bucket: this.bucket }));
      if (!response.Policy) return {};
      const parsed: unknown = JSON.parse(response.Policy);
      if (!isRecord(parsed)) throw new Error("Existing S3 bucket policy must be a JSON object");
      return parsed;
    } catch (error) {
      if (isMissingBucketPolicy(error)) return {};
      throw error;
    }
  }

  private async verifySecurityConfiguration(): Promise<void> {
    const [publicAccess, ownership, versioning, encryption, policy] = await Promise.all([
      this.client.send(new GetPublicAccessBlockCommand({ Bucket: this.bucket })),
      this.client.send(new GetBucketOwnershipControlsCommand({ Bucket: this.bucket })),
      this.client.send(new GetBucketVersioningCommand({ Bucket: this.bucket })),
      this.client.send(new GetBucketEncryptionCommand({ Bucket: this.bucket })),
      this.client.send(new GetBucketPolicyCommand({ Bucket: this.bucket })),
    ]);

    const publicBlock = publicAccess.PublicAccessBlockConfiguration;
    if (
      !publicBlock?.BlockPublicAcls ||
      !publicBlock.IgnorePublicAcls ||
      !publicBlock.BlockPublicPolicy ||
      !publicBlock.RestrictPublicBuckets
    ) {
      throw new Error("S3 public access block verification failed");
    }
    if (
      !ownership.OwnershipControls?.Rules?.some(
        (rule) => rule.ObjectOwnership === "BucketOwnerEnforced",
      )
    ) {
      throw new Error("S3 bucket ownership verification failed");
    }
    if (versioning.Status !== "Enabled") throw new Error("S3 bucket versioning verification failed");

    const encryptionDefault =
      encryption.ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault;
    const expectedAlgorithm = this.kmsKeyId ? "aws:kms" : "AES256";
    if (encryptionDefault?.SSEAlgorithm !== expectedAlgorithm) {
      throw new Error("S3 bucket encryption verification failed");
    }
    if (this.kmsKeyId && encryptionDefault.KMSMasterKeyID !== this.kmsKeyId) {
      throw new Error("S3 bucket KMS key verification failed");
    }

    const parsedPolicy: unknown = policy.Policy ? JSON.parse(policy.Policy) : {};
    if (
      !isRecord(parsedPolicy) ||
      !policyStatements(parsedPolicy).some((statement) => statement.Sid === TLS_POLICY_STATEMENT_ID)
    ) {
      throw new Error("S3 TLS policy verification failed");
    }
  }

  private assertPlanMatches(plan: S3BucketProvisioningPlan): void {
    if (plan.adapter !== "s3" || plan.bucket !== this.bucket || plan.region !== this.region) {
      throw new Error("S3 provisioning plan does not match this adapter configuration");
    }
  }
}

async function retryConflictingBucketOperation<T>(operation: () => Promise<T>): Promise<T> {
  const maximumAttempts = 5;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isConflictingBucketOperation(error) || attempt >= maximumAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
    }
  }
}

function isConflictingBucketOperation(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "OperationAborted" || /conflicting conditional operation/i.test(error.message))
  );
}

function policyStatements(policy: Record<string, unknown>): Array<Record<string, unknown>> {
  const statements = policy.Statement;
  if (statements === undefined) return [];
  if (Array.isArray(statements)) {
    if (!statements.every(isRecord)) throw new Error("Existing S3 bucket policy statements are invalid");
    return statements;
  }
  if (isRecord(statements)) return [statements];
  throw new Error("Existing S3 bucket policy Statement is invalid");
}

function normalizeBucketRegion(region: string | undefined): string {
  if (!region) return "us-east-1";
  if (region === "EU") return "eu-west-1";
  return region;
}

function isMissingBucketPolicy(error: unknown): boolean {
  return (
    httpStatusCode(error) === 404 ||
    (error instanceof Error && (error.name === "NoSuchBucketPolicy" || /no bucket policy/i.test(error.message)))
  );
}

function httpStatusCode(error: unknown): number | undefined {
  if (!isRecord(error) || !isRecord(error.$metadata)) return undefined;
  const status = error.$metadata.httpStatusCode;
  return typeof status === "number" ? status : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
