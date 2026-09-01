import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { maintainDaemonLogs } from "../src/daemon/log-maintenance.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("maintainDaemonLogs", () => {
  it("copies and truncates logs that exceed the configured limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "daemon-log-test-"));
    temporaryDirectories.push(directory);
    const stdoutLog = join(directory, "daemon.log");
    const stderrLog = join(directory, "daemon.error.log");
    await writeFile(stdoutLog, "large log contents", { mode: 0o600 });
    await writeFile(stderrLog, "small", { mode: 0o600 });

    await maintainDaemonLogs({ stdoutLog, stderrLog }, 5);

    expect(await readFile(`${stdoutLog}.1`, "utf8")).toBe("large log contents");
    expect((await stat(`${stdoutLog}.1`)).mode & 0o777).toBe(0o600);
    expect((await stat(stdoutLog)).size).toBe(0);
    expect(await readFile(stderrLog, "utf8")).toBe("small");
  });
});
