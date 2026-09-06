# Uninstall and data removal

MinuSessionStore separates the installed program from user data. Removing the LaunchAgent or npm package does not delete the catalog, configuration, Pi sessions, AWS credentials, or S3 objects.

## Remove the program but keep the archive

This is the normal uninstall and allows a later reinstall to resume with the existing catalog and configuration.

```bash
minu-sessions catalog backup
minu-sessions daemon uninstall
npm uninstall -g @minuscule-labs/session-store
```

Preserved locations include:

```text
~/.config/minu/session-store/
~/.local/share/minu/session-store/
~/.local/state/minu/session-store/
```

The state directory contains logs rather than authoritative archive data and can be removed separately if desired.

## Remove all default local MinuSessionStore data

> [!CAUTION]
> This permanently deletes the local catalog and its backups. It does not delete Pi sessions or S3 objects. Verify the paths before running the removal commands.

First create any final backup that should survive removal, placing it outside the directory being deleted:

```bash
mkdir -p ~/Documents/minu-session-store-backup
chmod 700 ~/Documents/minu-session-store-backup
minu-sessions catalog backup \
  --output ~/Documents/minu-session-store-backup/catalog.db
```

Stop the daemon and remove the installed CLI:

```bash
minu-sessions daemon uninstall
npm uninstall -g @minuscule-labs/session-store
```

Review the default paths:

```bash
printf '%s\n' \
  "$HOME/.config/minu/session-store" \
  "$HOME/.local/share/minu/session-store" \
  "$HOME/.local/state/minu/session-store" \
  "$HOME/Library/LaunchAgents/com.minusculelabs.minu-session-store.plist"
```

Remove only those reviewed paths:

```bash
rm -rf -- "$HOME/.config/minu/session-store"
rm -rf -- "$HOME/.local/share/minu/session-store"
rm -rf -- "$HOME/.local/state/minu/session-store"
rm -f -- "$HOME/Library/LaunchAgents/com.minusculelabs.minu-session-store.plist"
```

This removes:

- MinuSessionStore configuration;
- the SQLite catalog, WAL files, and catalog backups;
- daemon logs, rotated logs, and a stale control socket if present;
- the per-user LaunchAgent file.

It does not remove:

- Pi JSONL sessions under `~/.pi/`;
- any private S3 object or bucket;
- AWS profiles or credential files;
- an IAM user, role, or inline policy;
- files stored at custom configured paths.

## Custom paths

Before deleting configuration, inspect it for a custom catalog URL or session roots:

```bash
cat "${MINU_SESSION_STORE_CONFIG:-$HOME/.config/minu/session-store/config.json}"
```

If `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, or `MINU_SESSION_STORE_CONFIG` was used, the default paths above may not contain all MinuSessionStore state. Remove custom files only after confirming that they belong to MinuSessionStore.

Never remove configured Pi session roots as part of MinuSessionStore uninstallation; they are owned by Pi.

## Confirm local removal

```bash
command -v minu-sessions || echo "CLI removed"

test ! -e "$HOME/.config/minu/session-store" && echo "Configuration removed"
test ! -e "$HOME/.local/share/minu/session-store" && echo "Catalog data removed"
test ! -e "$HOME/.local/state/minu/session-store" && echo "Daemon state removed"

launchctl print "gui/$(id -u)/com.minusculelabs.minu-session-store"
```

The final `launchctl` command should report that the service cannot be found.

## Cloud data removal

Cloud removal is deliberately separate from local uninstall because S3 contains the authoritative archived bytes and may have retention, compliance, or shared-access implications.

The runtime IAM profile intentionally cannot list the bucket or delete the bucket. A separate administrative identity is required to review and remove:

- every S3 object version and delete marker beneath the configured owner prefix;
- the bucket, but only if it is dedicated to MinuSessionStore and otherwise empty;
- the dedicated runtime IAM user or role and its credentials;
- the local AWS profile after its credentials have been disabled or deleted.

Do not assume `aws s3 rm --recursive` erases a versioned archive; it can leave historical versions behind. Use an explicit, reviewed version-aware deletion process. MinuSessionStore does not currently automate complete cloud destruction.

## Reinstall after preserving local data

If only the package and daemon were removed, reinstalling the same or a newer release will reuse the preserved configuration and catalog:

```bash
npm install -g \
  https://github.com/minuscule-labs/minu-session-store/releases/download/v0.1.0/minuscule-labs-session-store-0.1.0.tgz

minu-sessions doctor
minu-sessions daemon install
```
