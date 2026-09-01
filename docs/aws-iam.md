# AWS IAM guidance

Use separate identities for runtime synchronization and bucket provisioning. Do not run the daemon with an administrator profile.

Replace `YOUR_BUCKET` and `YOUR_OWNER_ID` before using these examples. The default local owner ID is `local`.

## Runtime and retention policy

This policy allows the daemon to upload, verify, diagnose, and delete only exact retained versions beneath its owner prefix.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InspectSessionStoreBucket",
      "Effect": "Allow",
      "Action": [
        "s3:GetBucketLocation",
        "s3:GetBucketVersioning",
        "s3:GetBucketPublicAccessBlock",
        "s3:GetBucketOwnershipControls",
        "s3:GetBucketPolicy",
        "s3:GetEncryptionConfiguration"
      ],
      "Resource": "arn:aws:s3:::YOUR_BUCKET"
    },
    {
      "Sid": "WriteAndVerifySessionObjects",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:DeleteObjectVersion"
      ],
      "Resource": "arn:aws:s3:::YOUR_BUCKET/sessions/YOUR_OWNER_ID/*"
    }
  ]
}
```

If retention is disabled, remove `s3:DeleteObjectVersion`. The daemon never needs `s3:DeleteObject`, which could create a delete marker without reclaiming the exact version.

`minu-sessions doctor` also calls STS `GetCallerIdentity`. AWS permits that operation without an identity policy grant, although an organization-level control policy can still deny it.

## KMS encryption

For a customer-managed KMS key, add only the key permissions required by the configured S3 workflow, normally:

```text
kms:GenerateDataKey
kms:Decrypt
kms:DescribeKey
```

Constrain them to the intended key and S3 encryption context. SSE-S3 (`AES256`) does not require KMS permissions.

## Provisioning identity

`minu-sessions storage s3 provision` changes bucket-level security settings. Run it with a separate administrative profile authorized to:

- create or inspect the bucket;
- configure public-access blocking;
- configure ownership controls;
- enable versioning;
- configure default encryption;
- read and update the bucket policy.

Do not grant these bucket-management permissions to the long-running daemon identity.

## Configure the runtime profile

Store credentials through the AWS SDK credential chain, not MinuSessionStore JSON. For example:

```bash
aws configure --profile minu-session-store
```

Or use a credential process backed by macOS Keychain or another secure credential manager.

Set only the profile name in:

```text
~/.config/minu/session-store/config.json
```

```json
{
  "s3": {
    "bucket": "YOUR_BUCKET",
    "region": "us-east-1",
    "profile": "minu-session-store",
    "serverSideEncryption": "AES256"
  }
}
```

Restart and validate:

```bash
minu-sessions daemon install
minu-sessions doctor
```
