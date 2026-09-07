# Changelog

All notable changes to MinuSessionStore will be documented here. The project follows [Semantic Versioning](https://semver.org/) once releases are published.

## [Unreleased]

### Added

- Exact-version session restore with streaming S3 retrieval, local size and SHA-256 verification, private temporary files, atomic placement, and explicit overwrite protection.

### Fixed

- Clean `dist/` before builds so local packages cannot include stale output from another branch.

## [0.1.1] - 2026-09-06

### Added

- Read-only `minu-sessions update --check` against the latest GitHub release.
- Checksum-verified `minu-sessions update` for writable global npm installations, with safe restart of a running LaunchAgent daemon.
- Explicit uninstall documentation separating the program, local user data, Pi-owned sessions, AWS credentials, and versioned cloud archives.

### Fixed

- Treat an early-closing stdout pipe as normal termination instead of reporting `EPIPE`.

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
