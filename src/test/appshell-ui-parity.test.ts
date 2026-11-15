// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import type { Phase1BState } from "../phase1b/cloud-client";
import type { ingestPointCsv } from "../phase3/ingest-client";
import type { AppEvent } from "../agent-actions/contracts";
import { agentActions, AGENT_ACTIONS } from "../agent-actions";
import { installAgentActions } from "../agent-actions/registry";
import { mountAppShell } from "./support/mount-app-shell";
import { ProjectSession, RUNTIME_LAYER_IDS } from "../project/project-session";
import { LAYER_GROUP_COLLAPSE_CHANGE_EVENT } from "../layers/layer-events";

const fixtures = vi.hoisted(() => ({
  state: undefined as Phase1BState | undefined,
  listeners: new Set<(state: Phase1BState) => void>(),
  login: vi.fn<(email: string, code: string) => Promise<Phase1BState>>(),
  loginWithPassword: vi.fn<(account: string, password: string) => Promise<Phase1BState>>(),
  ingest: vi.fn<typeof ingestPointCsv>(),
}));

vi.mock("../phase1b/cloud-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("../phase1b/cloud-client")>();
  return { ...original, phase1BCloudClient: {
    get snapshot() { return fixtures.state!; },
    initialize: async () => fixtures.state!,
    subscribe: (listener: (state: Phase1BState) => void) => {
      fixtures.listeners.add(listener);
      listener(fixtures.state!);
      return () => { fixtures.listeners.delete(listener); };
    },
    getCloudReference: () => undefined,
    login: fixtures.login,
    loginWithPassword: fixtures.loginWithPassword,
    refreshCatalogs: async () => fixtures.state!,
  } };
});

vi.mock("../phase3/ingest-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("../phase3/ingest-client")>(),
  ingestPointCsv: fixtures.ingest,
}));

function state(): Phase1BState {
  return {
    datasets: [], message: "", plateModels: [], plateModelCatalog: [], projects: [],
    selection: { datasetVersionId: 0, plateModelId: 0, plateModelVersionId: 0, useLocalPlateModelDemo: false },
    serverUrl: "/fixture-service", sharedPlateModels: [], sharedPlateModelsError: "",
    sharedPlateModelsMineIds: [], sharedPlateModelsStatus: "ready", sharedPlateModelsTotal: 0,
    status: "signed-out", v2WorkspaceAvailable: true,
  };
}

function signedIn(): void {
  fixtures.state!.account = { name: "Fixture user", email: "fixture@example.test", tokenExpiresAt: "" };
  fixtures.state!.status = "signed-in";
}

function ui(): Record<string, unknown> {
  return agentActions.getState().ui as Record<string, unknown>;
}

function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`Missing fixture control: ${selector}`);
  return found;
}

function input(selector: string, value: string): void {
  const field = element<HTMLInputElement>(selector);
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
  // StateEvents deliberately batches notifications in the next event-loop turn.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  fixtures.state = state();
  fixtures.listeners.clear();
  fixtures.login.mockReset();
  fixtures.loginWithPassword.mockReset();
  fixtures.ingest.mockReset();
});

describe("AppShell UI/API business parity", () => {
  it.each([
    ["account", "ui"], ["account", "api"],
    ["email-code", "ui"], ["email-code", "api"],
  ] as const)("clears sensitive input and busy after failed %s login via %s", async (mode, entry) => {
    const pending = deferred<Phase1BState>();
    (mode === "account" ? fixtures.loginWithPassword : fixtures.login).mockReturnValue(pending.promise);
    const mounted = await mountAppShell();
    try {
      await agentActions.execute(AGENT_ACTIONS.authDialogOpen);
      await agentActions.execute(AGENT_ACTIONS.authModeSet, { mode });
      await nextTick();
      const secretSelector = mode === "account" ? '[autocomplete="current-password"]' : '[autocomplete="one-time-code"]';
      input(mode === "account" ? '[autocomplete="username"]' : '[autocomplete="email"]', "fixture@example.test");
      input(secretSelector, "synthetic-private-input");
      await nextTick();
      const params = mode === "account"
        ? { mode, account: "fixture-account", password: "synthetic-private-input" }
        : { mode, email: "fixture@example.test", code: "synthetic-private-input" };
      const operation = entry === "api" ? agentActions.execute(AGENT_ACTIONS.authLogin, params) : undefined;
      if (entry === "ui") element<HTMLButtonElement>('.auth-dialog__submit').click();
      await nextTick();
      const during = ui();
      pending.reject(new Error("Synthetic login refused: synthetic-private-input"));
      if (operation) {
        const result = await operation;
        expect(result).toMatchObject({ ok: false });
        expect(JSON.stringify(result)).not.toContain("synthetic-private-input");
      }
      await settle();
      expect(during.busy).toBe(true);
      expect(ui()).toMatchObject({ busy: false, authDialogOpen: true });
      expect(element<HTMLInputElement>(secretSelector).value).toBe("");
      expect(document.body.textContent).not.toContain("synthetic-private-input");
      expect(JSON.stringify(agentActions.getState())).not.toContain("synthetic-private-input");
    } finally { mounted.unmount(); }
  });

  it("rejects a concurrent API sign-in using the same busy guard as the button", async () => {
    const pending = deferred<Phase1BState>();
    fixtures.loginWithPassword.mockReturnValue(pending.promise);
    const mounted = await mountAppShell();
    try {
      const params = { account: "fixture-account", password: "synthetic-private-input" };
      const first = agentActions.execute(AGENT_ACTIONS.authLogin, params);
      const second = agentActions.execute(AGENT_ACTIONS.authLogin, params);
      pending.reject(new Error("Synthetic login refused"));
      expect(await second).toMatchObject({ ok: false, error: { kind: "busy" } });
      expect(await first).toMatchObject({ ok: false });
      expect(fixtures.loginWithPassword).toHaveBeenCalledOnce();
    } finally { mounted.unmount(); }
  });

  it("normalizes API verification codes and scrubs normalized error echoes", async () => {
    fixtures.login.mockRejectedValue(new Error("Synthetic code refused: synthetic-private-code"));
    const mounted = await mountAppShell();
    try {
      const result = await agentActions.execute(AGENT_ACTIONS.authLogin, {
        mode: "email-code", email: "fixture@example.test", code: "  synthetic-private-code  ",
      });
      expect(result).toMatchObject({ ok: false });
      expect(JSON.stringify(result)).not.toContain("synthetic-private-code");
      expect(fixtures.login).toHaveBeenCalledWith("fixture@example.test", "synthetic-private-code");
    } finally { mounted.unmount(); }
  });

  it("refuses the same unavailable upload capability from the button and API", async () => {
    signedIn();
    fixtures.state!.v2WorkspaceAvailable = false;
    const mounted = await mountAppShell();
    try {
      element<HTMLButtonElement>('button[data-action="upload.open"]').click();
      await nextTick();
      expect(ui().uploadWizardOpen).toBe(false);
      expect(await agentActions.execute(AGENT_ACTIONS.uploadOpen)).toMatchObject({ ok: false, error: { kind: "unsupported" } });
      expect(await agentActions.execute(AGENT_ACTIONS.uploadBack, { step: "map" })).toMatchObject({ ok: false, error: { kind: "unsupported" } });
      expect(ui().uploadStep).toBe("select");
    } finally { mounted.unmount(); }
  });

  it("does not navigate a closed upload wizard through the API", async () => {
    signedIn();
    const mounted = await mountAppShell();
    try {
      expect(await agentActions.execute(AGENT_ACTIONS.uploadBack, { step: "map" })).toMatchObject({ ok: false, error: { kind: "validation" } });
      expect(ui().uploadStep).toBe("select");
    } finally { mounted.unmount(); }
  });

  it("requests authentication through both upload entry points without claiming the wizard opened", async () => {
    const mounted = await mountAppShell();
    try {
      element<HTMLButtonElement>('button[data-action="upload.open"]').click();
      await nextTick();
      expect(ui()).toMatchObject({ authDialogOpen: true, uploadWizardOpen: false });
      await agentActions.execute(AGENT_ACTIONS.authDialogClose);
      expect(await agentActions.execute(AGENT_ACTIONS.uploadOpen)).toMatchObject({ ok: false, error: { kind: "auth" } });
      expect(ui()).toMatchObject({ authDialogOpen: true, uploadWizardOpen: false });
    } finally { mounted.unmount(); }
  });

  it("uses the same upload back transition from its button and API when permitted", async () => {
    signedIn();
    const mounted = await mountAppShell();
    try {
      expect((await agentActions.execute(AGENT_ACTIONS.uploadOpen)).ok).toBe(true);
      expect((await agentActions.execute(AGENT_ACTIONS.uploadBack, { step: "map" })).ok).toBe(true);
      await nextTick();
      element<HTMLButtonElement>('button[data-action="ui.upload.back"]').click();
      await nextTick();
      const fromButton = ui();
      expect(fromButton).toMatchObject({ uploadStep: "select", uploadWizardOpen: true });
      await agentActions.execute(AGENT_ACTIONS.uploadBack, { step: "map" });
      expect((await agentActions.execute(AGENT_ACTIONS.uploadBack, { step: "select" })).ok).toBe(true);
      expect(ui()).toEqual(fromButton);
    } finally { mounted.unmount(); }
  });

  it("preserves running upload state when open/back are refused and exposes safe progress", async () => {
    signedIn();
    const pending = deferred<Awaited<ReturnType<typeof ingestPointCsv>>>();
    fixtures.ingest.mockImplementation((options) => {
      options.onJobCreated?.(12);
      options.onProgress?.({ progress: 0.4, stage: "processing", message: "Synthetic processing" });
      return pending.promise;
    });
    const mounted = await mountAppShell();
    try {
      expect((await agentActions.execute(AGENT_ACTIONS.uploadOpen)).ok).toBe(true);
      const run = agentActions.execute(AGENT_ACTIONS.uploadRun, {
        file: new File(["lng,lat\n1,2\nsynthetic-private-file-body"], "fixture.csv", { type: "text/csv" }),
        name: "Fixture", plateModelId: 1, mapping: { longitudeColumn: "lng", latitudeColumn: "lat" },
      });
      await nextTick();
      const before = ui();
      element<HTMLButtonElement>('button[data-action="upload.open"]').click();
      const back = await agentActions.execute(AGENT_ACTIONS.uploadBack, { step: "map" });
      const after = ui();
      pending.reject(new Error("Synthetic upload refused token=synthetic-private-token"));
      expect(await run).toMatchObject({ ok: false });
      await settle();
      expect(before).toMatchObject({ uploadStep: "run", uploadProgress: 0.4, uploadStage: "processing", uploadJobId: 12, busy: true });
      expect(back).toMatchObject({ ok: false, error: { kind: "busy" } });
      expect(after).toEqual(before);
      expect(ui()).toMatchObject({ busy: false, uploadError: "Synthetic upload refused token=[redacted]" });
      expect(JSON.stringify(agentActions.getState())).not.toMatch(/synthetic-private-(?:file-body|token)/);
    } finally { mounted.unmount(); }
  });

  it("opens and closes the same inline style panel from UI and API", async () => {
    const mounted = await mountAppShell();
    try {
      const row = element<HTMLElement>('[data-layer-id="3"]');
      row.click();
      await nextTick();
      expect(ui()).toMatchObject({ selectedLayerId: 3, layerStyleOpen: true, activeSidebarTab: "layers" });
      const panel = row.querySelector<HTMLElement>('.layer-style-inline')!;
      expect(panel.style.display).not.toBe("none");
      row.querySelector<HTMLButtonElement>('button[data-action="ui.layerStyle.close"]')!.click();
      await nextTick();
      const uiClosed = ui();
      expect(uiClosed).toMatchObject({ selectedLayerId: null, layerStyleOpen: false });
      expect(panel.style.display).toBe("none");
      expect((await agentActions.execute(AGENT_ACTIONS.layerStyleOpen, { layerId: 3 })).ok).toBe(true);
      expect((await agentActions.execute(AGENT_ACTIONS.layerStyleClose)).ok).toBe(true);
      await nextTick();
      expect(ui()).toEqual(uiClosed);
      expect(panel.style.display).toBe("none");
      expect(await agentActions.execute(AGENT_ACTIONS.layerStyleOpen, { layerId: 999 })).toMatchObject({ ok: false, error: { kind: "validation" } });
      expect(ui()).toEqual(uiClosed);
    } finally { mounted.unmount(); }
  });

  it.each([
    ["filtered", "api"], ["filtered", "ui"],
    ["collapsed", "api"], ["collapsed", "ui"],
  ] as const)("reveals a %s style panel when opened via %s", async (hiddenBy, entry) => {
    const mounted = await mountAppShell();
    const groupId = new ProjectSession().layerList.find((layer) => layer.id === 3)!.groupId;
    const groupChanges: unknown[] = [];
    const onGroupChange = (event: Event) => groupChanges.push((event as CustomEvent).detail);
    window.addEventListener(LAYER_GROUP_COLLAPSE_CHANGE_EVENT, onGroupChange);
    try {
      await agentActions.execute(AGENT_ACTIONS.layerStyleOpen, { layerId: 3 });
      if (hiddenBy === "filtered") input('input[data-action="ui.layerSearch.set"]', "no matching fixture layer");
      else element<HTMLButtonElement>(`[data-group-id="${groupId}"] button[data-action="layer.group.setCollapsed"]`).click();
      await nextTick();
      expect(ui().layerStyleOpen).toBe(false);
      groupChanges.length = 0;
      if (entry === "api") expect((await agentActions.execute(AGENT_ACTIONS.layerStyleOpen, { layerId: 3 })).ok).toBe(true);
      else element<HTMLButtonElement>('.sidebar-actions button[data-action="ui.layerStyle.open"]').click();
      await nextTick();
      expect(ui()).toMatchObject({ selectedLayerId: 3, layerStyleOpen: true });
      const row = element<HTMLElement>('[data-layer-id="3"]');
      expect(row.style.display).not.toBe("none");
      expect(row.querySelector<HTMLElement>('.layer-style-inline')!.style.display).not.toBe("none");
      if (hiddenBy === "filtered") expect(ui().layerSearch).toBe("");
      else expect(groupChanges).toEqual([{ collapsed: false, id: groupId }]);
    } finally {
      window.removeEventListener(LAYER_GROUP_COLLAPSE_CHANGE_EVENT, onGroupChange);
      mounted.unmount();
    }
  });

  it.each(["ui", "api"] as const)("retains runtime-owned nodes and listeners across search via %s and style reveal", async (entry) => {
    const target = {} as Window;
    installAgentActions(target);
    const api = target.timeMachineAgent!.v2;
    const mounted = await mountAppShell();
    try {
      const statusIds = ["point-state-chip", "point-status", "point-count", "atlas-frame-value", "atlas-status", "single-raster-state"];
      const runtimeNodes = new Map(statusIds.map((id) => [id, element<HTMLElement>(`#${id}`)]));
      for (const [id, node] of runtimeNodes) node.textContent = `Runtime ${id}`;
      const load = element<HTMLButtonElement>('#load-points');
      const unload = element<HTMLButtonElement>('#unload-points');
      const dataset = element<HTMLSelectElement>('#point-dataset-select');
      load.disabled = false;
      unload.disabled = false;
      dataset.disabled = false;
      dataset.replaceChildren(new Option("Runtime dataset", "runtime-fixture"));
      dataset.value = "runtime-fixture";
      const onLoad = vi.fn();
      const onUnload = vi.fn();
      const onDataset = vi.fn();
      load.addEventListener("click", onLoad);
      unload.addEventListener("click", onUnload);
      dataset.addEventListener("change", onDataset);

      if (entry === "api") expect((await api.execute(AGENT_ACTIONS.layerSearchSet, { query: "no-such-layer" })).ok).toBe(true);
      else input('input[data-action="ui.layerSearch.set"]', "no-such-layer");
      await nextTick();
      expect(document.querySelector('.layer-empty')?.textContent).toContain("No matching layers");
      // main.ts retains these exact references; detached replacements are not equivalent.
      for (const [id, node] of runtimeNodes) {
        expect(document.getElementById(id), id).toBe(node);
        expect(node.closest<HTMLElement>('.layer-row')?.style.display, id).toBe("none");
      }
      expect((await api.execute(AGENT_ACTIONS.layerStyleOpen, { layerId: 4 })).ok).toBe(true);
      await nextTick();
      expect(ui()).toMatchObject({ layerSearch: "", selectedLayerId: 4, layerStyleOpen: true });
      expect(document.querySelector('.layer-empty')).toBeNull();
      for (const [id, node] of runtimeNodes) {
        expect(document.getElementById(id), id).toBe(node);
        expect(node.textContent, id).toBe(`Runtime ${id}`);
      }
      expect(element('#load-points')).toBe(load);
      expect(element('#unload-points')).toBe(unload);
      expect(element('#point-dataset-select')).toBe(dataset);
      expect(load.disabled).toBe(false);
      expect(unload.disabled).toBe(false);
      expect(dataset.disabled).toBe(false);
      expect(dataset.value).toBe("runtime-fixture");
      expect(dataset.options[0]?.text).toBe("Runtime dataset");
      load.click();
      unload.click();
      dataset.dispatchEvent(new Event("change", { bubbles: true }));
      expect(onLoad).toHaveBeenCalledOnce();
      expect(onUnload).toHaveBeenCalledOnce();
      expect(onDataset).toHaveBeenCalledOnce();
    } finally { mounted.unmount(); }
  });

  it("keeps matching group counts, empty results and collapsed rows consistent while filtering", async () => {
    const mounted = await mountAppShell();
    const session = new ProjectSession();
    const pointGroupId = session.layerList.find((layer) => layer.id === RUNTIME_LAYER_IDS.points)!.groupId;
    const visible = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].filter((node) => node.style.display !== "none");
    try {
      element<HTMLButtonElement>(`[data-group-id="${pointGroupId}"] button[data-action="layer.group.setCollapsed"]`).click();
      input('input[data-action="ui.layerSearch.set"]', "  pBdB  ");
      await nextTick();
      expect(visible('.layer-row').map((row) => Number(row.dataset.layerId))).toEqual([RUNTIME_LAYER_IDS.points]);
      expect(visible('.layer-group-row').map((group) => group.dataset.groupId)).toEqual([String(pointGroupId)]);
      expect(element(`[data-group-id="${pointGroupId}"] small`).textContent).toBe("1");
      expect(document.querySelector('.layer-empty')).toBeNull();
      input('input[data-action="ui.layerSearch.set"]', "no-such-layer");
      await nextTick();
      expect(visible('.layer-row')).toHaveLength(0);
      expect(visible('.layer-group-row')).toHaveLength(0);
      expect(document.querySelector('.layer-empty')?.textContent).toContain("No matching layers");
      input('input[data-action="ui.layerSearch.set"]', "");
      await nextTick();
      expect(visible('.layer-group-row')).toHaveLength(session.groupList.length);
      expect(element(`[data-group-id="${pointGroupId}"] small`).textContent).toBe(String(session.layerList.filter((layer) => layer.groupId === pointGroupId).length));
      expect(visible('.layer-row').map((row) => Number(row.dataset.layerId))).toEqual(session.layerList.filter((layer) => layer.groupId !== pointGroupId).map((layer) => layer.id));
      expect(document.querySelector('.layer-empty')).toBeNull();
    } finally { mounted.unmount(); }
  });

  it("notifies real UI changes, excludes form secrets, and detaches state providers on unmount", async () => {
    const target = {} as Window;
    installAgentActions(target);
    const v2 = target.timeMachineAgent!.v2;
    const events: AppEvent[] = [];
    const mounted = await mountAppShell();
    const unsubscribe = v2.events.subscribe({ sections: ["ui"] }, (event) => events.push(event));
    try {
      await agentActions.execute(AGENT_ACTIONS.authDialogOpen);
      await settle();
      events.length = 0;
      input('[autocomplete="current-password"]', "synthetic-private-input");
      await settle();
      expect(events).toHaveLength(0);
      expect(JSON.stringify(agentActions.getState())).not.toContain("synthetic-private-input");
      await agentActions.execute(AGENT_ACTIONS.authDialogClose);
      await settle();
      events.length = 0;
      input('input[data-action="ui.layerSearch.set"]', "raster");
      await settle();
      // Observe the event before querying: query's refresh must not hide a missing UI watch.
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "state.changed", sections: expect.arrayContaining(["ui"]) });
      const changed = await v2.query("ui.snapshot");
      expect(changed).toMatchObject({ ok: true, data: { layerSearch: "raster", activeModule: "Layer", selectedLayerId: null, layerStyleOpen: false } });
    } finally {
      mounted.unmount();
      await settle();
      unsubscribe();
    }
    expect(await v2.query("ui.snapshot")).toMatchObject({ ok: false, error: { kind: "unsupported" } });
    expect(agentActions.getState()).not.toHaveProperty("session");
    expect(agentActions.getState()).not.toHaveProperty("catalog");
    expect(agentActions.getState()).not.toHaveProperty("selection");
    expect(fixtures.listeners.size).toBe(0);
    const remounted = await mountAppShell();
    const nextEvents: AppEvent[] = [];
    const unsubscribeNext = v2.events.subscribe({ sections: ["ui"] }, (event) => nextEvents.push(event));
    try {
      input('input[data-action="ui.layerSearch.set"]', "plate");
      await settle();
      expect(nextEvents).toHaveLength(1);
    } finally { unsubscribeNext(); remounted.unmount(); }
  });

  it("notifies session changes from the existing cloud subscription", async () => {
    const target = {} as Window;
    installAgentActions(target);
    const mounted = await mountAppShell();
    const events: AppEvent[] = [];
    const unsubscribe = target.timeMachineAgent!.v2.events.subscribe({ sections: ["session"] }, (event) => events.push(event));
    try {
      signedIn();
      for (const listener of fixtures.listeners) listener({ ...fixtures.state! });
      await settle();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "state.changed", sections: expect.arrayContaining(["session"]) });
    } finally { unsubscribe(); mounted.unmount(); }
  });
});
