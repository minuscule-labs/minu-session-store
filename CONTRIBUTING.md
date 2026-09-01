# Contributing

Thank you for helping improve MinuSessionStore.

## Development setup

Requires Node.js 22.19 or newer.

```bash
npm ci
npm run check
npm test
npm run build
```

Tests must not require personal AWS credentials or real session content. Use generated fixtures and mocked AWS clients. Clearly label any optional live integration procedure and ensure it cleans up exact object versions.

## Design principles

Contributions should preserve these invariants:

- exact original session bytes are never parsed and reserialized for archival;
- raw snapshots are immutable and identified with SHA-256;
- the daemon is the only writer to MinuSessionStore-owned catalog tables;
- manual synchronization uses the same serialized daemon pipeline;
- migrations preserve unknown user-created SQLite objects;
- retention never deletes the latest version and only deletes an exact S3 `VersionId`;
- transcript content, credentials, and signed URLs are never logged;
- source adapters and object-store integrations stay behind explicit contracts.

Prefer small, testable changes and simple control flow. Avoid speculative abstractions and hosted features in the local MVP.

## Database changes

After changing `src/catalog/schema.ts`:

```bash
npm run db:generate
```

Commit both the SQL migration and Drizzle metadata. Test migrations against a database containing unrelated user tables or views. Never edit an already released migration.

## Pull requests

A pull request should include:

- the problem and intended behavior;
- security and data-migration implications;
- tests for changed behavior;
- documentation updates for user-visible changes;
- successful `check`, `test`, `build`, and production dependency audit results.

Do not include real session transcripts, AWS account identifiers, bucket names, local absolute paths, credentials, or generated database files.

## Commit style

Use concise imperative commit messages, for example:

```text
Add catalog rebuild validation
Fix debounce state after failed capture
Document systemd installation
```

## Reporting security issues

Follow [SECURITY.md](SECURITY.md). Do not disclose security vulnerabilities in public issues or pull requests before a coordinated fix.
