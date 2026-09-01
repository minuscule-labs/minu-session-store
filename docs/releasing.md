# Release checklist

GitHub release artifacts are the initial distribution channel. The npm package remains marked `private` to prevent registry publication before an npm scope and trusted publisher are configured.

## One-time setup

1. Create the public source repository.
2. Add its `repository`, `homepage`, and `bugs` URLs to `package.json`.
3. Add branch protection requiring CI.
4. Enable private vulnerability reporting on the repository host.
5. Confirm the tag-triggered GitHub release workflow has `contents: write` permission.

For later npm registry publication:

1. Confirm the final npm scope and package name.
2. Configure npm trusted publishing or an environment-protected provenance workflow.
3. Only then remove:

```json
"private": true
```

## Release verification

```bash
npm ci
npm run verify
npm pack --dry-run
```

Verify on a clean macOS user account:

- install and link/package the CLI;
- provision or validate a test bucket;
- configure without personal defaults;
- run `minu-sessions doctor`;
- install the LaunchAgent;
- upload and verify a generated fixture;
- request sync through the private socket;
- create and query a catalog backup;
- uninstall the LaunchAgent cleanly.

Never publish a real configuration file, SQLite catalog, Pi session, AWS identifier, bucket name, credential file, log, or LaunchAgent generated for a specific user.

## Version release

1. Update `CHANGELOG.md`.
2. Set the intended package version.
3. Commit the release changes.
4. Tag the commit, for example `v0.1.0`.
5. Push the tag.
6. Allow the release workflow to verify the package, create the `.tgz` and checksum, and publish the GitHub release.
7. Install the published artifact and run a final smoke test.
8. Publish to npm only from a separately configured trusted workflow.
9. Update the Homebrew formula only after its source artifact is immutable.

## Homebrew direction

The initial formula should depend on a compatible Node 22 package and install MinuSessionStore into Homebrew-managed `libexec`. It should expose `minu-sessions` without using NVM or a repository-local `npm link`.

The formula must not install or start the user LaunchAgent automatically. Users should review configuration and explicitly run:

```bash
minu-sessions daemon install
```
