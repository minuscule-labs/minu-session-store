import { execFile } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
export const LAUNCHD_SERVICE_LABEL = "com.minusculelabs.minu-session-store";

export type LaunchdServiceOptions = {
  configPath: string;
  cliPath?: string;
  nodePath?: string;
  homeDirectory?: string;
};

export type LaunchdServicePaths = {
  plist: string;
  stdoutLog: string;
  stderrLog: string;
};

export function launchdServicePaths(homeDirectory = homedir()): LaunchdServicePaths {
  return {
    plist: join(
      homeDirectory,
      "Library",
      "LaunchAgents",
      `${LAUNCHD_SERVICE_LABEL}.plist`,
    ),
    stdoutLog: join(homeDirectory, ".local", "state", "minu", "session-store", "daemon.log"),
    stderrLog: join(
      homeDirectory,
      ".local",
      "state",
      "minu",
      "session-store",
      "daemon.error.log",
    ),
  };
}

export class LaunchdService {
  readonly paths: LaunchdServicePaths;
  private readonly configPath: string;
  private readonly cliPath: string;
  private readonly nodePath: string;
  private readonly domain: string;

  constructor(options: LaunchdServiceOptions) {
    if (process.platform !== "darwin") throw new Error("launchd service management requires macOS");
    const userId = process.getuid?.();
    if (userId === undefined) throw new Error("Unable to determine the launchd user domain");

    const home = options.homeDirectory ?? homedir();
    this.configPath = resolve(options.configPath);
    this.cliPath = resolve(options.cliPath ?? process.argv[1] ?? "dist/cli.js");
    this.nodePath = resolve(options.nodePath ?? process.execPath);
    this.domain = `gui/${userId}`;
    this.paths = launchdServicePaths(home);
  }

  async install(): Promise<void> {
    await mkdir(dirname(this.paths.plist), { recursive: true, mode: 0o700 });
    await mkdir(dirname(this.paths.stdoutLog), { recursive: true, mode: 0o700 });
    await writeFile(
      this.paths.plist,
      renderLaunchdPlist({
        configPath: this.configPath,
        cliPath: this.cliPath,
        nodePath: this.nodePath,
        stdoutLog: this.paths.stdoutLog,
        stderrLog: this.paths.stderrLog,
      }),
      { mode: 0o600 },
    );
    await chmod(this.paths.plist, 0o600);
    await this.stop();
    await this.start();
  }

  async start(): Promise<void> {
    if (await this.isLoaded()) {
      await executeFile("launchctl", [
        "kickstart",
        "-k",
        `${this.domain}/${LAUNCHD_SERVICE_LABEL}`,
      ]);
      return;
    }
    await executeFile("launchctl", ["bootstrap", this.domain, this.paths.plist]);
  }

  async stop(): Promise<void> {
    try {
      await executeFile("launchctl", [
        "bootout",
        `${this.domain}/${LAUNCHD_SERVICE_LABEL}`,
      ]);
    } catch (error) {
      if (!isMissingLaunchdService(error)) throw error;
    }
    await this.waitUntilUnloaded();
  }

  async uninstall(): Promise<void> {
    await this.stop();
    await rm(this.paths.plist, { force: true });
  }

  async isRunning(): Promise<boolean> {
    const output = await this.readServiceState();
    return output !== undefined && /^\s*state = running$/m.test(output);
  }

  private async isLoaded(): Promise<boolean> {
    return (await this.readServiceState()) !== undefined;
  }

  private async readServiceState(): Promise<string | undefined> {
    try {
      const { stdout } = await executeFile("launchctl", [
        "print",
        `${this.domain}/${LAUNCHD_SERVICE_LABEL}`,
      ]);
      return stdout;
    } catch (error) {
      if (isMissingLaunchdService(error)) return undefined;
      throw error;
    }
  }

  private async waitUntilUnloaded(): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (!(await this.isLoaded())) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Timed out waiting for the launchd service to stop");
  }
}

export function renderLaunchdPlist(input: {
  configPath: string;
  cliPath: string;
  nodePath: string;
  stdoutLog: string;
  stderrLog: string;
}): string {
  const argumentsXml = [
    input.nodePath,
    input.cliPath,
    "daemon",
    "run",
    "--config",
    input.configPath,
  ]
    .map((argument) => `      <string>${escapeXml(argument)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LAUNCHD_SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${argumentsXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${escapeXml(input.stdoutLog)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(input.stderrLog)}</string>
  </dict>
</plist>
`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function isMissingLaunchdService(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const output = `${error.message} ${"stderr" in error ? String(error.stderr) : ""}`;
  return /could not find service|no such process|service cannot be found/i.test(output);
}
