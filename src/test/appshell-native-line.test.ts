// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { ProjectLayerType } from "@timemachine/generated-api";
import { agentActions } from "../agent-actions";
import { LayerController } from "../layers/layer-controller";
import { LAYER_STATE_EVENT } from "../layers/layer-events";
import { registerLayerInstanceActions } from "../layers/instance-actions";
import { registerLayerStyleAction } from "../layers/style-action";
import { ProjectSession } from "../project/project-session";
import type { Phase1BState } from "../phase1b/cloud-client";
import { mountAppShell } from "./support/mount-app-shell";
import { openAddLayerPanel } from "./support/add-layer-panel";

const fixture = vi.hoisted(() => ({ state: undefined as Phase1BState | undefined }));
vi.mock("../phase1b/cloud-client", async importOriginal => ({
  ...await importOriginal<typeof import("../phase1b/cloud-client")>(), phase1BCloudClient: {
    get snapshot() { return fixture.state!; }, initialize: async () => fixture.state!,
    subscribe(listener: (state: Phase1BState) => void) { listener(fixture.state!); return () => {}; }, getCloudReference: () => undefined,
  },
}));
let mounted: Awaited<ReturnType<typeof mountAppShell>> | undefined;
let session: ProjectSession;
let finishLoad: (() => void) | undefined;
let finishRemove: (() => void) | undefined;
const states = new Map<number, { runtimeStatus: "loading" | "ready" | "removing" | "error"; runtimeError?: string }>();
const persisted: unknown[] = [];
function publish(): void {
  window.dispatchEvent(new CustomEvent(LAYER_STATE_EVENT, { detail: { layers: session.layerList.map(layer => ({ ...layer, ...states.get(layer.id) })), groups: session.groupList } }));
}
beforeEach(() => {
  fixture.state = {
    datasets: [], message: "", plateModels: [], plateModelCatalog: [], projects: [],
    selection: { datasetVersionId: 0, plateModelId: 0, plateModelVersionId: 0, useLocalPlateModelDemo: false },
    serverUrl: "/fixture-service", sharedPlateModels: [], sharedPlateModelsError: "", sharedPlateModelsMineIds: [],
    sharedPlateModelsStatus: "ready", sharedPlateModelsTotal: 0, status: "signed-out", v2WorkspaceAvailable: true,
  };
  session = new ProjectSession(); persisted.length = 0; states.clear(); finishLoad = undefined; finishRemove = undefined;
  const persist = () => { persisted.push(session.toDocument()); };
  const controller = new LayerController(session, { publishState: publish, applyRuntime() {}, applyImageryOrder() {}, syncNativeControls() {}, persist });
  registerLayerStyleAction(session, controller);
  // Real UI, actions, controller and project state; the controlled renderer boundary
  // checks pending UI ownership only. It is not native-rendering evidence.
  registerLayerInstanceActions(session, {
    assertCanAdd() {}, publish, persist,
    async load(id) {
      states.set(id, { runtimeStatus: "loading" }); publish();
      await new Promise<void>(resolve => { finishLoad = resolve; });
      states.set(id, { runtimeStatus: "ready" }); publish();
    },
    async remove(id) {
      states.set(id, { runtimeStatus: "removing" }); publish();
      await new Promise<void>(resolve => { finishRemove = resolve; });
      states.delete(id);
    },
  });
});
afterEach(() => { mounted?.unmount(); mounted = undefined; vi.restoreAllMocks(); });
function add(name: string): number {
  return session.addLayer({ name, type: ProjectLayerType.Line, sourceRef: "fixture:goal-lines-v1", groupId: 101, active: true, alpha: 1 });
}
function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector); if (!node) throw new Error(`Missing ordinary line UI: ${selector}`); return node;
}
async function mount(): Promise<void> { mounted = await mountAppShell(); publish(); await nextTick(); await openAddLayerPanel("line"); await nextTick(); }
async function settle(): Promise<void> { await Promise.resolve(); await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)); }
async function field(selector: string, value: string, event = "change"): Promise<void> {
  const input = element<HTMLInputElement>(selector); input.value = value; input.dispatchEvent(new Event(event, { bubbles: true })); await settle();
}

describe("ordinary line controls", () => {
  it("adds and removes a line through shared actions and keeps Point/GPU controls intact", async () => {
    await mount();
    expect(document.querySelector('form[aria-label="Add line layer"]')).not.toBeNull();
    const gpu = element<HTMLButtonElement>("#load-points");
    gpu.disabled = false; const clicked = vi.fn(); gpu.addEventListener("click", clicked);
    const source = element<HTMLSelectElement>('[aria-label="Line layer source"]');
    expect([...source.options].map(option => ({ value: option.value, text: option.text }))).toEqual([{ value: "fixture:goal-lines-v1", text: "Synthetic line sample" }]);
    expect(element('form[aria-label="Add line layer"]').textContent).toMatch(/Source-coordinate lines/);
    expect(element('form[aria-label="Add line layer"]').textContent).toMatch(/not reconstructed/i);
    await field('[aria-label="Line layer name"]', "Line A", "input");
    const button = element<HTMLButtonElement>('form[aria-label="Add line layer"] [data-action="layer.add"]'); button.click(); await settle();
    const first = session.layerList.find(layer => layer.name === "Line A")!;
    expect(first).toMatchObject({ type: ProjectLayerType.Line, sourceRef: "fixture:goal-lines-v1", lineStyle: { lineColor: "#38bdf8", lineWidth: 2 } });
    expect(button.disabled).toBe(true);
    expect(element(`[data-layer-id="${first.id}"] .ordinary-line-status`).textContent).toContain("loading");
    finishLoad!(); await settle();
    expect(agentActions.getState().ui).toMatchObject({ pointLayerActionBusy: false });
    expect(button.disabled).toBe(true); expect(element<HTMLInputElement>('[aria-label="Line layer name"]').value).toBe("");
    const second = add("Line B"); publish(); await settle();
    element<HTMLButtonElement>(`[data-layer-id="${first.id}"] [data-action="layer.remove"]`).click(); await settle();
    expect(session.getLayer(first.id)).toBeDefined();
    expect(element(`[data-layer-id="${first.id}"] .ordinary-line-status`).textContent).toContain("removing");
    finishRemove!(); await settle();
    expect(session.getLayer(first.id)).toBeUndefined(); expect(session.getLayer(second)).toBeDefined();
    // The inactive point form is UI-owned and may be unmounted; the main-captured
    // GPU node may not change.
    expect(element("#load-points")).toBe(gpu);
    gpu.click(); expect(clicked).toHaveBeenCalledOnce();
    expect(document.querySelectorAll(".point-style-controls")).toHaveLength(1);
    expect(document.querySelectorAll(".point-performance-lab")).toHaveLength(1);
  });

  it("edits line color/width independently through the real shared style handler", async () => {
    const first = add("Line A"), second = add("Line B"); const gpu = session.getLayer(2); await mount();
    expect(document.querySelector(`[data-layer-id="${first}"] [data-native-line-style="color"]`)).not.toBeNull();
    await field(`[data-layer-id="${first}"] [data-native-line-style="color"]`, "#1255aa");
    await field(`[data-layer-id="${first}"] [data-native-line-style="width"]`, "4.5");
    expect(session.getLayer(first)?.lineStyle).toEqual({ lineColor: "#1255aa", lineWidth: 4.5 });
    expect(session.getLayer(second)?.lineStyle).toEqual({ lineColor: "#38bdf8", lineWidth: 2 });
    expect(session.getLayer(2)).toEqual(gpu); expect(persisted).toHaveLength(2);
    expect(element('.point-layer-action-message[role="status"]').textContent).toContain("Style state updated");
  });

  it("rejects invalid width without a write and restores the authoritative input value", async () => {
    const id = add("Line A"); await mount();
    expect(document.querySelector(`[data-layer-id="${id}"] [data-native-line-style="width"]`)).not.toBeNull();
    await field(`[data-layer-id="${id}"] [data-native-line-style="width"]`, "17");
    expect(session.getLayer(id)?.lineStyle).toEqual({ lineColor: "#38bdf8", lineWidth: 2 }); expect(persisted).toHaveLength(0);
    expect(element<HTMLInputElement>(`[data-layer-id="${id}"] [data-native-line-style="width"]`).value).toBe("2");
    expect(element('.point-layer-action-error[role="alert"]').textContent).toMatch(/width.*\[1, 16\]/i);
    expect(agentActions.getState().ui).toMatchObject({ pointLayerActionBusy: false });
  });

  it("shows explicit stored-style and runtime errors without supported-looking fallback controls", async () => {
    const id = add("Bad line"); session.setLineStyle(id, { lineColor: "#ffffff", lineWidth: 2, dashMode: "future" });
    states.set(id, { runtimeStatus: "error", runtimeError: "Synthetic line failure token=synthetic-line-secret" }); await mount();
    expect(document.querySelectorAll(`[data-layer-id="${id}"] [data-native-line-style]`)).toHaveLength(0);
    expect(element(`[data-layer-id="${id}"] .ordinary-line-style-error[role="alert"]`).textContent).toBeTruthy();
    expect(element(`[data-layer-id="${id}"] .ordinary-line-status`).textContent).toContain("error");
    expect(element(`[data-layer-id="${id}"] .ordinary-line-status`).textContent).toContain("Source-coordinate lines");
    expect(element(`[data-layer-id="${id}"]`).textContent).not.toContain("synthetic-line-secret");
    expect(element(`[data-layer-id="${id}"]`).textContent).not.toContain("PALEOMAP finite rotations");
    expect(session.getLayer(id)?.lineStyle).toMatchObject({ dashMode: "future" });
  });

  it("requires a nonblank name and existing group before add", async () => {
    for (const layer of session.layerList) session.removeLayer(layer.id);
    for (const group of session.groupList) session.removeGroup(group.id);
    await mount();
    expect(document.querySelector('form[aria-label="Add line layer"]')).not.toBeNull();
    await field('[aria-label="Line layer name"]', "Line A", "input");
    expect(element<HTMLButtonElement>('form[aria-label="Add line layer"] [data-action="layer.add"]').disabled).toBe(true);
    expect(element('form[aria-label="Add line layer"]').textContent).toContain("Create a group");
    session.addGroup({ name: "Lines", active: true, alpha: 1, collapsed: false }); publish(); await settle();
    await field('[aria-label="Line layer name"]', "  ", "input");
    expect(element<HTMLButtonElement>('form[aria-label="Add line layer"] [data-action="layer.add"]').disabled).toBe(true);
  });
});
