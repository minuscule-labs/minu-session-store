import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createConfig,
  defaultCatalogPath,
  defaultConfigPath,
  loadConfig,
  writeConfig,
} from "../src/config/config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("session-store config", () => {
  it("writes a private credential-free config using an explicit AWS profile", async () => {
    const directory = await mkdtemp(join(tmpdir(), "session-config-test-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "nested", "config.json");
    const config = createConfig({
      bucket: "session-archive",
      region: "us-east-1",
      profile: "test-profile",
      deviceName: "Laptop",
    });

    await writeConfig(config, configPath);
    const loaded = await loadConfig(configPath);

    expect(loaded).toEqual(config);
    expect(loaded.s3.profile).toBe("test-profile");
    expect(JSON.stringify(loaded)).not.toContain("secret");
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "nested"))).mode & 0o777).toBe(0o700);
  });

  it("honors XDG and explicit config locations", () => {
    expect(defaultConfigPath({ XDG_CONFIG_HOME: "/config" })).toBe(
      "/config/minu/session-store/config.json",
    );
    expect(defaultCatalogPath({ XDG_DATA_HOME: "/data" })).toBe(
      "/data/minu/session-store/catalog.db",
    );
    expect(defaultConfigPath({ MINU_SESSION_STORE_CONFIG: "/custom/config.json" })).toBe(
      "/custom/config.json",
    );
  });
});
