import { afterEach, describe, expect, it, vi } from "vitest";

import { createHash } from "node:crypto";

import {
  AccountInvoker,
  LoginInvoker,
  LogoutInvoker,
  TimeMachineWorkspaceInvoker,
  type PlateModelSimpleRO,
  type ProjectRevisionRO,
  type ProjectDocumentV2TO,
} from "@timemachine/generated-api";

import { Phase1BCloudClient } from "../phase1b/cloud-client";
import { SharedPlateModelClient } from "../plate-model/shared-plate-client";
import { TIME_MACHINE_ACCESS_TOKEN_KEY } from "../platform-bootstrap";
import { RPCRequestError, RPCInvoker, RPCUploadStream } from "@timemachine/api-client";
import { agentActions } from "../agent-actions/registry";
import { ProjectSession } from "../project/project-session";
import { LOCAL_PROJECT_DRAFT_KEY, commitOpenedProject, readProjectCloudContext, type ProjectCloudContext } from "../project/project-cloud-context";

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
  storage?: StorageLike;
}

function createHarness(options: HarnessOptions = {}) {
  const session = memoryStorage();
  const storage = options.storage ?? memoryStorage();
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
  it.each(["timeout", "network-error", "cancelled"] as const)("keeps stored credentials unconfirmed after %s instead of deleting a valid session", async kind => {
    const { client, session } = createHarness();
    session.setItem(TOKEN_KEY, "valid-fixture-token");
    const cached = JSON.stringify({ name: "Fixture", email: "fixture@example.test", tokenExpiresAt: "" });
    session.setItem("timemachine:web:phase1b-account", cached);
    vi.spyOn(AccountInvoker, "Display").mockRejectedValue(new RPCRequestError(kind, "fixture-request", "/Account/Display"));
    await client.initialize();
    expect(session.getItem(TOKEN_KEY)).toBe("valid-fixture-token");
    expect(session.getItem("timemachine:web:phase1b-account")).toBe(cached);
    expect(client.snapshot.account).toBeUndefined();
    expect(client.snapshot.status).toBe("error");
  });

  it("does not treat a temporary Account business error as rejected credentials", async () => {
    const { client, session } = createHarness();
    session.setItem(TOKEN_KEY, "valid-fixture-token");
    vi.spyOn(AccountInvoker, "Display").mockResolvedValue({ Code: 500, Message: "temporary fixture failure" });
    await client.initialize();
    expect(session.getItem(TOKEN_KEY)).toBe("valid-fixture-token");
    expect(client.snapshot.status).toBe("error");
    expect(client.snapshot.account).toBeUndefined();
  });

  it("keeps local request diagnostics after cloud initialization reconfigures the shared invoker", async () => {
    const { client } = createHarness();
    await client.initialize();
    agentActions.diagnostics.clear();
    await RPCInvoker.Request("POST", "Fixture", "Read", new RPCUploadStream({ context: { traceId: "fixture-trace", actionId: "fixture.read" } })).catch(() => {});
    const entries = agentActions.diagnostics.query({ traceId: "fixture-trace" }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ category: "rpc", event: "rpc.completed", actionId: "fixture.read", safeDetails: { transportOutcome: "http-error", httpStatus: 404 } });
    expect(entries[0]?.requestId).toEqual(expect.any(String));
  });

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
  function prepareDraft(document: ProjectDocumentV2TO): string {
    const storage = memoryStorage();
    ProjectSession.fromDocument(document).save(storage);
    return storage.getItem(LOCAL_PROJECT_DRAFT_KEY)!;
  }
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
    const document = new ProjectSession("fixture").toDocument();
    document.CurrentTimeMa = 100;
    const extensions = Object.fromEntries(document.LegacyExtensions);
    if (sourceRef === undefined) delete extensions["sourceRef:4"];
    else extensions["sourceRef:4"] = sourceRef;
    return { ...document, LegacyExtensions: extensions };
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
    await client.openProject({ Revision: { Value: 5 } } as never, prepareDraft);
    expect(client.snapshot.selection.plateModelId).toBe(42);
    expect(client.snapshot.selection.plateModelVersionId).toBe(0);
    expect(client.snapshot.selection.useLocalPlateModelDemo).toBe(false);
    expect(readProjectCloudContext(storage)?.reference).toMatchObject({ projectId: 1, revisionId: 5 });
    expect(storage.getItem("timemachine:web:phase1b-cloud-reference")).toBeNull();
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
    await client.openProject({ Revision: { Value: 5 } } as never, prepareDraft);
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
    await client.openProject({ Revision: { Value: 5 } } as never, prepareDraft);
    expect(client.snapshot.selection).toEqual({
      datasetVersionId: 0,
      plateModelId: 0,
      plateModelVersionId: 0,
      useLocalPlateModelDemo: false,
    });
  });
});

describe("cloud project context ownership", () => {
  const reference = { accountEmail: "fixture@example.test", contentHash: "hash-1", projectId: 7, revisionId: 11, revisionNumber: 1 };
  const selection = { datasetVersionId: 0, plateModelId: 42, plateModelVersionId: 0, useLocalPlateModelDemo: false };
  const context = (contextId = "context-a"): ProjectCloudContext => ({ contextId, reference: { ...reference }, selection: { ...selection } });
  const document = () => new ProjectSession("Opened fixture").toDocument();
  const summary = { Revision: { Value: 12 } } as never;
  const prepareDraft = (value: ProjectDocumentV2TO): string => {
    const storage = memoryStorage();
    ProjectSession.fromDocument(value).save(storage);
    return storage.getItem(LOCAL_PROJECT_DRAFT_KEY)!;
  };
  const revision = (value = document()): ProjectRevisionRO => ({
    ContentHash: "hash-2", ID: { Value: 12 }, Project: { Value: 7 }, RevisionNumber: 2,
    DocumentJson: JSON.stringify(value),
  }) as unknown as ProjectRevisionRO;
  async function signedIn(storage?: StorageLike) {
    const harness = createHarness({ v2Capabilities: true, storage });
    harness.session.setItem(TOKEN_KEY, "fixture-token");
    vi.spyOn(AccountInvoker, "Display").mockResolvedValue({ Code: 200, Message: "", Data: {
      Email: "fixture@example.test", Name: "Fixture", TokenExpireTime: new Date("2030-01-01T00:00:00Z"),
    } } as never);
    await harness.client.initialize();
    vi.spyOn(harness.client, "refreshWorkspace").mockImplementation(async () => harness.client.snapshot);
    return harness;
  }
  function storeContext(storage: StorageLike, value = context(), name = "Current fixture") {
    const draft = new ProjectSession(name);
    draft.save(storage);
    commitOpenedProject(storage, storage.getItem(LOCAL_PROJECT_DRAFT_KEY)!, value);
  }

  it("leaves every stored value and selection unchanged when main rejects the document", async () => {
    const { client, storage } = await signedIn();
    client.selectSharedPlateModel(42);
    storage.setItem("timemachine:web:phase1b-cloud-reference", JSON.stringify(reference));
    new ProjectSession("Keep draft").save(storage);
    const before = [LOCAL_PROJECT_DRAFT_KEY, "timemachine:web:phase1b-cloud-reference", "timemachine:web:phase1b-resource-selection"].map(key => storage.getItem(key));
    vi.spyOn(TimeMachineWorkspaceInvoker, "GetProjectRevision").mockResolvedValue({ Code: 200, Data: revision(), Message: "" } as never);
    const write = vi.spyOn(storage, "setItem");
    await expect(client.openProject(summary, () => { throw new Error("Readonly compatibility report"); })).rejects.toThrow(/Readonly/);
    expect(write).not.toHaveBeenCalled(); expect(client.snapshot.selection).toEqual(selection);
    expect([LOCAL_PROJECT_DRAFT_KEY, "timemachine:web:phase1b-cloud-reference", "timemachine:web:phase1b-resource-selection"].map(key => storage.getItem(key))).toEqual(before);
  });

  it("reports quota failure without changing the old project or publishing the new selection", async () => {
    const { client, storage } = await signedIn();
    client.selectSharedPlateModel(42); new ProjectSession("Keep draft").save(storage);
    const before = storage.getItem(LOCAL_PROJECT_DRAFT_KEY);
    vi.spyOn(TimeMachineWorkspaceInvoker, "GetProjectRevision").mockResolvedValue({ Code: 200, Data: revision(), Message: "" } as never);
    vi.spyOn(storage, "setItem").mockImplementation(() => { throw new DOMException("Fixture quota failure", "QuotaExceededError"); });
    await expect(client.openProject(summary, prepareDraft)).rejects.toThrow(/quota/);
    expect(storage.getItem(LOCAL_PROJECT_DRAFT_KEY)).toBe(before);
    expect(client.snapshot.selection).toEqual(selection); expect(client.snapshot.projectContextError).toMatch(/quota/);
  });

  it("publishes only the atomic committed context and retains cloud compatibility data", async () => {
    const { client, storage } = await signedIn();
    const source = document(); source.Description = "Preserve cloud description";
    const original = `  \n${JSON.stringify(source, null, 2)}\n`;
    vi.spyOn(TimeMachineWorkspaceInvoker, "GetProjectRevision").mockResolvedValue({ Code: 200, Data: { ...revision(source), DocumentJson: original }, Message: "" } as never);
    const write = vi.spyOn(storage, "setItem");
    const prepare = vi.fn((value: ProjectDocumentV2TO, _original: string) => prepareDraft(value));
    const result = await client.openProject(summary, prepare);
    expect(prepare.mock.calls[0]?.[1]).toBe(original);
    expect(write).toHaveBeenCalledTimes(1); expect(write.mock.calls[0]?.[0]).toBe(LOCAL_PROJECT_DRAFT_KEY);
    expect(readProjectCloudContext(storage)).toMatchObject({ contextId: result.contextId, reference: { accountEmail: "fixture@example.test", projectId: 7, revisionId: 12 } });
    expect(JSON.parse(storage.getItem(LOCAL_PROJECT_DRAFT_KEY)!)).toMatchObject({ cloudDocument: { Description: "Preserve cloud description" } });
    expect(client.snapshot.cloudReference).toEqual(result.reference); expect(client.snapshot.projectContextError).toBeUndefined();
  });

  it("uses the context selection/reference at startup and never parses stale legacy values", async () => {
    const storage = memoryStorage(); storeContext(storage);
    storage.setItem("timemachine:web:phase1b-cloud-reference", "corrupt legacy reference");
    storage.setItem("timemachine:web:phase1b-resource-selection", "corrupt legacy selection");
    const { client } = await signedIn(storage);
    expect(client.snapshot.selection).toEqual(selection); expect(client.getCloudReference()).toEqual(reference);
    const write = vi.spyOn(storage, "setItem");
    client.selectDataset(9);
    expect(readProjectCloudContext(storage)?.selection.datasetVersionId).toBe(9);
    client.clearCloudReference();
    expect(readProjectCloudContext(storage)?.reference).toBeUndefined(); expect(client.getCloudReference()).toBeUndefined();
    expect(client.snapshot.cloudReference).toBeUndefined();
    expect(write.mock.calls.every(([key]) => key === LOCAL_PROJECT_DRAFT_KEY)).toBe(true);
    expect(storage.getItem("timemachine:web:phase1b-cloud-reference")).toBe("corrupt legacy reference");
  });

  it("exposes an invalid context and preserves it instead of loading the legacy cloud reference", async () => {
    const storage = memoryStorage(); storage.setItem(LOCAL_PROJECT_DRAFT_KEY, '{"schemaVersion":2,"cloudContext":null}');
    storage.setItem("timemachine:web:phase1b-cloud-reference", JSON.stringify(reference));
    const { client } = createHarness({ v2Capabilities: true, storage });
    await expect(client.initialize()).rejects.toThrow(/context is invalid/);
    expect(client.snapshot.projectContextError).toMatch(/context is invalid/); expect(client.snapshot.cloudReference).toBeUndefined();
    expect(() => client.getCloudReference()).toThrow(/context is invalid/);
    expect(storage.getItem(LOCAL_PROJECT_DRAFT_KEY)).toBe('{"schemaVersion":2,"cloudContext":null}');
  });

  it("rejects overlapping open/save operations without a second RPC or partial selection", async () => {
    const { client, storage } = await signedIn();
    let finish!: (result: never) => void;
    const read = vi.spyOn(TimeMachineWorkspaceInvoker, "GetProjectRevision").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const save = vi.spyOn(TimeMachineWorkspaceInvoker, "SaveProject"), create = vi.spyOn(TimeMachineWorkspaceInvoker, "CreateProject");
    const opening = client.openProject(summary, prepareDraft);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await expect(client.openProject(summary, prepareDraft)).rejects.toThrow(/already being opened or saved/);
    await expect(client.saveProject(document())).rejects.toThrow(/already being opened or saved/);
    expect(() => client.selectSharedPlateModel(9)).toThrow(/finish opening/);
    expect(save).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(storage.getItem(LOCAL_PROJECT_DRAFT_KEY)).toBeNull();
    finish({ Code: 200, Data: revision(), Message: "" } as never); await opening;
  });

  it("does not commit a delayed open after logout changes identity", async () => {
    const { client, storage } = await signedIn();
    let finish!: (result: never) => void;
    const read = vi.spyOn(TimeMachineWorkspaceInvoker, "GetProjectRevision").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    vi.spyOn(LogoutInvoker, "Logout").mockResolvedValue({ Code: 200, Message: "" } as never);
    const prepare = vi.fn(prepareDraft), opening = client.openProject(summary, prepare);
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    await client.logout(); finish({ Code: 200, Data: revision(), Message: "" } as never);
    await expect(opening).rejects.toMatchObject({ reason: "superseded" });
    expect(prepare).not.toHaveBeenCalled(); expect(storage.getItem(LOCAL_PROJECT_DRAFT_KEY)).toBeNull();
    expect(client.snapshot.account).toBeUndefined(); expect(client.snapshot.cloudReference).toBeUndefined();
  });

  it("keeps a pending save bound to its original reference and preserves newer local edits", async () => {
    const storage = memoryStorage(); storeContext(storage);
    const { client } = await signedIn(storage);
    let finish!: (result: never) => void;
    const save = vi.spyOn(TimeMachineWorkspaceInvoker, "SaveProject").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const source = document(), before = structuredClone(source), saving = client.saveProject(source);
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]?.[0].Value).toBe(7); expect(save.mock.calls[0]?.[1].Value).toBe(11);
    const stored = JSON.parse(storage.getItem(LOCAL_PROJECT_DRAFT_KEY)!); stored.currentTimeMa = 110;
    storage.setItem(LOCAL_PROJECT_DRAFT_KEY, JSON.stringify(stored)); client.selectDataset(9);
    finish({ Code: 200, Data: { Conflict: false, Revision: revision() }, Message: "" } as never);
    expect(await saving).toMatchObject({ revisionId: 12, revisionNumber: 2 });
    expect(JSON.parse(storage.getItem(LOCAL_PROJECT_DRAFT_KEY)!)).toMatchObject({ currentTimeMa: 110, cloudContext: { selection: { datasetVersionId: 9 }, reference: { revisionId: 12 } } });
    expect(source).toEqual(before);
  });

  it("does not let a late save replace another project context", async () => {
    const storage = memoryStorage(); storeContext(storage);
    const { client } = await signedIn(storage);
    let finish!: (result: never) => void;
    const save = vi.spyOn(TimeMachineWorkspaceInvoker, "SaveProject").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const saving = client.saveProject(document());
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    commitOpenedProject(storage, prepareDraft(document()), context("context-b"));
    const committed = storage.getItem(LOCAL_PROJECT_DRAFT_KEY);
    finish({ Code: 200, Data: { Conflict: false, Revision: revision() }, Message: "" } as never);
    await expect(saving).rejects.toMatchObject({ reason: "superseded" });
    expect(storage.getItem(LOCAL_PROJECT_DRAFT_KEY)).toBe(committed);
  });

  it("keeps the saved revision out of a signed-out context when logout happens during SaveProject", async () => {
    const storage = memoryStorage(); storeContext(storage);
    const { client } = await signedIn(storage);
    let finish!: (result: never) => void;
    const save = vi.spyOn(TimeMachineWorkspaceInvoker, "SaveProject").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    vi.spyOn(LogoutInvoker, "Logout").mockResolvedValue({ Code: 200, Message: "" } as never);
    const saving = client.saveProject(document());
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    await client.logout(); const signedOutDraft = storage.getItem(LOCAL_PROJECT_DRAFT_KEY);
    finish({ Code: 200, Data: { Conflict: false, Revision: revision() }, Message: "" } as never);
    await expect(saving).rejects.toMatchObject({ reason: "superseded" });
    expect(storage.getItem(LOCAL_PROJECT_DRAFT_KEY)).toBe(signedOutDraft);
    expect(readProjectCloudContext(storage)?.reference).toBeUndefined(); expect(client.snapshot.account).toBeUndefined();
  });

  it("reports local reference persistence failure after a remote save without retrying the remote request", async () => {
    const storage = memoryStorage(); storeContext(storage);
    const { client } = await signedIn(storage);
    const save = vi.spyOn(TimeMachineWorkspaceInvoker, "SaveProject").mockResolvedValue({ Code: 200, Data: { Conflict: false, Revision: revision() }, Message: "" } as never);
    const before = storage.getItem(LOCAL_PROJECT_DRAFT_KEY);
    vi.spyOn(storage, "setItem").mockImplementation(() => { throw new DOMException("Fixture quota failure", "QuotaExceededError"); });
    await expect(client.saveProject(document())).rejects.toMatchObject({ name: "CloudProjectSaveError", phase: "local-reference", reference: { revisionId: 12 } });
    await expect(client.saveProject(document())).rejects.toThrow(/was saved.*open the cloud project/);
    expect(save).toHaveBeenCalledTimes(1); expect(storage.getItem(LOCAL_PROJECT_DRAFT_KEY)).toBe(before);
    expect(client.snapshot.projectContextError).toMatch(/quota/);
  });

  it("blocks duplicate CreateProject after its reference write fails and recovers by explicitly opening that revision", async () => {
    const { client, storage } = await signedIn();
    const create = vi.spyOn(TimeMachineWorkspaceInvoker, "CreateProject").mockResolvedValue({ Code: 200, Data: revision(), Message: "" } as never);
    const write = vi.spyOn(storage, "setItem").mockImplementation(() => { throw new DOMException("Fixture quota failure", "QuotaExceededError"); });
    await expect(client.saveProject(document())).rejects.toMatchObject({ phase: "local-reference", reference: { projectId: 7, revisionId: 12 } });
    await expect(client.saveProject(document())).rejects.toThrow(/open the cloud project/); expect(create).toHaveBeenCalledTimes(1);
    write.mockRestore();
    vi.spyOn(TimeMachineWorkspaceInvoker, "GetProjectRevision").mockResolvedValue({ Code: 200, Data: revision(), Message: "" } as never);
    await client.openProject(summary, prepareDraft);
    expect(client.snapshot.projectContextError).toBeUndefined(); expect(client.getCloudReference()?.revisionId).toBe(12);
    const save = vi.spyOn(TimeMachineWorkspaceInvoker, "SaveProject").mockResolvedValue({ Code: 200, Data: { Conflict: false, Revision: revision() }, Message: "" } as never);
    await client.saveProject(document()); expect(save).toHaveBeenCalledTimes(1); expect(create).toHaveBeenCalledTimes(1);
  });

  it("reports a failed post-save catalog refresh with the confirmed remote revision", async () => {
    const storage = memoryStorage(); storeContext(storage);
    const { client } = await signedIn(storage);
    vi.spyOn(TimeMachineWorkspaceInvoker, "SaveProject").mockResolvedValue({ Code: 200, Data: { Conflict: false, Revision: revision() }, Message: "" } as never);
    vi.mocked(client.refreshWorkspace).mockRejectedValueOnce(new Error("Fixture workspace refresh failure"));
    await expect(client.saveProject(document())).rejects.toMatchObject({ name: "CloudProjectSaveError", phase: "workspace-refresh", reference: { revisionId: 12 } });
    expect(readProjectCloudContext(storage)?.reference?.revisionId).toBe(12); expect(client.snapshot.cloudReference?.revisionId).toBe(12);
  });

  it("retains the explicit legacy create path without inventing a context identity", async () => {
    const { client, storage } = await signedIn();
    new ProjectSession("Legacy local").save(storage);
    const before = storage.getItem(LOCAL_PROJECT_DRAFT_KEY);
    vi.spyOn(TimeMachineWorkspaceInvoker, "CreateProject").mockResolvedValue({ Code: 200, Data: revision(), Message: "" } as never);
    expect(await client.saveProject(document())).toMatchObject({ revisionId: 12 });
    expect(storage.getItem(LOCAL_PROJECT_DRAFT_KEY)).toBe(before); expect(readProjectCloudContext(storage)).toBeUndefined();
    expect(JSON.parse(storage.getItem("timemachine:web:phase1b-cloud-reference")!)).toMatchObject({ revisionId: 12, accountEmail: "fixture@example.test" });
  });

  it("preserves Unity Version and a sparse unedited DTO in the actual CreateProject request", async () => {
    const { client } = await signedIn();
    const create = vi.spyOn(TimeMachineWorkspaceInvoker, "CreateProject").mockResolvedValue({ Code: 200, Data: revision(), Message: "" } as never);
    const source = { Name: "Sparse Unity project", Version: "Unity release 7", Description: "Keep this" } as ProjectDocumentV2TO;
    await client.saveProject(source);
    expect(create.mock.calls[0]?.[0]).toEqual(source);
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("PlateModelVersion");
    expect(source.Version).toBe("Unity release 7");
  });

  it("updates only the selected plate-model foreign key while retaining metadata and the caller's sparse DTO", async () => {
    const { client } = await signedIn(); client.selectPlateModel(9);
    const create = vi.spyOn(TimeMachineWorkspaceInvoker, "CreateProject").mockResolvedValue({ Code: 200, Data: revision(), Message: "" } as never);
    const source = { Name: "Sparse Unity project", Version: "Unity release 7" } as ProjectDocumentV2TO;
    await client.saveProject(source);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ Name: source.Name, Version: source.Version, PlateModelVersion: { Value: 9 } });
    expect(source).not.toHaveProperty("PlateModelVersion");
  });

  it("rejects saving a different account's reference instead of silently creating a project", async () => {
    const storage = memoryStorage(); const other = context(); other.reference!.accountEmail = "different@example.test"; storeContext(storage, other);
    const { client } = await signedIn(storage);
    const save = vi.spyOn(TimeMachineWorkspaceInvoker, "SaveProject"), create = vi.spyOn(TimeMachineWorkspaceInvoker, "CreateProject");
    await expect(client.saveProject(document())).rejects.toThrow(/different account/);
    expect(save).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(readProjectCloudContext(storage)?.reference).toEqual(other.reference);
  });

  it("clears the authenticated session even if logout cannot persist reference removal", async () => {
    const storage = memoryStorage(); storeContext(storage);
    const { client, session } = await signedIn(storage);
    vi.spyOn(LogoutInvoker, "Logout").mockResolvedValue({ Code: 200, Message: "" } as never);
    vi.spyOn(storage, "setItem").mockImplementation(() => { throw new Error("Fixture storage disabled"); });
    await expect(client.logout()).rejects.toThrow(/storage disabled/);
    expect(client.snapshot.account).toBeUndefined(); expect(client.snapshot.status).toBe("signed-out");
    expect(session.getItem(TOKEN_KEY)).toBeNull(); expect(client.snapshot.projectContextError).toMatch(/storage disabled/);
  });
});

describe("accountPasswordDigest", () => {
  it("matches the SHA-256 digest the Server stores for a fixed input", async () => {
    const { GetPassword } = await import(
      "@timemachine/generated-api"
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
