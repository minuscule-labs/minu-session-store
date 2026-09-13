import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { CatalogStorageLocation, SessionCatalog } from "../src/catalog/session-catalog.js";
import type { RetrievableObjectStore } from "../src/core/contracts.js";
import type {
  RehydrationPlan,
  SessionRehydrationAdapter,
} from "../src/rehydration/contracts.js";
import { SessionRehydrator } from "../src/rehydration/session-rehydrator.js";

const content = Buffer.from('{"type":"session","id":"external-1","version":3}\n');

describe("SessionRehydrator", () => {
  it("plans without downloading or mutating the snapshot", async () => {
    const target = storageTarget();
    const retrieveVersion = vi.fn();
    const plan = rehydrationPlan(target);
    const adapter = fakeAdapter({ plan: vi.fn(async () => plan) });
    const catalog = fakeCatalog(target);
    const rehydrator = createRehydrator({ catalog, retrieveVersion, adapter });

    await expect(
      rehydrator.plan({
        sessionId: target.sessionId,
        targetHarness: "pi",
        version: target.version.version,
        sessionRoot: "/private/tmp/pi-sessions",
      }),
    ).resolves.toEqual(plan);

    expect(retrieveVersion).not.toHaveBeenCalled();
    expect(adapter.plan).toHaveBeenCalledWith({
      sessionId: target.sessionId,
      externalId: target.externalId,
      sourceHarness: "pi",
      version: target.version.version,
      sessionObjectId: target.version.id,
      snapshotChecksum: target.version.checksum,
      byteSize: content.length,
      requestedSessionRoot: "/private/tmp/pi-sessions",
    });
  });

  it("validates and applies a freshly retrieved staging file, then disposes it", async () => {
    const target = storageTarget();
    let stagedPath = "";
    const adapter = fakeAdapter({
      validateSnapshot: vi.fn(async (_plan, path) => {
        stagedPath = path;
        expect(await readFile(path)).toEqual(content);
      }),
      apply: vi.fn(async (_plan, path) => {
        expect(path).toBe(stagedPath);
        return { status: "installed" as const, targetPath: "/private/tmp/pi-sessions/session.jsonl" };
      }),
    });
    const rehydrator = createRehydrator({ adapter, catalog: fakeCatalog(target) });

    await expect(
      rehydrator.apply({ sessionId: target.sessionId, targetHarness: "pi" }),
    ).resolves.toMatchObject({
      status: "installed",
      sessionId: target.sessionId,
      sessionObjectId: target.version.id,
      checksum: target.version.checksum,
      targetPath: "/private/tmp/pi-sessions/session.jsonl",
    });
    expect(adapter.validateSnapshot).toHaveBeenCalledTimes(1);
    expect(adapter.apply).toHaveBeenCalledTimes(1);
    await expect(stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not download an already-present session", async () => {
    const target = storageTarget();
    const retrieveVersion = vi.fn();
    const adapter = fakeAdapter({
      plan: vi.fn(async () => ({ ...rehydrationPlan(target), status: "already_present" as const })),
    });
    const rehydrator = createRehydrator({ adapter, retrieveVersion, catalog: fakeCatalog(target) });

    await expect(
      rehydrator.apply({ sessionId: target.sessionId, targetHarness: "pi" }),
    ).resolves.toMatchObject({ status: "already_present", checksum: target.version.checksum });
    expect(retrieveVersion).not.toHaveBeenCalled();
    expect(adapter.validateSnapshot).not.toHaveBeenCalled();
    expect(adapter.apply).not.toHaveBeenCalled();
  });

  it("preserves plan and apply warnings", async () => {
    const target = storageTarget();
    const adapter = fakeAdapter({
      plan: vi.fn(async () => ({ ...rehydrationPlan(target), warnings: ["Plan warning"] })),
      apply: vi.fn(async () => ({
        status: "installed" as const,
        warnings: ["Plan warning", "Apply warning"],
      })),
    });

    await expect(
      createRehydrator({ adapter, catalog: fakeCatalog(target) }).apply({
        sessionId: target.sessionId,
        targetHarness: "pi",
      }),
    ).resolves.toMatchObject({ warnings: ["Plan warning", "Apply warning"] });
  });

  it("rejects external IDs, unsupported harnesses, source mismatches, registry mismatches, and non-macOS platforms", async () => {
    const target = storageTarget();
    const adapter = fakeAdapter();
    const catalog = fakeCatalog(target);

    await expect(
      createRehydrator({ adapter, catalog }).plan({
        sessionId: target.externalId,
        targetHarness: "pi",
      }),
    ).rejects.toThrow("catalog session ID");
    await expect(
      createRehydrator({ adapter, catalog }).plan({
        sessionId: target.sessionId,
        targetHarness: "codex",
      }),
    ).rejects.toThrow("not supported for codex");
    await expect(
      createRehydrator({
        adapter: { ...adapter, harness: "codex" },
        catalog,
        adapters: new Map([["codex", { ...adapter, harness: "codex" }]]),
      }).plan({ sessionId: target.sessionId, targetHarness: "codex" }),
    ).rejects.toThrow("Cannot rehydrate a pi session into codex");
    await expect(
      createRehydrator({
        adapter,
        catalog,
        adapters: new Map([["pi", { ...adapter, harness: "codex" }]]),
      }).plan({ sessionId: target.sessionId, targetHarness: "pi" }),
    ).rejects.toThrow("adapter registry maps pi to codex");
    await expect(
      createRehydrator({ adapter, catalog, platform: "linux" }).plan({
        sessionId: target.sessionId,
        targetHarness: "pi",
      }),
    ).rejects.toThrow("only on macOS");
  });
});

function createRehydrator(input: {
  catalog: Pick<SessionCatalog, "locateSessionObjectById">;
  adapter: SessionRehydrationAdapter;
  retrieveVersion?: RetrievableObjectStore["retrieveVersion"];
  adapters?: ReadonlyMap<string, SessionRehydrationAdapter>;
  platform?: NodeJS.Platform;
}): SessionRehydrator {
  return new SessionRehydrator({
    ownerId: "local",
    catalog: input.catalog,
    objectStore: objectStore(
      input.retrieveVersion ??
        (async () => ({ storageVersionId: "s3-version-1", content: chunks(content) })),
    ),
    adapters: input.adapters ?? new Map([["pi", input.adapter]]),
    platform: input.platform ?? "darwin",
  });
}

function fakeCatalog(target: CatalogStorageLocation): Pick<SessionCatalog, "locateSessionObjectById"> {
  return {
    async locateSessionObjectById(ownerId, sessionId) {
      if (ownerId !== target.ownerId || sessionId !== target.sessionId) return undefined;
      return target;
    },
  };
}

function fakeAdapter(
  overrides: Partial<SessionRehydrationAdapter> = {},
): SessionRehydrationAdapter {
  return {
    harness: "pi",
    plan: vi.fn(async () => rehydrationPlan(storageTarget())),
    validateSnapshot: vi.fn(async () => {}),
    apply: vi.fn(async () => ({ status: "installed" as const })),
    ...overrides,
  };
}

function rehydrationPlan(target: CatalogStorageLocation): RehydrationPlan {
  return {
    harness: target.harness,
    status: "ready",
    sessionId: target.sessionId,
    externalId: target.externalId,
    sessionObjectId: target.version.id,
    snapshotChecksum: target.version.checksum,
    snapshotByteSize: target.version.byteSize,
    targetPath: "/private/tmp/pi-sessions/session.jsonl",
    changes: ["Install native session bytes"],
    warnings: [],
    precondition: { targetMustNotExist: true },
  };
}

function objectStore(
  retrieveVersion: RetrievableObjectStore["retrieveVersion"],
): RetrievableObjectStore {
  return {
    retrieveVersion,
    async putImmutable(input) {
      return { status: "stored", objectKey: input.objectKey };
    },
    async verify() {
      return {};
    },
  };
}

function storageTarget(): CatalogStorageLocation {
  const checksum = createHash("sha256").update(content).digest("hex");
  return {
    ownerId: "local",
    harness: "pi",
    sessionId: "session-1",
    externalId: "external-1",
    sourceInstallationId: "source-1",
    version: {
      id: "object-1",
      version: 2,
      checksum,
      byteSize: content.length,
      objectKey: `sessions/local/session-1/raw/${checksum}.jsonl`,
      storageVersionId: "s3-version-1",
      contentType: "application/x-ndjson",
      storageStatus: "verified",
      observedAt: "2026-09-01T00:00:00.000Z",
      verifiedAt: "2026-09-01T00:00:01.000Z",
      deletedAt: null,
    },
  };
}

async function* chunks(value: Buffer): AsyncIterable<Uint8Array> {
  yield value;
}
