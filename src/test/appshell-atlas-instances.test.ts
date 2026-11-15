// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { ProjectLayerType } from "@timemachine/generated-api";
import { AGENT_ACTIONS, agentActions } from "../agent-actions";
import { registerLayerInstanceActions } from "../layers/instance-actions";
import { LayerController } from "../layers/layer-controller";
import { LAYER_STATE_EVENT, LAYER_VISIBILITY_CHANGE_EVENT, LAYER_OPACITY_CHANGE_EVENT, type LayerStateDetail } from "../layers/layer-events";
import { ProjectSession, RUNTIME_LAYER_IDS } from "../project/project-session";
import type { Phase1BState } from "../phase1b/cloud-client";
import { mountAppShell } from "./support/mount-app-shell";

const fixture = vi.hoisted(() => ({ state: undefined as Phase1BState | undefined }));
vi.mock("../phase1b/cloud-client", async importOriginal => ({
  ...await importOriginal<typeof import("../phase1b/cloud-client")>(), phase1BCloudClient: {
    get snapshot() { return fixture.state!; }, initialize: async () => fixture.state!,
    subscribe(listener: (state: Phase1BState) => void) { listener(fixture.state!); return () => {}; }, getCloudReference: () => undefined,
  },
}));
function deferred() {
  let resolve!: () => void; let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type RuntimeState = Pick<LayerStateDetail["layers"][number], "runtimeStatus" | "runtimeError" | "atlasState">;
const oldFrame = { sourceId: "atlas-100", timeMa: 100, label: "Atlas at 100 Ma" };
const newFrame = { sourceId: "atlas-200", timeMa: 200, label: "Atlas at 200 Ma" };
let mounted: Awaited<ReturnType<typeof mountAppShell>> | undefined;
let session: ProjectSession;
let controller: LayerController;
let detach: () => void;
let atlasSource: LayerStateDetail["atlasSource"];
const states = new Map<number, RuntimeState>();
const loads: { id: number; source: string; completion: ReturnType<typeof deferred> }[] = [];
const removals: { id: number; completion: ReturnType<typeof deferred> }[] = [];
function publish(): void {
  const detail: LayerStateDetail = {
    groups: session.groupList, layers: session.layerList.map(layer => ({ ...layer, ...states.get(layer.id) })), atlasSource,
  };
  window.dispatchEvent(new CustomEvent(LAYER_STATE_EVENT, { detail }));
}
beforeEach(() => {
  fixture.state = {
    datasets: [], message: "", plateModels: [], plateModelCatalog: [], projects: [],
    selection: { datasetVersionId: 0, plateModelId: 0, plateModelVersionId: 0, useLocalPlateModelDemo: false },
    serverUrl: "/fixture-service", sharedPlateModels: [], sharedPlateModelsError: "", sharedPlateModelsMineIds: [],
    sharedPlateModelsStatus: "ready", sharedPlateModelsTotal: 0, status: "signed-out", v2WorkspaceAvailable: true,
  };
  session = new ProjectSession(); states.clear(); loads.length = 0; removals.length = 0;
  atlasSource = { sourceRef: "local:paleoatlas-manifest", label: "Published PaleoAtlas" };
  controller = new LayerController(session, { publishState: publish, applyImageryOrder() {}, applyRuntime() {}, persist() {}, syncNativeControls() {} });
  // Actual shared actions and business state; only native frame readiness is a
  // controlled adapter. These tests establish UI completion, not GPU success.
  registerLayerInstanceActions(session, {
    assertCanAdd() {}, publish, persist() {},
    async load(id, source) {
      const completion = deferred(); loads.push({ id, source, completion });
      states.set(id, { runtimeStatus: "loading", atlasState: { status: "loading", requestedAgeMa: 205, frame: newFrame, committedFrame: null } }); publish();
      try {
        await completion.promise;
        states.set(id, { runtimeStatus: "ready", atlasState: { status: "ready", requestedAgeMa: 205, frame: newFrame, committedFrame: newFrame } }); publish();
      } catch (error) {
        states.set(id, { runtimeStatus: "error", runtimeError: String(error), atlasState: { status: "error", requestedAgeMa: 205, frame: newFrame, committedFrame: null } }); publish(); throw error;
      }
    },
    async remove(id) {
      const completion = deferred(); removals.push({ id, completion });
      states.set(id, { ...states.get(id), runtimeStatus: "removing" }); publish();
      try { await completion.promise; states.delete(id); }
      catch (error) { states.set(id, { ...states.get(id), runtimeStatus: "error", runtimeError: String(error) }); publish(); throw error; }
    },
  });
  const visibility = (event: Event) => { const value = (event as CustomEvent<{ id: number; active: boolean }>).detail; controller.setLayerVisibility(value.id, value.active); };
  const opacity = (event: Event) => { const value = (event as CustomEvent<{ id: number; alpha: number }>).detail; controller.setLayerOpacity(value.id, value.alpha); };
  window.addEventListener(LAYER_VISIBILITY_CHANGE_EVENT, visibility); window.addEventListener(LAYER_OPACITY_CHANGE_EVENT, opacity);
  detach = () => { window.removeEventListener(LAYER_VISIBILITY_CHANGE_EVENT, visibility); window.removeEventListener(LAYER_OPACITY_CHANGE_EVENT, opacity); };
});
afterEach(() => { mounted?.unmount(); mounted = undefined; detach(); vi.restoreAllMocks(); });
function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector); if (!node) throw new Error(`Missing Atlas UI: ${selector}`); return node;
}
function row(id: number): HTMLElement { return element(`.layer-row[data-layer-id="${id}"]`); }
function add(name: string): number {
  return session.addLayer({ name, type: ProjectLayerType.Atlas, sourceRef: "local:paleoatlas-manifest", groupId: 101, active: true, alpha: 1 });
}
async function settle(): Promise<void> { await Promise.resolve(); await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)); }
async function mount(): Promise<void> { mounted = await mountAppShell(); publish(); await settle(); }
async function field(selector: string, value: string, event = "change"): Promise<void> {
  const input = element<HTMLInputElement | HTMLSelectElement>(selector); input.value = value; input.dispatchEvent(new Event(event, { bubbles: true })); await settle();
}
const form = 'form[aria-label="Add Atlas layer"]';
const submit = () => element<HTMLButtonElement>(`${form} button[data-action="layer.add"]`);

describe("AppShell Atlas instances", () => {
  it("requires the published supported manifest and valid name/group before dispatch", async () => {
    atlasSource = undefined; await mount(); const execute = vi.spyOn(agentActions, "execute");
    await field('[aria-label="Atlas layer name"]', "Atlas A", "input");
    expect(submit().disabled).toBe(true);
    element(form).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await settle();
    expect(execute).not.toHaveBeenCalledWith(AGENT_ACTIONS.layerAdd, expect.anything());
    atlasSource = { sourceRef: "local:paleoatlas-manifest", label: "Published PaleoAtlas" }; publish(); await settle();
    expect(element(form).textContent).toContain("Published PaleoAtlas"); expect(submit().disabled).toBe(false);
    expect(element(form).querySelector('[type="file"], [aria-label="Atlas frame"], [aria-label="Atlas layer age"]')).toBeNull();
    await field('[aria-label="Atlas layer name"]', "  ", "input"); expect(submit().disabled).toBe(true);
    await field('[aria-label="Atlas layer name"]', "Atlas A", "input");
    await field('[aria-label="Atlas layer group"]', ""); expect(submit().disabled).toBe(true);
    await field('[aria-label="Atlas layer group"]', "101");
    atlasSource = { sourceRef: "local:unimplemented-atlas", label: "Unavailable source" }; publish(); await settle();
    expect(submit().disabled).toBe(true);
    element(form).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await settle();
    expect(loads).toHaveLength(0);
  });

  it("adds two independent Atlas records through the shared handler and waits for each result", async () => {
    await mount(); const execute = vi.spyOn(agentActions, "execute");
    await field('[aria-label="Atlas layer name"]', " Atlas A ", "input");
    await field('[aria-label="Atlas layer group"]', "102"); submit().click(); await settle();
    expect(loads).toHaveLength(1); const first = loads[0]!.id;
    expect(execute).toHaveBeenCalledWith(AGENT_ACTIONS.layerAdd, { layer: {
      name: "Atlas A", type: ProjectLayerType.Atlas, sourceRef: "local:paleoatlas-manifest", groupId: 102, active: true, alpha: 1,
    } });
    expect(submit().disabled).toBe(true);
    expect(row(first).querySelector('.ordinary-atlas-status')?.textContent).toContain("loading");
    loads[0]!.completion.resolve(); await settle();
    expect(element<HTMLInputElement>('[aria-label="Atlas layer name"]').value).toBe("");
    expect(row(first).querySelector('.atlas-committed-frame')?.textContent).toContain("200 Ma");
    await field('[aria-label="Atlas layer name"]', "Atlas B", "input"); submit().click(); await settle();
    expect(loads).toHaveLength(2); const second = loads[1]!.id; loads[1]!.completion.resolve(); await settle();
    expect(first).not.toBe(second);
    expect(session.getLayer(first)).toMatchObject({ name: "Atlas A", sourceRef: "local:paleoatlas-manifest", type: ProjectLayerType.Atlas });
    expect(session.getLayer(second)).toMatchObject({ name: "Atlas B", sourceRef: "local:paleoatlas-manifest", type: ProjectLayerType.Atlas });
    expect(agentActions.getState().ui).toMatchObject({ pointLayerActionBusy: false, pointLayerActionError: "" });
  });

  it("shows a failed addition and preserves its input and failed record for removal", async () => {
    await mount(); await field('[aria-label="Atlas layer name"]', "Unavailable Atlas", "input"); submit().click(); await settle();
    expect(loads).toHaveLength(1); loads[0]!.completion.reject(new Error("Atlas source failed")); await settle();
    expect(element('.point-layer-action-error[role="alert"]').textContent).toContain("Atlas source failed");
    expect(element<HTMLInputElement>('[aria-label="Atlas layer name"]').value).toBe("Unavailable Atlas");
    expect(submit().disabled).toBe(false);
    expect(row(loads[0]!.id).querySelector('.ordinary-atlas-status')?.textContent).toContain("error");
    expect(row(loads[0]!.id).querySelector('button[data-action="layer.remove"]')).not.toBeNull();
    expect(document.querySelector('.point-layer-action-message')).toBeNull();
  });

  it("distinguishes requested age, target frame and retained committed frame on failure", async () => {
    const first = add("Atlas A"), second = add("Atlas B");
    states.set(first, { runtimeStatus: "error", runtimeError: "Target failed", atlasState: { status: "error", requestedAgeMa: 205, frame: newFrame, committedFrame: oldFrame } });
    states.set(second, { runtimeStatus: "ready", atlasState: { status: "ready", requestedAgeMa: 205, frame: newFrame, committedFrame: newFrame } });
    await mount();
    expect(row(first).querySelector('.atlas-requested-age')?.textContent).toContain("205 Ma");
    expect(row(first).querySelector('.atlas-target-frame')?.textContent).toContain("200 Ma");
    expect(row(first).querySelector('.atlas-committed-frame')?.textContent).toContain("100 Ma");
    expect(row(first).querySelector('[role="alert"]')?.textContent).toContain("Target failed");
    expect(row(second).querySelector('.atlas-committed-frame')?.textContent).toContain("200 Ma");
    expect(row(second).querySelector('[role="alert"]')).toBeNull();
  });

  it.each(["disabled", "out-of-range"] as const)("shows hidden %s without treating the retained frame as currently ready", async reason => {
    const id = add("Hidden Atlas");
    states.set(id, { runtimeStatus: "ready", atlasState: { status: "hidden", requestedAgeMa: 700, frame: null, committedFrame: oldFrame, reason } });
    await mount(); const status = row(id).querySelector('.ordinary-atlas-status')!;
    expect(status?.textContent).toContain("hidden"); expect(status.textContent).not.toContain("ready");
    expect(status.querySelector('.atlas-hidden-reason')?.textContent).toContain(reason);
    expect(status.querySelector('.atlas-requested-age')?.textContent).toContain("700 Ma");
    expect(status.querySelector('.atlas-committed-frame')?.textContent).toContain("Last committed");
    expect(status.querySelector('.atlas-target-frame')).toBeNull();
  });

  it("reports unavailable runtime state without inventing a frame or plate-model status", async () => {
    const id = add("Uninitialized Atlas"); await mount();
    expect(row(id).querySelector('.ordinary-atlas-status')?.textContent).toContain("Status unavailable");
    expect(row(id).textContent).not.toContain("PALEOMAP finite rotations");
    expect(row(id).querySelector('.atlas-committed-frame')).toBeNull();
    atlasSource = undefined; publish(); await settle();
    await field('[aria-label="Atlas layer name"]', "Next Atlas", "input"); expect(submit().disabled).toBe(true);
  });

  it("prioritizes lifecycle failure over a retained ready Atlas frame", async () => {
    const id = add("Retained Atlas");
    states.set(id, { runtimeStatus: "error", runtimeError: "Cleanup failed; retry removal", atlasState: { status: "ready", requestedAgeMa: 100, frame: oldFrame, committedFrame: oldFrame } });
    await mount();
    expect(row(id).querySelector('.ordinary-atlas-status')?.textContent).toMatch(/Atlas imagery\s*·\s*error/);
    expect(row(id).querySelector('.atlas-committed-frame')?.textContent).toContain("100 Ma");
    expect(row(id).querySelector('[role="alert"]')?.textContent).toContain("Cleanup failed");
  });

  it("keeps a failed removal for retry and removes only its non-default Atlas", async () => {
    const first = add("Atlas A"), second = add("Atlas B");
    states.set(first, { runtimeStatus: "ready", atlasState: { status: "ready", requestedAgeMa: 100, frame: oldFrame, committedFrame: oldFrame } });
    await mount();
    const remove = () => row(first).querySelector<HTMLButtonElement>('button[data-action="layer.remove"]')!;
    expect(remove()).not.toBeNull(); remove().click(); await settle();
    expect(removals).toHaveLength(1); expect(remove().disabled).toBe(true); expect(session.getLayer(first)).toBeDefined();
    removals[0]!.completion.reject(new Error("Atlas removal frame failed")); await settle();
    expect(session.getLayer(first)).toBeDefined(); expect(remove().disabled).toBe(false);
    expect(element('.point-layer-action-error').textContent).toContain("Atlas removal frame failed");
    expect(row(first).querySelector('.ordinary-atlas-status')?.textContent).toMatch(/Atlas imagery\s*·\s*error/);
    expect(row(first).querySelector('.atlas-committed-frame')?.textContent).toContain("100 Ma");
    remove().click(); await settle(); removals[1]!.completion.resolve(); await settle();
    expect(session.getLayer(first)).toBeUndefined(); expect(session.getLayer(second)).toBeDefined();
    for (const id of Object.values(RUNTIME_LAYER_IDS)) expect(row(id).querySelector('button[data-action="layer.remove"]')).toBeNull();
  });

  it("uses shared visibility/opacity while preserving keyed rows and default native bindings", async () => {
    const id = add("Atlas A"); await mount();
    const ids = ["atlas-visibility", "atlas-frame-value", "atlas-status", "single-raster-select", "load-points", "point-state-chip"];
    const nodes = ids.map(id => element(`#${id}`)); const originalRow = row(id);
    const nativeVisibility = element<HTMLInputElement>("#atlas-visibility"); nativeVisibility.disabled = true;
    const listener = vi.fn(); nativeVisibility.addEventListener("change", listener);
    element("#atlas-status").textContent = "Native committed";
    element<HTMLInputElement>(`#layer-${id}-visibility`).click(); await settle();
    await field(`[data-layer-id="${id}"] input[data-action="layer.setOpacity"]`, "35", "input");
    expect(session.getLayer(id)).toMatchObject({ active: false, alpha: 0.35 });
    controller.setLayerGroup(id, 102); await settle();
    await agentActions.execute(AGENT_ACTIONS.layerSearchSet, { query: "no-matches" }); await settle();
    await agentActions.execute(AGENT_ACTIONS.layerStyleOpen, { layerId: id }); await settle();
    expect(row(id)).toBe(originalRow);
    ids.forEach((id, index) => expect(element(`#${id}`)).toBe(nodes[index]));
    expect(nativeVisibility.disabled).toBe(true); expect(element("#atlas-status").textContent).toBe("Native committed");
    nativeVisibility.dispatchEvent(new Event("change")); expect(listener).toHaveBeenCalledOnce();
    expect(row(id).querySelector('.layer-swatch')?.classList.contains("atlas")).toBe(true);
    expect(row(id).querySelector('.point-performance-lab, select[data-action="raster.select"], input[data-action="time.set"]')).toBeNull();
  });
});
