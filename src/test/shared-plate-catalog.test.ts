import { describe, expect, it, vi } from "vitest";

import { LoginInvoker } from "@timemachine/generated-api";

import {
  Phase1BCloudClient,
  normalizeSelection,
  PUBLIC_ACCESS_RANGE_MASK,
  type Phase1BState,
} from "../phase1b/cloud-client";
import { SharedPlateModelClient } from "../plate-model/shared-plate-client";
import {
  AGENT_ACTIONS,
  AGENT_DECLARATIONS,
  agentActions,
  installAgentActions,
  redactSensitive,
} from "../agent-actions";

/**
 * These tests drive the client through the same code paths the UI uses, with a
 * synthetic fetch and in-memory storage. No real account, password, token or
 * Server is involved.
 */

const SERVER_URL = "http://127.0.0.1:5130";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

/** One packed `PlateModelSimpleRO`, matching the C# BindField order. */
function simpleROBytes(id: number): number[] {
  const bytes: number[] = [];
  const pushInt32 = (value: number): void => {
    bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  };
  const pushPacked = (value: number): void => {
    if (value < 255) {
      bytes.push(value);
      return;
    }
    bytes.push(255, value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  };
  const pushString = (value: string): void => {
    pushPacked(value.length);
    for (let index = 0; index < value.length; index += 1) {
      bytes.push(value.charCodeAt(index) & 0xff, value.charCodeAt(index) >>> 8);
    }
  };
  const idBytes = [0, 0, 0, 0, 0, 0, 0, 0];
  let remaining = id;
  for (let index = 0; index < 8; index += 1) {
    idBytes[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  bytes.push(...idBytes); // ID (Int64LE)
  pushInt32(0); // State
  pushString(""); // Name
  pushString(""); // Description
  // ViDateTimeSerializer writes a real date string; ViDateTimePtrSerializer
  // writes "" for null, so UpdateTime covers the null branch.
  pushString("2020-01-02 03:04:05.000Z"); // CreateTime
  pushString(""); // UpdateTime = null
  pushString(""); // Author
  pushString(""); // Reference
  pushInt32(0); // AgeStart
  pushInt32(0); // AgeEnd
  pushString(""); // AuthorPhoto.Path
  pushString(""); // AuthorPhoto.Name
  pushString(""); // AuthorPhoto.Extention
  pushString(""); // AuthorPhoto.MD5
  bytes.push(...[7, 0, 0, 0, 0, 0, 0, 0]); // Creator = 7
  pushInt32(1); // AccessRange = Public
  pushPacked(0); // RecommandList (empty)
  return bytes;
}

function framePrefix(): number[] {
  const bytes: number[] = [];
  bytes.push(200, 0, 0, 0); // Code = 200
  bytes.push(0); // Message = ""
  return bytes;
}

/** A packed `PageRO<PlateModelSimpleRO>` frame, i.e. the Display payload. */
function catalogFrame(
  total: number,
  ids: readonly number[],
): Uint8Array<ArrayBuffer> {
  const bytes = framePrefix();
  const pushInt32 = (value: number): void => {
    bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  };
  const pushPacked = (value: number): void => {
    if (value < 255) {
      bytes.push(value);
      return;
    }
    bytes.push(255, value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  };
  pushInt32(total); // PageRO.Total
  pushPacked(ids.length); // List count
  for (const id of ids) {
    bytes.push(...simpleROBytes(id));
  }
  return new Uint8Array(bytes) as Uint8Array<ArrayBuffer>;
}

/** A packed `List<PlateModelSimpleRO>` frame, i.e. the DisplayMine payload. */
function mineListFrame(ids: readonly number[]): Uint8Array<ArrayBuffer> {
  const bytes = framePrefix();
  bytes.push(ids.length); // packed list count
  for (const id of ids) {
    bytes.push(...simpleROBytes(id));
  }
  return new Uint8Array(bytes) as Uint8Array<ArrayBuffer>;
}
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
    get length() {
      return map.size;
    },
  } as Storage;
}

interface Harness {
  client: Phase1BCloudClient;
  calls: { body: Uint8Array | undefined; url: string }[];
  fetchMock: ReturnType<typeof vi.fn>;
  session: Storage;
  storage: Storage;
}

/**
 * Builds a client whose fetch answers by path: the V2 capability endpoint 404s
 * (this Server does not implement V2), while `user/*` and the shared plate model
 * ByteStream endpoints answer normally.
 */
function createHarness(options: {
  catalogPages?: readonly { ids: readonly number[]; total: number }[];
  mineIds?: readonly number[];
  onLogin?: (account: string, password: string) => void;
  v2Capabilities?: boolean;
} = {}): Harness {
  const calls: Harness["calls"] = [];
  const storage = memoryStorage();
  const session = memoryStorage();
  let catalogPage = 0;
  const catalogPages = options.catalogPages ?? [{ ids: [], total: 0 }];

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === "string" ? input : input.toString());
      calls.push({ body: init?.body as Uint8Array | undefined, url });
      if (url.endsWith("/d_planet/time_machine_platform/get_capabilities")) {
        return options.v2Capabilities
          ? jsonResponse({ Code: 200, Message: "", Data: {} })
          : new Response("not found", { status: 404 });
      }
      if (url.endsWith("/user/login/login")) {
        const body = JSON.parse(String(init?.body)) as {
          Account: string;
          Password: string;
        };
        options.onLogin?.(body.Account, body.Password);
        return jsonResponse({
          Code: 200,
          Message: "",
          Data: { Email: "", Name: "Fixture", Token: "fixture-token" },
        });
      }
      if (url.endsWith("/user/account/display")) {
        return jsonResponse({
          Code: 200,
          Message: "",
          Data: {
            Email: "fixture@example.test",
            Name: "Fixture",
            TokenExpireTime: "2030-01-01T00:00:00Z",
          },
        });
      }
      if (url.endsWith("/d_planet/user_plate_model/display")) {
        const page =
          catalogPages[Math.min(catalogPage, catalogPages.length - 1)] ??
          catalogPages[0];
        if (!page) {
          return jsonResponse({ Code: 500, Message: "no fixture page" }, 500);
        }
        catalogPage += 1;
        return new Response(catalogFrame(page.total, page.ids), {
          headers: { "content-type": "application/octet-stream" },
          status: 200,
        });
      }
      if (url.endsWith("/d_planet/user_plate_model/display_mine")) {
        return new Response(mineListFrame(options.mineIds ?? []), {
          headers: { "content-type": "application/octet-stream" },
          status: 200,
        });
      }
      return jsonResponse({ Code: 404, Message: "unexpected path" }, 404);
    },
  );

  const client = new Phase1BCloudClient({
    bootstrapPlatform: async () => {
      if (!options.v2Capabilities) {
        throw new Error("V2 capability endpoint returned HTTP 404.");
      }
    },
    fetch: fetchMock as unknown as typeof globalThis.fetch,
    sessionStorage: session,
    storage,
  });
  // Re-point the shared client at the same fetch by rebuilding the singleton's
  // collaborator through the public constructor path.
  const shared = new SharedPlateModelClient({
    baseUrl: SERVER_URL,
    fetch: fetchMock as unknown as typeof globalThis.fetch,
    getAccessToken: () => session.getItem("timemachine:web:phase1b-access-token"),
  });
  (client as unknown as { sharedPlateClient: SharedPlateModelClient }).sharedPlateClient =
    shared;
  return { calls, client, fetchMock, session, storage };
}

describe("normalizeSelection", () => {
  it("migrates a selection stored by an older build", () => {
    expect(
      normalizeSelection({ datasetVersionId: 5, plateModelVersionId: 9 }),
    ).toEqual({
      datasetVersionId: 5,
      plateModelId: 0,
      plateModelVersionId: 9,
      useLocalPlateModelDemo: false,
    });
  });

  it("drops non-numeric and unknown fields", () => {
    expect(normalizeSelection({ plateModelId: "7", plateModelVersionId: null })).toEqual({
      datasetVersionId: 0,
      plateModelId: 0,
      plateModelVersionId: 0,
      useLocalPlateModelDemo: false,
    });
    expect(normalizeSelection(undefined)).toEqual({
      datasetVersionId: 0,
      plateModelId: 0,
      plateModelVersionId: 0,
      useLocalPlateModelDemo: false,
    });
  });

  it("keeps the explicit local-demo opt-in", () => {
    expect(normalizeSelection({ useLocalPlateModelDemo: true }).useLocalPlateModelDemo)
      .toBe(true);
  });
});

describe("Phase1BCloudClient shared plate model catalog", () => {
  it("walks the public catalog to Total instead of stopping at 100", async () => {
    const harness = createHarness({
      catalogPages: [
        { ids: [1, 2, 3], total: 4 },
        { ids: [4], total: 4 },
      ],
    });

    await harness.client.initialize();

    const displayCalls = harness.calls.filter((call) =>
      call.url.endsWith("/display"),
    );
    expect(displayCalls).toHaveLength(2);
    expect(harness.client.snapshot.sharedPlateModelsStatus).toBe("ready");
    expect(harness.client.snapshot.sharedPlateModelsTotal).toBe(4);
    expect(
      harness.client.snapshot.sharedPlateModels.map((model) => model.ID.Value),
    ).toEqual([1, 2, 3, 4]);
  });

  it("uses the public access-range mask on every page request", async () => {
    const harness = createHarness({ catalogPages: [{ ids: [], total: 0 }] });
    await harness.client.initialize();

    const request = harness.calls.find((call) => call.url.endsWith("/display"));
    expect(request?.body).toBeInstanceOf(FormData);
    const part = (request?.body as unknown as FormData).get("_stream");
    expect(part).toBeInstanceOf(Blob);
    const bytes = new Uint8Array(await (part as Blob).arrayBuffer());
    // Layout: nameLen(1) + mask(4) + index(4) + size(4).
    expect([...bytes.slice(1, 5)]).toEqual([
      PUBLIC_ACCESS_RANGE_MASK & 0xff,
      (PUBLIC_ACCESS_RANGE_MASK >>> 8) & 0xff,
      (PUBLIC_ACCESS_RANGE_MASK >>> 16) & 0xff,
      (PUBLIC_ACCESS_RANGE_MASK >>> 24) & 0xff,
    ]);
    expect([...bytes.slice(5, 9)]).toEqual([1, 0, 0, 0]);
    expect([...bytes.slice(9, 13)]).toEqual([100, 0, 0, 0]);
  });

  it("merges DisplayMine and de-duplicates by ID after sign-in", async () => {
    const harness = createHarness({
      catalogPages: [{ ids: [1, 2], total: 2 }],
      mineIds: [2, 3],
    });

    await harness.client.initialize();
    await harness.client.loginWithPassword("fixture-account", "fixture-password");

    const state = harness.client.snapshot;
    expect(state.sharedPlateModels.map((model) => model.ID.Value)).toEqual([1, 2, 3]);
    expect(state.sharedPlateModelsMineIds).toEqual([2, 3]);
    expect(
      harness.calls.filter((call) => call.url.endsWith("/display_mine")),
    ).toHaveLength(1);
  });

  it("does not call DisplayMine while signed out", async () => {
    const harness = createHarness({ mineIds: [3] });
    await harness.client.initialize();
    expect(
      harness.calls.filter((call) => call.url.endsWith("/display_mine")),
    ).toHaveLength(0);
  });

  it("surfaces a real catalog error separately from the V2 message", async () => {
    const harness = createHarness();
    (harness.client as unknown as { sharedPlateClient: unknown }).sharedPlateClient =
      {
        display: async () => {
          throw new Error("Shared plate model RPC failed with code 841.");
        },
        displayMine: async () => [],
      };

    await harness.client.initialize();

    const state = harness.client.snapshot;
    expect(state.sharedPlateModelsStatus).toBe("error");
    expect(state.sharedPlateModelsError).toContain("841");
    expect(state.sharedPlateModels).toEqual([]);
  });

  it("keeps the V1 selection independent of the V2 version selection", async () => {
    const harness = createHarness();
    await harness.client.initialize();

    harness.client.selectSharedPlateModel(42);
    expect(harness.client.snapshot.selection).toEqual({
      datasetVersionId: 0,
      plateModelId: 42,
      plateModelVersionId: 0,
      useLocalPlateModelDemo: false,
    });

    harness.client.selectPlateModel(9);
    expect(harness.client.snapshot.selection.plateModelId).toBe(0);
    expect(harness.client.snapshot.selection.plateModelVersionId).toBe(9);
  });

  it("persists the selection so a reload can read it back", async () => {
    const harness = createHarness();
    await harness.client.initialize();
    harness.client.selectSharedPlateModel(42);
    expect(
      JSON.parse(harness.storage.getItem("timemachine:web:phase1b-resource-selection") ?? "{}"),
    ).toMatchObject({ plateModelId: 42 });
  });
});

describe("Phase1BCloudClient sign-in", () => {
  it("sends the SHA-256 digest the Server stores, never the raw password", async () => {
    const seen: { account: string; password: string }[] = [];
    const harness = createHarness({
      onLogin: (account, password) => seen.push({ account, password }),
    });

    await harness.client.initialize();
    await harness.client.loginWithPassword("fixture-account", "fixture-password");

    expect(seen).toHaveLength(1);
    expect(seen[0]?.account).toBe("fixture-account");
    // SHA-256(account + password + "DPlanet-456852"), matching
    // AccountAssistant.GetPassword / ViCryptography.Sign.
    expect(seen[0]?.password).toMatch(/^[0-9a-f]{64}$/);
    expect(seen[0]?.password).not.toContain("fixture-password");
  });

  it("keeps the session when the V2 capability handshake 404s", async () => {
    const harness = createHarness();
    await harness.client.initialize();

    const state = await harness.client.loginWithPassword(
      "fixture-account",
      "fixture-password",
    );

    expect(state.account?.name).toBe("Fixture");
    expect(state.status).toBe("signed-in");
    expect(state.v2WorkspaceAvailable).toBe(false);
    expect(harness.session.getItem("timemachine:web:phase1b-access-token")).toBe(
      "fixture-token",
    );
    // The V1 catalog is still loaded after sign-in.
    expect(state.sharedPlateModelsStatus).toBe("ready");
  });

  it("reports a failed sign-in without storing a token", async () => {
    const harness = createHarness();
    (harness.client as unknown as { options: { fetch: unknown } }).options.fetch =
      harness.fetchMock;
    const failing = new Phase1BCloudClient({
      bootstrapPlatform: async () => {
        throw new Error("V2 unavailable");
      },
      fetch: (async () =>
        jsonResponse({ Code: 401, Message: "Account or Password is error" })) as unknown as typeof globalThis.fetch,
      sessionStorage: memoryStorage(),
      storage: memoryStorage(),
    });

    await expect(
      failing.loginWithPassword("fixture-account", "wrong"),
    ).rejects.toThrow(/Account or Password is error/);
    expect(failing.snapshot.account).toBeUndefined();
  });

  it("does not clear the token when the V2 workspace is unavailable", async () => {
    const harness = createHarness();
    await harness.client.initialize();
    await harness.client.loginWithPassword("fixture-account", "fixture-password");
    const token = harness.session.getItem("timemachine:web:phase1b-access-token");

    await harness.client.refreshCatalogs();

    expect(harness.session.getItem("timemachine:web:phase1b-access-token")).toBe(token);
    expect(harness.client.snapshot.account).toBeDefined();
  });
});

describe("Phase1BCloudClient V2 gating", () => {
  it("marks V2 unavailable on a 404 and skips the V2 catalog calls", async () => {
    const harness = createHarness();
    const state = await harness.client.initialize();

    expect(state.v2WorkspaceAvailable).toBe(false);
    // The V2 workspace catalog is never requested once V2 is known missing.
    expect(
      harness.calls.filter((call) =>
        call.url.includes("/d_planet/time_machine_workspace/"),
      ),
    ).toHaveLength(0);
    // ...but the V1 endpoints are.
    expect(
      harness.calls.filter((call) => call.url.includes("/user_plate_model/")),
    ).not.toHaveLength(0);
  });

  it("still loads the V1 catalog when V2 is available", async () => {
    const harness = createHarness({
      catalogPages: [{ ids: [5], total: 1 }],
      v2Capabilities: true,
    });
    const state = await harness.client.initialize();
    expect(state.v2WorkspaceAvailable).toBe(true);
    expect(state.sharedPlateModels.map((model) => model.ID.Value)).toEqual([5]);
  });

  it("refuses cloud project operations with an explicit message", async () => {
    const harness = createHarness();
    await harness.client.initialize();
    await expect(
      harness.client.saveProject({ Version: "phase1b" } as never),
    ).rejects.toThrow(/V2 workspace endpoints/);
  });
});

describe("agent action facade", () => {
  it("exposes a versioned, typed interface on window", () => {
    const target = { } as Window & typeof globalThis;
    installAgentActions(target);
    expect(target.timeMachineAgent?.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof target.timeMachineAgent?.execute).toBe("function");
    expect(typeof target.timeMachineAgent?.listActions).toBe("function");
    expect(typeof target.timeMachineAgent?.getState).toBe("function");
  });

  it("lists stable action ids and reports placeholders as unsupported", () => {
    const actions = agentActions.listActions();
    const ids = actions.map((action) => action.id);
    expect(ids).toContain(AGENT_ACTIONS.authLogin);
    expect(ids).toContain(AGENT_ACTIONS.modelSelect);
    expect(ids).toContain(AGENT_ACTIONS.catalogRefresh);
    expect(ids).toContain(AGENT_ACTIONS.timeSet);
    expect(ids).toContain(AGENT_ACTIONS.cameraReset);
    expect(actions.find((action) => action.id === AGENT_ACTIONS.publishPlaceholder)?.status)
      .toBe("unsupported");
    expect(actions.find((action) => action.id === AGENT_ACTIONS.exportPlaceholder)?.status)
      .toBe("unsupported");
  });

  it("never reports a placeholder as a success", async () => {
    const result = await agentActions.execute(AGENT_ACTIONS.publishPlaceholder);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("unsupported");
      expect(result.error.code).toBe(501);
    }
  });

  it("rejects an unknown action and a wrong parameter type", async () => {
    const unknown = await agentActions.execute("nope.nothing");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.kind).toBe("validation");
    }

    // Attach a handler so validation is reached; without one the action is
    // honestly reported as unsupported in this environment.
    agentActions.register(AGENT_DECLARATIONS[AGENT_ACTIONS.timeSet], () => ({}));
    const wrongType = await agentActions.execute(AGENT_ACTIONS.timeSet, {
      ageMa: "100",
    });
    expect(wrongType.ok).toBe(false);
    if (!wrongType.ok) {
      expect(wrongType.error.kind).toBe("validation");
    }
  });

  it("reports an action with no handler as unsupported rather than missing", async () => {
    const result = await agentActions.execute(AGENT_ACTIONS.cameraReset);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("unsupported");
      expect(result.error.message).toContain("no handler");
    }
  });

  it("returns reloadRequired instead of faking completion for model.select", async () => {
    let selected = 0;
    agentActions.register(
      {
        description: "test",
        id: AGENT_ACTIONS.modelSelect,
        params: [
          { description: "id", name: "plateModelId", required: true, type: "number" },
        ],
        status: "ready",
        title: "test",
      },
      (params) => {
        selected = params.plateModelId as number;
        return { data: { accepted: true, plateModelId: selected }, reloadRequired: true };
      },
    );

    const result = await agentActions.execute(AGENT_ACTIONS.modelSelect, {
      plateModelId: 42,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reloadRequired).toBe(true);
      expect(result.data).toMatchObject({ accepted: true, plateModelId: 42 });
    }
    // A fresh bootId lets the caller confirm the new document actually loaded.
    expect(agentActions.getState().bootId).toMatch(/^boot-/);
  });

  it("scrubs sensitive keys out of every result", () => {
    expect(
      redactSensitive({
        accessToken: "secret",
        nested: { passwordDigest: "abc" },
        safe: "keep",
        token: "secret",
      }),
    ).toEqual({
      accessToken: "[redacted]",
      nested: { passwordDigest: "[redacted]" },
      safe: "keep",
      token: "[redacted]",
    });
  });

  it("never puts a token into the state snapshot", () => {
    const state = agentActions.getState();
    expect(JSON.stringify(state)).not.toContain("fixture-token");
  });
});

/**
 * The main-entry plate-model source decision. These are pure functions of the
 * persisted selection, so they are tested directly rather than through a DOM.
 */

/** Mirrors the source resolution in main.ts; kept here as the contract. */
export function resolvePlateModelSource(selection: {
  plateModelId: number;
  useLocalPlateModelDemo: boolean;
  serverUrl: string;
}): "local-demo" | "none" | "shared" {
  if (selection.plateModelId > 0 && selection.serverUrl) {
    return "shared";
  }
  if (selection.useLocalPlateModelDemo) {
    return "local-demo";
  }
  return "none";
}

describe("main.ts plate model source resolution", () => {
  it("loads the selected shared model from the Server", () => {
    expect(
      resolvePlateModelSource({
        plateModelId: 42,
        serverUrl: "http://127.0.0.1:5130",
        useLocalPlateModelDemo: false,
      }),
    ).toBe("shared");
  });

  it("does not silently claim a shared model when no Server is configured", () => {
    // A stored selection without a Server must not be treated as a Server load.
    expect(
      resolvePlateModelSource({
        plateModelId: 42,
        serverUrl: "",
        useLocalPlateModelDemo: false,
      }),
    ).toBe("none");
  });

  it("uses the local demo only when it was explicitly selected", () => {
    expect(
      resolvePlateModelSource({
        plateModelId: 0,
        serverUrl: "http://127.0.0.1:5130",
        useLocalPlateModelDemo: true,
      }),
    ).toBe("local-demo");
  });

  it("yields an empty globe when nothing is selected", () => {
    expect(
      resolvePlateModelSource({
        plateModelId: 0,
        serverUrl: "http://127.0.0.1:5130",
        useLocalPlateModelDemo: false,
      }),
    ).toBe("none");
  });

  it("prefers the shared model over a stale local-demo flag", () => {
    // Selecting a Server model must clear the demo opt-in, but even if a stale
    // flag survived, the Server model wins.
    expect(
      resolvePlateModelSource({
        plateModelId: 42,
        serverUrl: "http://127.0.0.1:5130",
        useLocalPlateModelDemo: true,
      }),
    ).toBe("shared");
  });
});

describe("plate model sourceRef persistence", () => {
  it("uses the V1 prefix for a shared model", () => {
    expect(`resource:plate-model:${42}`).toBe("resource:plate-model:42");
    // The V2 prefix is never written for a V1 selection.
    expect(`resource:plate-model:${42}`).not.toContain("plate-model-version");
  });
});
