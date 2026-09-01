# MVP stabilization

MinuSessionStore is in a stabilization period. The goal is to observe the existing macOS, Pi, SQLite, and S3 MVP under normal use rather than expand its feature set.

## Scope freeze

During stabilization, accept changes only for:

- correctness or data-integrity defects;
- security and privacy defects;
- failed recovery or retention behavior;
- excessive resource or AWS usage supported by measurements;
- documentation that prevents operational mistakes;
- small diagnostic improvements needed to investigate a real failure.

Defer new platforms, installers, hosted services, native rewrites, schema expansion, and convenience features until the stabilization exit criteria are met.

## Baseline

Record a private baseline when stabilization begins. Do not commit machine names, AWS account identifiers, bucket names, session identifiers, filesystem paths, or transcript-derived data.

Capture:

- daemon uptime and resident memory;
- discovered sessions and sync-job counts;
- verified, pending-deletion, and deleted object counts;
- catalog and log sizes;
- latest catalog-backup date and size;
- Doctor outcome;
- sampled storage-verification outcome.

## Weekly check

Run once each week and after configuration or credential changes:

```bash
minu-sessions doctor
minu-sessions daemon status
minu-sessions storage verify --sample 20
minu-sessions retention plan
minu-sessions catalog backup
```

Review the daemon error log without sharing transcript content:

```bash
tail -100 ~/.local/state/minu/session-store/daemon.error.log
```

A full storage audit is appropriate after an integrity defect, retention defect, catalog recovery, or S3 configuration change:

```bash
minu-sessions storage verify --all --json > verification.json
```

Treat the JSON report as private operational data because it contains session IDs and S3 keys.

## What to measure

Track trends, not one-off values:

| Signal                | Healthy expectation                            |
| --------------------- | ---------------------------------------------- |
| Failed sync jobs      | Returns to zero after transient failures       |
| Integrity failures    | Always zero                                    |
| Verification warnings | Investigated and reconciled                    |
| Daemon memory         | Stable rather than continually increasing      |
| Catalog size          | Grows consistently with sessions and snapshots |
| Log size              | Remains bounded by rotation                    |
| Pending deletion      | Clears after the configured grace period       |
| AWS requests/storage  | Consistent with session activity and retention |

## Incident record

For each real failure, record privately:

- UTC timestamp;
- command and sanitized error code;
- affected component;
- whether raw bytes or catalog metadata were at risk;
- recovery action;
- verification performed afterward;
- whether a regression test or documentation change is required.

Never paste transcript content, credentials, signed URLs, AWS account IDs, bucket names, or unredacted filesystem paths into a public issue.

## Exit criteria

The MVP is ready to reconsider release work after at least two weeks of normal use with:

- no unresolved integrity or security defects;
- no unexplained failed sync jobs;
- successful weekly sampled verification;
- at least one successful full exact-version audit;
- retention completing without unexpected deletion;
- bounded daemon memory and logs;
- a recent, readable catalog backup;
- known AWS storage and request cost;
- all accepted defects covered by tests or explicit documentation.

Completing stabilization does not automatically trigger a release. It provides evidence for a separate release decision.
