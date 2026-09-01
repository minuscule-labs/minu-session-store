# MinuSessionStore usage guide

MinuSessionStore runs on the device where Pi writes sessions. It discovers Pi JSONL files, captures stable immutable snapshots, uploads the raw bytes directly to private S3, and maintains a user-owned SQLite catalog.

## Requirements

- macOS for managed background operation through launchd
- Node.js 22.19 or newer
- An AWS profile with access to the target S3 bucket
- Pi sessions, normally under `~/.pi/agent/sessions/`

Linux can run `minu-sessions daemon run` in the foreground, but service installation is currently macOS-only.

## Install

Install the experimental v0.1 GitHub release:

```bash
npm install -g https://github.com/minuscule-labs/minu-session-store/releases/download/v0.1.0/minuscule-labs-session-store-0.1.0.tgz
```

To develop from a source checkout instead:

```bash
npm install
npm run build
npm link
```

Confirm that the CLI is available:

```bash
minu-sessions help
```

After moving the repository or changing/removing the Node.js installation used during setup, rebuild, relink, and reinstall the LaunchAgent. Its plist records absolute paths to Node and the installed `minu-sessions` executable.

## Provision a new S3 bucket

Provisioning is explicit and adapter-specific:

```bash
minu-sessions storage s3 provision \
  --bucket <globally-unique-bucket-name> \
  --region us-east-1 \
  --profile <aws-profile>
```

The command shows its plan and asks for confirmation. Use `--yes` only for intentional automation. It configures:

- S3 Block Public Access
- bucket-owner-enforced ownership
- versioning
- default server-side encryption
- a policy denying non-TLS requests

An existing bucket can also be validated and hardened by the command. Review the plan carefully before applying it to a bucket used by anything else.

## Configure Pi synchronization

```bash
minu-sessions configure pi \
  --bucket <bucket-name> \
  --region us-east-1 \
  --profile <aws-profile>
```

Configuration is stored at:

```text
~/.config/minu/session-store/config.json
```

The file is created with `0600` permissions and does not contain AWS credentials. Credentials remain in the named AWS profile. If `--profile` is omitted, the AWS SDK default credential chain is used.

Do not rerun `configure` merely to change the AWS profile because configuration creates a new device identity. Edit only `s3.profile` in the existing JSON file, then restart the daemon:

```bash
minu-sessions daemon install
```

Validate the complete local and AWS environment:

```bash
minu-sessions doctor
```

The doctor checks Node, private file permissions, SQLite readability, Pi discovery, launchd, the control socket, AWS identity, bucket region, public-access blocking, versioning, and encryption. See [aws-iam.md](aws-iam.md) for the read-only diagnostic permissions and runtime policy.

## Preview and perform the initial sync

Discover Pi sessions without writing the catalog or S3:

```bash
minu-sessions discover
```

Plan a sync without modifying the database or S3:

```bash
minu-sessions sync --dry-run
```

Install and start the background daemon:

```bash
minu-sessions daemon install
```

Request a serialized scan through the running daemon:

```bash
minu-sessions sync
```

Normal scans honor debounce. To explicitly capture and checksum every discovered session, including active sessions:

```bash
minu-sessions sync --force
```

`--force` can read and hash a large amount of data. Use it sparingly.

## View archived sessions

List recently verified sessions:

```bash
minu-sessions sessions list
minu-sessions sessions list --limit 50
```

Search explicit names, external Pi IDs, and working directories, or filter by source metadata:

```bash
minu-sessions sessions list --search "authentication"
minu-sessions sessions list --harness pi
minu-sessions sessions list --device <device-id>
minu-sessions sessions list --source <source-installation-id>
```

Filters can be combined. Queries remain restricted to the owner configured for this installation.

Inspect one session and its recent immutable versions:

```bash
minu-sessions sessions show <session-id>
minu-sessions sessions show <session-id> --versions 5
```

Add `--json` to `list`, `show`, `sync`, or status-oriented commands when integrating with scripts.

Locate the latest or an exact immutable object in S3:

```bash
minu-sessions storage locate <session-id>
minu-sessions storage locate <external-session-id> --version 3
```

The result includes the harness, owner, source installation, checksum, storage status, S3 `VersionId`, S3 URI, and a console URL. Add `--json` for automation.

Verify exact S3 versions against catalog size, SHA-256 checksum, content type, encryption, and `VersionId` without downloading transcript content:

```bash
minu-sessions storage verify --sample 20
minu-sessions storage verify <session-id>
minu-sessions storage verify --all --json
```

The default checks the 20 most recently verified objects. A session identifier checks all retained versions for that session. `--all` checks every retained or pending-deletion object and can take time or incur S3 request charges. Verification is read-only and returns a nonzero exit code if any object fails or cannot be checked by exact `VersionId`. Objects with valid content but a missing catalog `VersionId` are reported as warnings with the observed S3 version for later reconciliation.

Plan missing `VersionId` reconciliation without writing the catalog:

```bash
minu-sessions reconcile plan
minu-sessions reconcile plan --all --json
```

Apply a bounded batch through the running daemon, which remains the sole catalog writer:

```bash
minu-sessions reconcile apply --yes
minu-sessions reconcile apply --limit 50 --yes
minu-sessions reconcile apply --all --yes
```

Apply verifies the object at its current immutable key, captures the observed S3 `VersionId`, verifies that exact version again, and only then records it if the catalog field is still empty. It never overwrites an existing `VersionId`. The default batch is 100 objects; `--all` can take time and incur S3 request charges.

The CLI shows metadata, checksums, sizes, verification times, and S3 keys. It does not download or print transcript content.

## Daemon operation

Useful commands:

```bash
minu-sessions daemon status
minu-sessions daemon start
minu-sessions daemon stop
minu-sessions daemon install
minu-sessions daemon uninstall
```

- `install` writes the LaunchAgent plist and starts or restarts it.
- `start` loads an installed LaunchAgent.
- `stop` stops it for the current login session but leaves the plist installed.
- `uninstall` stops it and removes the plist.
- `status` reports LaunchAgent/socket health, synchronization jobs, retained/deleting object counts, and whether retention is enabled.

Manual `sync` requests use a private Unix-domain socket and enter the daemon's serialized scan pipeline. The daemon remains the sole catalog writer.

### What happens after a computer restart?

The installed file is:

```text
~/Library/LaunchAgents/com.minusculelabs.minu-session-store.plist
```

When the user logs into macOS, launchd loads this agent because it has `RunAtLoad` and `KeepAlive` enabled. It does not run before that user logs in.

After launch:

1. The daemon reopens SQLite and applies any pending migrations.
2. It recreates the private control socket.
3. It performs an authoritative recursive Pi session scan.
4. Unchanged files are skipped using persisted fingerprints.
5. Files changed while the computer was off enter debounce or are captured immediately if already quiet.
6. Persistent retry, debounce, retention, and grace-period state continue from SQLite.
7. Enabled retention runs after the startup scan and then approximately once daily.

No filesystem events are required, so updates are not lost while the computer is off. If the daemon crashes, launchd restarts it. S3 objects and SQLite state survive daemon and computer restarts.

Verify operation after login:

```bash
launchctl print "gui/$(id -u)/com.minusculelabs.minu-session-store"
minu-sessions daemon status
tail -20 ~/.local/state/minu/session-store/daemon.log
```

If the repository, linked CLI, or Node executable moved, run `npm run build`, `npm link`, and `minu-sessions daemon install` again so the plist receives current absolute paths.

## Debounce and immutable versions

The daemon scans every minute, but it does not upload every observed change:

- capture after two quiet minutes;
- force a safety checkpoint after thirty minutes of continuous changes;
- preserve the first complete JSONL prefix observed at capture time;
- capture later appends in a later immutable version.

Every archived version is a complete file snapshot under a SHA-256-derived S3 key. Existing objects are never patched or overwritten.

## Retention

Show the current policy and deletion candidates without changing anything:

```bash
minu-sessions retention plan
minu-sessions retention plan --json
```

The configured MVP policy:

- keep every snapshot for seven days;
- always keep at least the latest ten versions;
- always keep the first and latest versions;
- stage eligible versions for a 24-hour grace period.

When retention is enabled, the daemon:

1. queries SQLite for eligible immutable versions;
2. reconciles missing S3 `VersionId` values;
3. stages candidates for the grace period;
4. rechecks the current policy;
5. deletes only the exact S3 object version;
6. verifies physical deletion;
7. retains a SQLite tombstone containing its metadata.

The runtime AWS profile needs `s3:DeleteObjectVersion` for retention deletion.

## Back up the catalog

Create a transactionally consistent SQLite backup while the daemon is running:

```bash
minu-sessions catalog backup
```

Backups default to:

```text
~/.local/share/minu/session-store/backups/catalog-<timestamp>.db
```

Choose another destination with:

```bash
minu-sessions catalog backup --output /path/to/catalog-backup.db
```

Raw session bytes remain authoritative in S3, but the SQLite backup preserves local IDs, titles, version history, retry state, and retention tombstones.

## Direct SQLite access

The stable read interface is `session_catalog_v1`:

```bash
sqlite3 -header -column \
  ~/.local/share/minu/session-store/catalog.db \
  "SELECT id, external_id, title, latest_version, latest_verified_at
   FROM session_catalog_v1
   ORDER BY latest_verified_at DESC
   LIMIT 20;"
```

Users may create unrelated tables and views. Do not directly modify MinuSessionStore-owned tables while the daemon is running.

## Files and permissions

| Purpose         | Default path                                                        |
| --------------- | ------------------------------------------------------------------- |
| Configuration   | `~/.config/minu/session-store/config.json`                          |
| SQLite catalog  | `~/.local/share/minu/session-store/catalog.db`                      |
| Catalog backups | `~/.local/share/minu/session-store/backups/`                        |
| Control socket  | `~/.local/state/minu/session-store/daemon.sock`                     |
| Daemon output   | `~/.local/state/minu/session-store/daemon.log`                      |
| Daemon errors   | `~/.local/state/minu/session-store/daemon.error.log`                |
| LaunchAgent     | `~/Library/LaunchAgents/com.minusculelabs.minu-session-store.plist` |

Configuration, database, backups, temporary snapshots, and the control socket are user-private.

## Troubleshooting

Start with:

```bash
minu-sessions doctor
```

### The CLI says the daemon is not running

```bash
minu-sessions daemon start
```

If that fails, reinstall the absolute command paths:

```bash
npm run build
minu-sessions daemon install
```

### AWS authentication fails

Confirm the configured profile works:

```bash
AWS_PROFILE=<aws-profile> aws sts get-caller-identity
```

Then verify `s3.profile`, `s3.region`, and `s3.bucket` in the configuration file.

### Archive verification fails

Run a focused JSON report:

```bash
minu-sessions storage verify <session-id> --json
```

Failures identify the session, snapshot version, object key, and mismatch without printing transcript bytes. A warning with an observed S3 version means the content currently at the immutable key is valid but the catalog still requires explicit `VersionId` reconciliation. A missing or mismatched S3 version must not be silently replaced.

### Inspect errors

```bash
tail -f ~/.local/state/minu/session-store/daemon.error.log
```

Session transcript content is intentionally not written to logs. Each daemon log is copied to a single `.1` file and truncated after it exceeds 10 MiB, bounding normal log growth while preserving the immediately previous segment.

### Retention does not delete

Check:

```bash
minu-sessions retention plan
```

A version must be older than the keep period, outside the latest-version minimum, outside its grace period, and have a verified S3 `VersionId`. The AWS profile must allow exact version deletion.
