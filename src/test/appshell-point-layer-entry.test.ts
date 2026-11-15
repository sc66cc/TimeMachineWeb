// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { ProjectLayerType } from "@timemachine/generated-api";
import { AGENT_ACTIONS, agentActions } from "../agent-actions";
import { LayerController } from "../layers/layer-controller";
import { registerLayerInstanceActions } from "../layers/instance-actions";
import { LAYER_STATE_EVENT, LAYER_VISIBILITY_CHANGE_EVENT, LAYER_OPACITY_CHANGE_EVENT } from "../layers/layer-events";
import { ProjectSession, RUNTIME_LAYER_IDS } from "../project/project-session";
import type { Phase1BState } from "../phase1b/cloud-client";
import { mountAppShell } from "./support/mount-app-shell";

const fixture = vi.hoisted(() => ({ state: undefined as Phase1BState | undefined }));
vi.mock("../phase1b/cloud-client", async importOriginal => ({
  ...await importOriginal<typeof import("../phase1b/cloud-client")>(),
  phase1BCloudClient: {
    get snapshot() { return fixture.state!; },
    initialize: async () => fixture.state!,
    subscribe(listener: (state: Phase1BState) => void) { listener(fixture.state!); return () => {}; },
    getCloudReference: () => undefined,
  },
}));

let mounted: Awaited<ReturnType<typeof mountAppShell>> | undefined;
let session: ProjectSession;
let controller: LayerController;
let detachControls: () => void;
const runtime = new Map<number, { runtimeStatus: "loading" | "ready" | "error" | "removing" | "unloaded"; runtimeError?: string }>();
function deferred() {
  let resolve!: () => void; let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const loads: Array<{ id: number; sourceRef: string; completion: ReturnType<typeof deferred> }> = [];
const removals: Array<{ id: number; completion: ReturnType<typeof deferred> }> = [];

function publish(): void {
  window.dispatchEvent(new CustomEvent(LAYER_STATE_EVENT, {
    detail: { groups: session.groupList, layers: session.layerList.map(layer => ({ ...layer, ...runtime.get(layer.id) })) },
  }));
}

beforeEach(() => {
  fixture.state = {
    datasets: [], message: "", plateModels: [], plateModelCatalog: [], projects: [],
    selection: { datasetVersionId: 0, plateModelId: 0, plateModelVersionId: 0, useLocalPlateModelDemo: false },
    serverUrl: "/fixture-service", sharedPlateModels: [], sharedPlateModelsError: "", sharedPlateModelsMineIds: [],
    sharedPlateModelsStatus: "ready", sharedPlateModelsTotal: 0, status: "signed-out", v2WorkspaceAvailable: true,
  };
  session = new ProjectSession(); runtime.clear();
  loads.length = 0; removals.length = 0;
  controller = new LayerController(session, {
    publishState: publish, applyImageryOrder() {}, applyRuntime() {}, persist() {}, syncNativeControls() {},
  });
  // Real application actions and project mutations; controlled adapter promises
  // test the UI's wait/error boundary, not GPU/native-frame readiness.
  registerLayerInstanceActions(session, {
    assertCanAdd() {}, publish, persist() {},
    async load(id, sourceRef) {
      const completion = deferred(); loads.push({ id, sourceRef, completion });
      runtime.set(id, { runtimeStatus: "loading" }); publish();
      try {
        await completion.promise; runtime.set(id, { runtimeStatus: "ready" }); publish();
      } catch (error) {
        runtime.set(id, { runtimeStatus: "error", runtimeError: String(error) }); publish(); throw error;
      }
    },
    async remove(id) {
      const completion = deferred(); removals.push({ id, completion });
      runtime.set(id, { runtimeStatus: "removing" }); publish();
      try { await completion.promise; runtime.delete(id); }
      catch (error) { runtime.set(id, { runtimeStatus: "error", runtimeError: String(error) }); publish(); throw error; }
    },
  });
  const visibility = (event: Event) => {
    const { id, active } = (event as CustomEvent<{ id: number; active: boolean }>).detail;
    controller.setLayerVisibility(id, active);
  };
  const opacity = (event: Event) => {
    const { id, alpha } = (event as CustomEvent<{ id: number; alpha: number }>).detail;
    controller.setLayerOpacity(id, alpha);
  };
  window.addEventListener(LAYER_VISIBILITY_CHANGE_EVENT, visibility);
  window.addEventListener(LAYER_OPACITY_CHANGE_EVENT, opacity);
  detachControls = () => {
    window.removeEventListener(LAYER_VISIBILITY_CHANGE_EVENT, visibility);
    window.removeEventListener(LAYER_OPACITY_CHANGE_EVENT, opacity);
  };
});
afterEach(() => { mounted?.unmount(); mounted = undefined; detachControls(); vi.restoreAllMocks(); });

function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing point layer UI: ${selector}`);
  return node;
}
function point(name: string): number {
  return session.addLayer({ name, type: ProjectLayerType.Point, sourceRef: "fixture:goal-points-v1", groupId: 101, active: true, alpha: 1 });
}
function row(id: number): HTMLElement { return element(`.layer-row[data-layer-id="${id}"]`); }
async function mount(): Promise<void> { mounted = await mountAppShell(); publish(); await nextTick(); }
function field(selector: string, value: string, event = "input"): void {
  const node = element<HTMLInputElement | HTMLSelectElement>(selector);
  node.value = value; node.dispatchEvent(new Event(event, { bubbles: true }));
}
async function settle(): Promise<void> { await Promise.resolve(); await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)); }

describe("AppShell ordinary point layer entry", () => {
  it("waits for two independent add completions and removes only the selected instance through real shared actions", async () => {
    await mount();
    const loadButton = element<HTMLButtonElement>("#load-points"); const nativeState = element("#point-state-chip");
    loadButton.disabled = false; nativeState.textContent = "Native GPU ready";
    const nativeClick = vi.fn(); loadButton.addEventListener("click", nativeClick);
    const addButton = element<HTMLButtonElement>('button[data-action="layer.add"]');
    const execute = vi.spyOn(agentActions, "execute");
    field('[aria-label="Point layer name"]', "Sample A"); await nextTick(); addButton.click(); await settle();
    expect(loads).toHaveLength(1); expect(loads[0]!.sourceRef).toBe("fixture:goal-points-v1");
    const first = loads[0]!.id;
    expect(session.getLayer(first)).toMatchObject({ name: "Sample A", active: true, alpha: 1, type: ProjectLayerType.Point, groupId: 101 });
    expect(addButton.disabled).toBe(true);
    expect(row(first).querySelector<HTMLButtonElement>('button[data-action="layer.remove"]')?.disabled).toBe(true);
    expect(element('.point-layer-action-message[role="status"]').textContent).toContain("Adding Sample A");
    expect(agentActions.getState().ui).toMatchObject({ pointLayerActionBusy: true });
    addButton.click(); expect(loads).toHaveLength(1);
    loads[0]!.completion.resolve(); await settle();
    expect(element('.point-layer-action-message[role="status"]').textContent).toBe("Added Sample A.");
    expect(element<HTMLInputElement>('[aria-label="Point layer name"]').value).toBe("");
    expect(row(first).querySelector('.ordinary-point-status')?.textContent).toContain("ready");
    field('[aria-label="Point layer name"]', "Sample B"); await nextTick(); addButton.click(); await settle();
    expect(loads).toHaveLength(2); const second = loads[1]!.id;
    expect(second).not.toBe(first); loads[1]!.completion.resolve(); await settle();
    expect(session.layerList).toHaveLength(6);
    expect(session.getLayer(first)?.sourceRef).toBe(session.getLayer(second)?.sourceRef);
    const secondRow = row(second);
    row(first).querySelector<HTMLButtonElement>('button[data-action="layer.remove"]')!.click(); await settle();
    expect(removals).toHaveLength(1); expect(removals[0]!.id).toBe(first);
    expect(session.getLayer(first)).toBeDefined();
    expect(row(first).querySelector('.ordinary-point-status')?.textContent).toContain("removing");
    expect(row(second).querySelector<HTMLButtonElement>('button[data-action="layer.remove"]')?.disabled).toBe(true);
    expect(execute).toHaveBeenCalledWith(AGENT_ACTIONS.layerRemove, { layerId: first });
    removals[0]!.completion.resolve(); await settle();
    expect(session.getLayer(first)).toBeUndefined();
    expect(document.querySelector(`.layer-row[data-layer-id="${first}"]`)).toBeNull();
    expect(row(second)).toBe(secondRow);
    expect(element('.point-layer-action-message[role="status"]').textContent).toBe("Removed Sample A.");
    expect(element("#load-points")).toBe(loadButton); expect(element("#point-state-chip")).toBe(nativeState);
    expect(loadButton.disabled).toBe(false); expect(nativeState.textContent).toBe("Native GPU ready");
    loadButton.click(); expect(nativeClick).toHaveBeenCalledOnce();
    for (const id of Object.values(RUNTIME_LAYER_IDS)) expect(session.getLayer(id)).toBeDefined();
  });

  it("surfaces add/removal failures, keeps failed records and allows removal retry after the adapter settles", async () => {
    await mount();
    field('[aria-label="Point layer name"]', "Sample A"); await nextTick();
    element<HTMLButtonElement>('button[data-action="layer.add"]').click(); await settle();
    const id = loads[0]!.id;
    loads[0]!.completion.reject(new Error("Synthetic load failed")); await settle();
    expect(session.getLayer(id)).toBeDefined();
    expect(element('.point-layer-action-error[role="alert"]').textContent).toContain("Synthetic load failed");
    expect(element<HTMLInputElement>('[aria-label="Point layer name"]').value).toBe("Sample A");
    expect(element<HTMLButtonElement>('button[data-action="layer.add"]').disabled).toBe(false);
    expect(agentActions.getState().ui).toMatchObject({ pointLayerActionBusy: false });
    const remove = row(id).querySelector<HTMLButtonElement>('button[data-action="layer.remove"]')!;
    remove.click(); await settle(); expect(remove.disabled).toBe(true);
    removals[0]!.completion.reject(new Error("Synthetic removal failed token=synthetic-remove-secret")); await settle();
    expect(row(id).querySelector<HTMLButtonElement>('button[data-action="layer.remove"]')).toBe(remove);
    expect(remove.disabled).toBe(false); expect(session.getLayer(id)).toBeDefined();
    expect(element('.point-layer-action-error[role="alert"]').textContent).toContain("Synthetic removal failed");
    expect(document.body.textContent).not.toContain("synthetic-remove-secret");
    remove.click(); await settle(); expect(removals).toHaveLength(2);
    removals[1]!.completion.resolve(); await settle();
    expect(session.getLayer(id)).toBeUndefined();
    expect(document.querySelector('.point-layer-action-error')).toBeNull();
    expect(agentActions.getState().ui).toMatchObject({ pointLayerActionBusy: false, pointLayerActionError: "" });
  });

  it("offers only an explicit synthetic point source and displays the shared action's unavailable failure", async () => {
    agentActions.registerUnsupported(AGENT_ACTIONS.layerAdd, "Add point layer", "Synthetic source is unavailable.");
    await mount();
    const source = element<HTMLSelectElement>('[aria-label="Point layer source"]');
    expect([...source.options].map(option => ({ label: option.text, value: option.value }))).toEqual([
      { label: "Synthetic point sample", value: "fixture:goal-points-v1" },
    ]);
    expect(element('form[aria-label="Add point layer"]').textContent).toContain("Present-day points");
    expect(element('form[aria-label="Add point layer"]').querySelector('[type="file"]')).toBeNull();
    const execute = vi.spyOn(agentActions, "execute");
    field('[aria-label="Point layer name"]', "  Sample A  ");
    field('[aria-label="Point layer group"]', "102", "change"); await nextTick();
    element<HTMLButtonElement>('button[data-action="layer.add"]').click(); await settle();
    expect(execute).toHaveBeenCalledWith(AGENT_ACTIONS.layerAdd, { layer: {
      name: "Sample A", type: ProjectLayerType.Point, sourceRef: "fixture:goal-points-v1", groupId: 102, active: true, alpha: 1,
    } });
    expect(element('.point-layer-action-error[role="alert"]').textContent).toContain("Synthetic source is unavailable");
    expect(element<HTMLInputElement>('[aria-label="Point layer name"]').value).toBe("  Sample A  ");
    expect(element<HTMLButtonElement>('button[data-action="layer.add"]').disabled).toBe(false);
    expect(session.layerList).toHaveLength(4);
    expect(agentActions.getState().ui).toMatchObject({ pointLayerActionBusy: false });
  });

  it("requires a name and an existing group before offering to add a point layer", async () => {
    for (const layer of session.layerList) session.removeLayer(layer.id);
    for (const group of session.groupList) session.removeGroup(group.id);
    await mount();
    const button = element<HTMLButtonElement>('button[data-action="layer.add"]');
    field('[aria-label="Point layer name"]', "Sample A"); await nextTick();
    expect(button.disabled).toBe(true);
    expect(element('form[aria-label="Add point layer"]').textContent).toContain("Create a group");
    const groupId = controller.addGroup({ name: "Samples", active: true, alpha: 1, collapsed: false }); await nextTick();
    field('[aria-label="Point layer group"]', String(groupId), "change");
    field('[aria-label="Point layer name"]', "   "); await nextTick();
    expect(button.disabled).toBe(true);
  });

  it("labels two ordinary point rows honestly, gives unique controls and keeps GPU-only controls on the default layer", async () => {
    const first = point("Sample A"); const second = point("Sample B");
    runtime.set(first, { runtimeStatus: "ready" }); runtime.set(second, { runtimeStatus: "loading" });
    await mount();
    for (const id of [first, second]) {
      expect(row(id).querySelector(".layer-copy")?.textContent).toContain("Present-day points");
      expect(row(id).querySelector(".layer-copy")?.textContent).not.toMatch(/PALEOMAP|GPU point runtime|finite rotations/);
      expect(row(id).querySelector(".layer-swatch")?.classList.contains("points")).toBe(true);
      expect(row(id).querySelector('input[data-action="layer.setVisibility"]')?.id).toBe(`layer-${id}-visibility`);
      expect(row(id).querySelector(".point-performance-lab")).toBeNull();
      expect(row(id).querySelector(".point-style-controls")).toBeNull();
      expect(row(id).querySelector('button[data-action="layer.remove"]')).not.toBeNull();
    }
    expect(row(first).querySelector(".ordinary-point-status")?.textContent).toContain("ready");
    expect(row(second).querySelector(".ordinary-point-status")?.textContent).toContain("loading");
    for (const id of Object.values(RUNTIME_LAYER_IDS)) expect(row(id).querySelector('button[data-action="layer.remove"]')).toBeNull();
    for (const id of ["plate-visibility", "load-points", "unload-points", "point-dataset-select", "point-state-chip"]) {
      expect(document.querySelectorAll(`#${id}`)).toHaveLength(1);
    }
    expect(session.layerList).toHaveLength(6);
  });

  it("uses generic visibility/opacity controls for separate instances while retaining default native bindings", async () => {
    await mount();
    const load = element<HTMLButtonElement>("#load-points");
    const state = element("#point-state-chip");
    const loadListener = vi.fn(); load.disabled = false; load.addEventListener("click", loadListener); state.textContent = "Native GPU ready";
    const first = point("Sample A"); const second = point("Sample B"); publish(); await nextTick();
    const visibility = element<HTMLInputElement>(`#layer-${first}-visibility`);
    visibility.checked = false; visibility.dispatchEvent(new Event("change", { bubbles: true }));
    await agentActions.execute(AGENT_ACTIONS.layerStyleOpen, { layerId: second }); await nextTick();
    const alpha = row(second).querySelector<HTMLInputElement>('input[data-action="layer.setOpacity"]')!;
    alpha.value = "40"; alpha.dispatchEvent(new Event("input", { bubbles: true })); await nextTick();
    expect(session.getLayer(first)).toMatchObject({ active: false, alpha: 1 });
    expect(session.getLayer(second)).toMatchObject({ active: true, alpha: 0.4 });
    expect(element("#load-points")).toBe(load); expect(element("#point-state-chip")).toBe(state);
    expect(load.disabled).toBe(false); expect(state.textContent).toBe("Native GPU ready");
    load.click(); expect(loadListener).toHaveBeenCalledOnce();
  });

  it("shows source runtime errors and absent state without inventing ready or leaking labelled credentials", async () => {
    const id = point("Sample A");
    await mount();
    expect(row(id).querySelector(".ordinary-point-status")?.textContent).toContain("Status unavailable");
    runtime.set(id, { runtimeStatus: "error", runtimeError: "Synthetic load failure token=synthetic-ui-secret" }); publish(); await nextTick();
    expect(row(id).querySelector('[role="alert"]')?.textContent).toContain("Synthetic load failure");
    expect(row(id).textContent).not.toContain("synthetic-ui-secret");
    expect(row(id).querySelector(".ordinary-point-status")?.textContent).toContain("error");
    runtime.set(id, { runtimeStatus: "unloaded" }); publish(); await nextTick();
    expect(row(id).querySelector(".ordinary-point-status")?.textContent).toContain("unloaded");
    expect(row(id).querySelector('[role="alert"]')).toBeNull();
  });
});
