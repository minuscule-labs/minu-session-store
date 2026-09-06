import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkForUpdate,
  compareVersions,
  installUpdate,
  type UpdateCheck,
} from "../src/operations/updater.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("release updater", () => {
  it("checks the latest GitHub release without downloading its assets", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toBe("https://api.example.test/latest");
      return Response.json(releaseResponse("0.1.1"));
    });

    const result = await checkForUpdate({
      currentVersion: "0.1.0",
      releaseApiUrl: "https://api.example.test/latest",
      fetch: fetchMock,
    });

    expect(result).toEqual({
      currentVersion: "0.1.0",
      latestVersion: "0.1.1",
      updateAvailable: true,
      releaseUrl: "https://github.com/minuscule-labs/minu-session-store/releases/tag/v0.1.1",
      artifactName: "minuscule-labs-session-store-0.1.1.tgz",
      artifactUrl: "https://downloads.example.test/session-store.tgz",
      checksumUrl: "https://downloads.example.test/SHA256SUMS",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("compares numeric release components", () => {
    expect(compareVersions("0.2.0", "0.1.10")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.1.9", "0.2.0")).toBe(-1);
    expect(() => compareVersions("0.2", "0.1.0")).toThrow("Unsupported release version");
  });

  it("verifies the release checksum before installing through global npm", async () => {
    const directory = await mkdtemp(join(tmpdir(), "updater-test-"));
    temporaryDirectories.push(directory);
    const globalRoot = join(directory, "lib", "node_modules");
    const packageRoot = join(globalRoot, "@minuscule-labs", "session-store");
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    const artifact = Buffer.from("signed release artifact");
    const checksum = createHash("sha256").update(artifact).digest("hex");
    const commands: Array<{ command: string; args: string[] }> = [];
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      commands.push({ command, args });
      if (command === "npm" && args[0] === "root") {
        return { stdout: `${globalRoot}\n`, stderr: "" };
      }
      if (command === process.execPath) return { stdout: "0.1.1\n", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("SHA256SUMS")) {
        return new Response(`${checksum}  ${updateCheck.artifactName}\n`);
      }
      return new Response(artifact);
    });

    const result = await installUpdate(updateCheck, {
      packageRoot,
      runCommand,
      fetch: fetchMock,
      temporaryDirectory: directory,
    });

    expect(result).toEqual({ previousVersion: "0.1.0", version: "0.1.1" });
    expect(commands[1]?.command).toBe("npm");
    expect(commands[1]?.args.slice(0, 3)).toEqual(["install", "-g", "--ignore-scripts"]);
    expect(commands[2]).toEqual({
      command: process.execPath,
      args: [join(packageRoot, "dist", "cli.js"), "--version"],
    });
  });

  it("rejects a checksum mismatch before invoking npm install", async () => {
    const directory = await mkdtemp(join(tmpdir(), "updater-test-"));
    temporaryDirectories.push(directory);
    const globalRoot = join(directory, "node_modules");
    const packageRoot = join(globalRoot, "@minuscule-labs", "session-store");
    await mkdir(packageRoot, { recursive: true });
    const runCommand = vi.fn(async (_command: string, args: string[]) => ({
      stdout: args[0] === "root" ? `${globalRoot}\n` : "",
      stderr: "",
    }));
    const fetchMock = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith("SHA256SUMS")
        ? new Response(`${"0".repeat(64)}  ${updateCheck.artifactName}\n`)
        : new Response("different bytes"),
    );

    await expect(
      installUpdate(updateCheck, {
        packageRoot,
        runCommand,
        fetch: fetchMock,
        temporaryDirectory: directory,
      }),
    ).rejects.toThrow("checksum mismatch");
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("refuses to modify a source checkout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "updater-test-"));
    temporaryDirectories.push(directory);
    const globalRoot = join(directory, "global", "node_modules");
    const packageRoot = join(directory, "checkout");
    await Promise.all([mkdir(globalRoot, { recursive: true }), mkdir(packageRoot)]);
    const fetchMock = vi.fn<typeof fetch>();

    await expect(
      installUpdate(updateCheck, {
        packageRoot,
        fetch: fetchMock,
        runCommand: async () => ({ stdout: `${globalRoot}\n`, stderr: "" }),
      }),
    ).rejects.toThrow("not managed by global npm");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const updateCheck: UpdateCheck = {
  currentVersion: "0.1.0",
  latestVersion: "0.1.1",
  updateAvailable: true,
  releaseUrl: "https://github.com/minuscule-labs/minu-session-store/releases/tag/v0.1.1",
  artifactName: "minuscule-labs-session-store-0.1.1.tgz",
  artifactUrl: "https://downloads.example.test/session-store.tgz",
  checksumUrl: "https://downloads.example.test/SHA256SUMS",
};

function releaseResponse(version: string): Record<string, unknown> {
  return {
    tag_name: `v${version}`,
    html_url: `https://github.com/minuscule-labs/minu-session-store/releases/tag/v${version}`,
    assets: [
      {
        name: `minuscule-labs-session-store-${version}.tgz`,
        browser_download_url: "https://downloads.example.test/session-store.tgz",
      },
      {
        name: "SHA256SUMS",
        browser_download_url: "https://downloads.example.test/SHA256SUMS",
      },
    ],
  };
}
