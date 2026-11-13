import { afterEach, describe, expect, it, vi } from "vitest";

import { createHash } from "node:crypto";

import {
  AccountInvoker,
  LoginInvoker,
  TimeMachineWorkspaceInvoker,
  type PlateModelSimpleRO,
  type ProjectRevisionRO,
} from "@timemachine/generated-api";

import { Phase1BCloudClient } from "../phase1b/cloud-client";
import { SharedPlateModelClient } from "../plate-model/shared-plate-client";
import { ProjectLayerType } from "@timemachine/generated-api";
import { TIME_MACHINE_ACCESS_TOKEN_KEY } from "../platform-bootstrap";

/**
 * Session lifecycle of the cloud client. Everything is synthetic: no real
 * account, password, token or Server is involved.
 */

const TOKEN_KEY = TIME_MACHINE_ACCESS_TOKEN_KEY;

function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  };
}

interface StorageLike {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

function simpleModel(id: number): PlateModelSimpleRO {
  return { ID: { Value: id }, Name: `model-${id}` } as unknown as PlateModelSimpleRO;
}

/** A stand-in for the V1 byte-stream client, driven by a page script. */
function fakeSharedClient(pages: { ids: number[]; total: number }[]): SharedPlateModelClient {
  const state = { calls: 0 };
  return {
    display: async () => {
      const page = pages[Math.min(state.calls, pages.length - 1)];
      state.calls += 1;
      return {
        List: (page?.ids ?? []).map(simpleModel),
        Total: page?.total ?? 0,
      };
    },
    displayMine: async () => [],
  } as unknown as SharedPlateModelClient;
}

interface HarnessOptions {
  pages?: { ids: number[]; total: number }[];
  sharedClient?: SharedPlateModelClient;
  v2Capabilities?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  const session = memoryStorage();
  const storage = memoryStorage();
  const shared =
    options.sharedClient ??
    fakeSharedClient(options.pages ?? [{ ids: [], total: 0 }]);
  const client = new Phase1BCloudClient({
    bootstrapPlatform: async () => {
      if (options.v2Capabilities === false) {
        throw new Error("V2 capability endpoint returned HTTP 404.");
      }
    },
    fetch: (async () =>
      new Response(JSON.stringify({ Code: 404, Message: "unused" }), {
        headers: { "content-type": "application/json" },
        status: 404,
      })) as unknown as typeof globalThis.fetch,
    sessionStorage: session,
    sharedPlateClient: shared,
    storage,
  });
  return { client, session, storage };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shared plate model pagination", () => {
  it("de-duplicates overlapping pages by row id", async () => {
    // Total says 4 rows, but pages 1 and 2 only ever expose rows 1, 2 and 3.
    const shared = fakeSharedClient([
      { ids: [1, 2], total: 4 },
      { ids: [2, 3], total: 4 },
      { ids: [], total: 4 },
    ]);
    const { client } = createHarness({ sharedClient: shared });
    await client.initialize();
    expect(
      client.snapshot.sharedPlateModels.map((model) => model.ID),
    ).toEqual([{ Value: 1 }, { Value: 2 }, { Value: 3 }]);
  });

  it("reports an early empty page as incomplete instead of ready", async () => {
    const shared = fakeSharedClient([
      { ids: [1, 2], total: 4 },
      { ids: [], total: 4 },
    ]);
    const { client } = createHarness({ sharedClient: shared });
    await client.initialize();
    expect(client.snapshot.sharedPlateModelsStatus).toBe("incomplete");
    expect(client.snapshot.sharedPlateModelsError).toMatch(/incomplete/);
  });

  it("reports an exhausted page guard as incomplete instead of ready", async () => {
    // One new row per page against a Total of 100: the 64-page guard runs out
    // long before the catalog is complete.
    const pages = Array.from({ length: 80 }, () => ({ ids: [1], total: 100 }));
    const shared = fakeSharedClient(pages);
    const { client } = createHarness({ sharedClient: shared });
    await client.initialize();
    expect(client.snapshot.sharedPlateModelsStatus).toBe("incomplete");
    expect(client.snapshot.sharedPlateModelsTotal).toBe(100);
  });

  it("reports ready once the de-duplicated rows reach Total", async () => {
    const shared = fakeSharedClient([
      { ids: [1, 2], total: 2 },
      { ids: [2, 3], total: 2 },
    ]);
    const { client } = createHarness({ sharedClient: shared });
    await client.initialize();
    expect(client.snapshot.sharedPlateModelsStatus).toBe("ready");
    expect(client.snapshot.sharedPlateModels.length).toBe(2);
  });
});

describe("sign-in rollback", () => {
  it("rolls the token back when the identity check fails after login", async () => {
    const { client, session } = createHarness({ v2Capabilities: false });
    await client.initialize();
    session.setItem(TOKEN_KEY, "previous-fixture-token");
    vi.spyOn(LoginInvoker, "Login").mockResolvedValue({
      Code: 200,
      Data: { Token: "new-fixture-token" },
      Message: "",
    } as never);
    const login = vi
      .spyOn(AccountInvoker, "Display")
      .mockResolvedValue({ Code: 500, Message: "display failed" });
    await expect(
      client.loginWithPassword("fixture-account", "fixture-password"),
    ).rejects.toThrow(/display failed/);
    login.mockRestore();
    // The old session is restored intact, not a new token beside an old identity.
    expect(session.getItem(TOKEN_KEY)).toBe("previous-fixture-token");
    expect(client.snapshot.account).toBeUndefined();
  });

  it("clears the session completely when there was no previous token", async () => {
    const { client, session } = createHarness({ v2Capabilities: false });
    vi.spyOn(LoginInvoker, "Login").mockResolvedValue({
      Code: 200,
      Data: { Token: "new-fixture-token" },
      Message: "",
    } as never);
    vi.spyOn(AccountInvoker, "Display").mockResolvedValue({
      Code: 500,
      Message: "display failed",
    });
    await expect(
      client.loginWithPassword("fixture-account", "fixture-password"),
    ).rejects.toThrow(/display failed/);
    expect(session.getItem(TOKEN_KEY)).toBeNull();
  });
});

describe("session restore", () => {
  it("clears the identity when a stored token is rejected", async () => {
    const { client, session } = createHarness({ v2Capabilities: false });
    session.setItem(TOKEN_KEY, "stale-fixture-token");
    session.setItem(
      "timemachine:web:phase1b-account",
      JSON.stringify({
        email: "stale@example.test",
        name: "Stale",
        tokenExpiresAt: "2030-01-01T00:00:00Z",
      }),
    );
    vi.spyOn(AccountInvoker, "Display").mockResolvedValue({
      Code: 401,
      Message: "token expired",
    });
    await client.initialize();
    expect(session.getItem(TOKEN_KEY)).toBeNull();
    expect(session.getItem("timemachine:web:phase1b-account")).toBeNull();
    expect(client.snapshot.account).toBeUndefined();
    expect(client.snapshot.status).toBe("signed-out");
  });

  it("keeps the verified token when the V2 workspace refresh fails", async () => {
    const { client, session } = createHarness({ v2Capabilities: true });
    session.setItem(TOKEN_KEY, "valid-fixture-token");
    vi.spyOn(AccountInvoker, "Display").mockResolvedValue({
      Code: 200,
      Data: {
        Email: "fixture@example.test",
        Name: "Fixture",
        TokenExpireTime: new Date("2030-01-01T00:00:00Z"),
      },
      Message: "",
    } as never);
    vi.spyOn(
      TimeMachineWorkspaceInvoker,
      "DisplayPlateModelVersions",
    ).mockResolvedValue({ Code: 500, Message: "workspace 500" });
    await client.initialize();
    expect(session.getItem(TOKEN_KEY)).toBe("valid-fixture-token");
    expect(client.snapshot.status).toBe("signed-in");
    expect(client.snapshot.account?.email).toBe("fixture@example.test");
    expect(client.snapshot.message).toMatch(/could not be refreshed/);
  });
});

describe("openProject", () => {
  function revisionWith(document: unknown): ProjectRevisionRO {
    return {
      ContentHash: "hash",
      ID: { Value: 5 },
      Project: { Value: 1 },
      RevisionNumber: 3,
      DocumentJson: JSON.stringify(document),
    } as unknown as ProjectRevisionRO;
  }

  function stubRevision(document: unknown): void {
    vi.spyOn(TimeMachineWorkspaceInvoker, "GetProjectRevision").mockResolvedValue({
      Code: 200,
      Data: revisionWith(document),
    } as never);
  }

  function documentWith(sourceRef: string | undefined): unknown {
    return {
      SchemaVersion: 2,
      Name: "fixture",
      CurrentTimeMa: 100,
      LayerList: [
        { ID: 4, Name: "Plate model", Type: ProjectLayerType.PlateModel },
      ],
      LegacyExtensions:
        sourceRef === undefined ? {} : { "sourceRef:4": sourceRef },
    };
  }

  it("restores the V1 model the project used and drops the old selection", async () => {
    const { client, storage } = createHarness({ v2Capabilities: true });
    vi.spyOn(AccountInvoker, "Display").mockResolvedValue({
      Code: 200,
      Data: {
        Email: "fixture@example.test",
        Name: "Fixture",
        TokenExpireTime: new Date("2030-01-01T00:00:00Z"),
      },
      Message: "",
    } as never);
    await client.initialize();
    stubRevision(documentWith("resource:plate-model:42"));
    // A previously selected shared model must not survive the open.
    client.selectSharedPlateModel(7);
    await client.openProject({ Revision: { Value: 5 } } as never);
    expect(client.snapshot.selection.plateModelId).toBe(42);
    expect(client.snapshot.selection.plateModelVersionId).toBe(0);
    expect(client.snapshot.selection.useLocalPlateModelDemo).toBe(false);
    expect(storage.getItem("timemachine:web:phase1b-cloud-reference")).toBeTruthy();
  });

  it("restores a V2 version and clears the V1 id", async () => {
    const { client } = createHarness({ v2Capabilities: true });
    vi.spyOn(AccountInvoker, "Display").mockResolvedValue({
      Code: 200,
      Data: {
        Email: "fixture@example.test",
        Name: "Fixture",
        TokenExpireTime: new Date("2030-01-01T00:00:00Z"),
      },
      Message: "",
    } as never);
    await client.initialize();
    client.selectSharedPlateModel(7);
    stubRevision(documentWith("resource:plate-model-version:9"));
    await client.openProject({ Revision: { Value: 5 } } as never);
    expect(client.snapshot.selection.plateModelVersionId).toBe(9);
    expect(client.snapshot.selection.plateModelId).toBe(0);
  });

  it("clears the selection when the project has no plate model source", async () => {
    const { client } = createHarness({ v2Capabilities: true });
    vi.spyOn(AccountInvoker, "Display").mockResolvedValue({
      Code: 200,
      Data: {
        Email: "fixture@example.test",
        Name: "Fixture",
        TokenExpireTime: new Date("2030-01-01T00:00:00Z"),
      },
      Message: "",
    } as never);
    await client.initialize();
    client.selectSharedPlateModel(7);
    stubRevision(documentWith(undefined));
    await client.openProject({ Revision: { Value: 5 } } as never);
    expect(client.snapshot.selection).toEqual({
      datasetVersionId: 0,
      plateModelId: 0,
      plateModelVersionId: 0,
      useLocalPlateModelDemo: false,
    });
  });
});

describe("accountPasswordDigest", () => {
  it("matches the SHA-256 digest the Server stores for a fixed input", async () => {
    const { GetPassword } = await import(
      "../../DPlanet/TypeScript/src/utils/encrypt"
    );
    const account = "fixture-account";
    const password = "fixture-password";
    const expected = createHash("sha256")
      .update(`${account}${password}DPlanet-456852`)
      .digest("hex");
    const digest = await GetPassword(account, password);
    expect(digest).toBe(expected);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
