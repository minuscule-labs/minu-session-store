# Security policy

## Supported versions

Until the project reaches 1.0, only the latest released 0.x version receives security fixes.

## Reporting a vulnerability

Do not open a public issue for vulnerabilities involving credentials, private session content, S3 authorization, path traversal, local privilege boundaries, or destructive retention behavior.

Use the repository host's private vulnerability reporting feature to contact the maintainers. Include:

- affected version or commit;
- operating system and Node version;
- reproduction steps that do not contain real session content or credentials;
- expected and observed behavior;
- likely impact;
- any proposed mitigation.

Maintainers will acknowledge a complete report, investigate privately, and coordinate disclosure after a fix is available. Never upload another person's sessions or credentials as a proof of concept.

## Security model

MinuSessionStore handles highly sensitive material. Pi sessions may contain source code, prompts, tool output, filesystem paths, images, environment variables, and accidentally printed credentials.

The local-first MVP:

- reads session files as the current user;
- exposes no TCP or HTTP listener;
- accepts manual commands through a user-private Unix socket;
- stores metadata in a user-private SQLite database;
- uploads raw bytes only to the configured private S3 bucket;
- uses AWS credentials from the SDK credential chain, never its JSON configuration;
- requires exact S3 version deletion for retention;
- does not print transcript content in list or show commands.

S3 access is equivalent to access to archived transcripts. Users are responsible for bucket access controls, credential security, backups, and reviewing retention configuration.

## Out of scope

The project cannot protect session content from:

- software already running as the same operating-system user;
- a compromised AWS identity with object access;
- a compromised machine or administrator account;
- secrets deliberately written into a session and then archived.
