# MinuSessionStore

Device-side archival for coding-agent sessions.

The initial vertical slice:

- discovers and safely captures Pi v3 JSONL sessions;
- preserves exact captured bytes and computes SHA-256;
- stores immutable raw snapshots in private S3;
- catalogs sessions in a user-owned SQLite database or hosted libSQL;
- serializes background and manual synchronization through one daemon pipeline.

## Status

The local-first v0.1 MVP is operational on macOS: direct private-S3 archival, local SQLite catalog, debounced background capture, exact-version retention, a private daemon control socket, catalog backups, and launchd restart support are implemented.

The project is currently under an MVP scope freeze while normal operation, resource usage, retention, and recovery signals are observed. See [docs/stabilization.md](docs/stabilization.md) for the checks and exit criteria.

See **[docs/usage.md](docs/usage.md)** for installation, everyday commands, retention, backups, restart behavior, file locations, and troubleshooting. See [docs/releasing.md](docs/releasing.md) for the guarded npm and Homebrew release checklist.

## Install

The experimental v0.1 release supports macOS and requires Node.js 22.19 or newer:

```bash
npm install -g https://github.com/minuscule-labs/minu-session-store/releases/download/v0.1.0/minuscule-labs-session-store-0.1.0.tgz
minu-sessions --help
```

The npm registry and Homebrew channels are deferred. The GitHub release artifact is the supported v0.1 distribution.

## Development

Requires Node.js 22.19 or newer. See [CONTRIBUTING.md](CONTRIBUTING.md) for project invariants, migration rules, and pull-request expectations.

```bash
npm install
npm run check
npm test
npm run build
```

Generate a migration after changing `src/catalog/schema.ts`:

```bash
npm run db:generate
```

Migrations live under `drizzle/`. The first migration also publishes the stable `session_catalog_v1` read view for direct user queries.

## CLI

Configuration stores no credentials. AWS credentials come from the selected SDK profile or the AWS SDK default credential chain.

Provisioning is adapter-specific and explicit. It prints a security plan and requires confirmation (or `--yes` for automation):

```bash
minu-sessions storage s3 provision \
  --bucket <private-bucket> \
  --region <aws-region> \
  --profile <aws-profile>

minu-sessions configure pi \
  --bucket <private-bucket> \
  --region <aws-region> \
  --profile <aws-profile>

minu-sessions doctor

minu-sessions sessions list
minu-sessions sessions list --search "auth"
minu-sessions sessions list --harness pi
minu-sessions sessions show <session-id>
minu-sessions storage locate <session-id>
minu-sessions storage verify --sample 20
minu-sessions reconcile plan

minu-sessions discover
minu-sessions sync --dry-run
minu-sessions sync          # requests a serialized scan through the daemon socket
minu-sessions sync --force  # explicit full capture/checksum pass

minu-sessions catalog backup

minu-sessions daemon once
minu-sessions daemon install   # install and start a macOS LaunchAgent
minu-sessions daemon status
minu-sessions daemon stop

# Dry-run retention planning; deletion remains disabled by default
minu-sessions retention plan
```

The default local catalog is `~/.local/share/minu/session-store/catalog.db`. Override configuration discovery with `MINU_SESSION_STORE_CONFIG`. Hosted libSQL tokens are read from `MINU_LIBSQL_AUTH_TOKEN`, never from the JSON configuration file.

## Snapshot scheduling and retention

The daemon scans every minute but uses trailing-edge debounce: a changed session is captured after two quiet minutes, with a forced safety checkpoint after thirty minutes of continuous changes. The state is persisted in SQLite, so restarts do not reset the maximum-wait window.

Manual sync requests use a private `0600` Unix-domain socket and share the daemon's serialized scan pipeline, preserving one catalog writer. Local-only catalogs do not emit hosted-delivery outbox events.

`retention plan` reads the catalog without modifying it. The default policy keeps every snapshot for seven days, at least the latest ten versions, and the first version. Retention remains disabled by default. When enabled, the daemon reconciles missing S3 `VersionId` values, stages eligible versions for a 24-hour grace period, deletes only the exact S3 versions after rechecking the current policy, verifies physical deletion, and retains SQLite tombstones.

## Catalog ownership

The daemon is the only supported writer to MinuSessionStore-owned tables. Users retain control of a local SQLite file and may:

- query tables and versioned read views;
- back up or copy the database;
- attach it from other SQLite applications;
- create unrelated tables and views.

Migrations must not modify unknown user-created database objects.

## Security boundary

Session files may contain source code, prompts, tool results, filesystem paths, and accidentally printed credentials. S3 objects must remain private. Local database files, temporary captures, and credentials must use user-private permissions. Never log transcript content or credentials.

See [SECURITY.md](SECURITY.md) for the threat model and vulnerability reporting, and [docs/aws-iam.md](docs/aws-iam.md) for least-privilege runtime and provisioning guidance.

## License

Licensed under the [Apache License 2.0](LICENSE).
