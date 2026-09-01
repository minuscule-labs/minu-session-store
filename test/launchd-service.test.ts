import { describe, expect, it } from "vitest";
import { renderLaunchdPlist } from "../src/daemon/launchd-service.js";

describe("renderLaunchdPlist", () => {
  it("renders an absolute daemon command and escapes XML-sensitive paths", () => {
    const plist = renderLaunchdPlist({
      nodePath: "/usr/local/bin/node",
      cliPath: "/workspace/minu & sessions/dist/cli.js",
      configPath: "/Users/test/.config/minu/config.json",
      stdoutLog: "/tmp/minu.log",
      stderrLog: "/tmp/minu.error.log",
    });

    expect(plist).toContain("com.minusculelabs.minu-session-store");
    expect(plist).toContain("/workspace/minu &amp; sessions/dist/cli.js");
    expect(plist).toContain("<string>daemon</string>");
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain("<key>KeepAlive</key>\n    <true/>");
  });
});
