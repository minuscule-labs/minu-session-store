# Changelog

All notable changes to MinuSessionStore will be documented here. The project follows [Semantic Versioning](https://semver.org/) once releases are published.

## [Unreleased]

## [0.1.0] - 2026-09-01

### Added

- Pi v3 session discovery and stable exact-byte capture.
- SHA-256 immutable private-S3 snapshots with independent verification.
- User-owned SQLite and compatible libSQL catalog schema.
- Debounced daemon scans with persistent retries and maximum-wait checkpoints.
- macOS LaunchAgent installation and crash restart.
- Private Unix-domain daemon control socket and serialized manual sync.
- Session list, search, show, dry-run, status, backup, and retention planning commands.
- Exact S3 `VersionId` retention with a grace period and SQLite tombstones.
- Adapter-specific private S3 bucket provisioning and hardening.
- Open-source project policy, security, contribution, IAM, and operations documentation.
- Environment and infrastructure diagnostics through `minu-sessions doctor`.
- Rich daemon status with service, socket, job, storage, and retention state.
- Bounded daemon log rotation with one retained segment.
- Session filtering by harness, device, and source installation.
- Exact S3 object location with URI, console URL, checksum, status, and `VersionId`.
- Read-only sampled, per-session, and full archive integrity verification against exact S3 versions.
- Plan/apply reconciliation for missing S3 `VersionId` values with double verification, bounded batches, safe conditional catalog updates, and daemon-only writes.
- MVP stabilization guide with scope controls, weekly checks, private incident records, and evidence-based exit criteria.
