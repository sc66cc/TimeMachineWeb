// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { ProjectLayerType } from "@timemachine/generated-api";
import { AGENT_ACTIONS, AGENT_DECLARATIONS, agentActions } from "../agent-actions";
import { AgentActionValidationError } from "../agent-actions/registry";
import { registerLayerInstanceActions } from "../layers/instance-actions";
import { LayerController } from "../layers/layer-controller";
import { LAYER_STATE_EVENT, LAYER_VISIBILITY_CHANGE_EVENT, LAYER_OPACITY_CHANGE_EVENT, type LayerStateDetail } from "../layers/layer-events";
import { ProjectSession, RUNTIME_LAYER_IDS } from "../project/project-session";
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
function deferred() {
  let resolve!: () => void; let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let mounted: Awaited<ReturnType<typeof mountAppShell>> | undefined;
let session: ProjectSession;
let controller: LayerController;
let detach: () => void;
let options: NonNullable<LayerStateDetail["rasterOptions"]>;
let defaultRasterId: string | undefined;
const states = new Map<number, { runtimeStatus: "loading" | "ready" | "error" | "removing"; runtimeError?: string }>();
const loads: { id: number; source: string; completion: ReturnType<typeof deferred> }[] = [];
const removals: { id: number; completion: ReturnType<typeof deferred> }[] = [];
const selections: { id: number; rasterId: string; completion: ReturnType<typeof deferred> }[] = [];
function publish(): void {
  const detail: LayerStateDetail = {
    groups: session.groupList, layers: session.layerList.map(layer => ({ ...layer, ...states.get(layer.id) })),
    rasterOptions: options, defaultRasterId,
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
  session = new ProjectSession(); states.clear(); loads.length = 0; removals.length = 0; selections.length = 0;
  options = [{ id: "temperature_000", label: "Temperature 0 Ma" }, { id: "temperature_015", label: "Temperature 15 Ma" }];
  defaultRasterId = "temperature_000";
  controller = new LayerController(session, { publishState: publish, applyImageryOrder() {}, applyRuntime() {}, persist() {}, syncNativeControls() {} });
  // Real shared add/remove handlers and ProjectSession, with a controlled native
  // adapter boundary. These tests prove UI waiting/errors, not rendered frames.
  registerLayerInstanceActions(session, {
    assertCanAdd() {}, publish, persist() {},
    async load(id, source) {
      const completion = deferred(); loads.push({ id, source, completion });
      states.set(id, { runtimeStatus: "loading" }); publish();
      try { await completion.promise; states.set(id, { runtimeStatus: "ready" }); publish(); }
      catch (error) { states.set(id, { runtimeStatus: "error", runtimeError: String(error) }); publish(); throw error; }
    },
    async remove(id) {
      const completion = deferred(); removals.push({ id, completion });
      states.set(id, { runtimeStatus: "removing" }); publish();
      try { await completion.promise; states.delete(id); }
      catch (error) { states.set(id, { runtimeStatus: "error", runtimeError: String(error) }); publish(); throw error; }
    },
  });
  // main owns raster.select registration; this actual registry handler is a
  // controlled application port, not a replacement for native-frame validation.
  agentActions.register(AGENT_DECLARATIONS[AGENT_ACTIONS.rasterSelect], async params => {
    const id = params.layerId as number, rasterId = params.rasterId as string;
    if (!session.getLayer(id) || !options.some(option => option.id === rasterId)) throw new AgentActionValidationError("Unavailable raster selection.");
    const completion = deferred(); selections.push({ id, rasterId, completion });
    states.set(id, { runtimeStatus: "loading" }); publish();
    try {
      await completion.promise; session.setRasterId(id, rasterId); states.set(id, { runtimeStatus: "ready" }); publish();
      return { data: { layerId: id, rasterId } };
    } catch (error) { states.set(id, { runtimeStatus: "error", runtimeError: String(error) }); publish(); throw error; }
  });
  const visibility = (event: Event) => { const value = (event as CustomEvent<{ id: number; active: boolean }>).detail; controller.setLayerVisibility(value.id, value.active); };
  const opacity = (event: Event) => { const value = (event as CustomEvent<{ id: number; alpha: number }>).detail; controller.setLayerOpacity(value.id, value.alpha); };
  window.addEventListener(LAYER_VISIBILITY_CHANGE_EVENT, visibility); window.addEventListener(LAYER_OPACITY_CHANGE_EVENT, opacity);
  detach = () => { window.removeEventListener(LAYER_VISIBILITY_CHANGE_EVENT, visibility); window.removeEventListener(LAYER_OPACITY_CHANGE_EVENT, opacity); };
});
afterEach(() => { mounted?.unmount(); mounted = undefined; detach(); vi.restoreAllMocks(); });
function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector); if (!node) throw new Error(`Missing raster UI: ${selector}`); return node;
}
function row(id: number): HTMLElement { return element(`.layer-row[data-layer-id="${id}"]`); }
function add(name: string, rasterId: unknown = "temperature_000"): number {
  return session.addLayer({ name, type: ProjectLayerType.Raster, sourceRef: "local:single-raster-manifest", groupId: 101, active: true, alpha: 1, rasterId });
}
async function settle(): Promise<void> { await Promise.resolve(); await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)); }
async function mount(): Promise<void> { mounted = await mountAppShell(); publish(); await settle(); await openAddLayerPanel("raster"); await settle(); }
async function field(selector: string, value: string, event = "change"): Promise<void> {
  const input = element<HTMLInputElement | HTMLSelectElement>(selector); input.value = value; input.dispatchEvent(new Event(event, { bubbles: true })); await settle();
}
const form = 'form[aria-label="Add raster layer"]';
const submit = () => element<HTMLButtonElement>(`${form} button[data-action="layer.add"]`);
const rasterSelect = (id: number) => element<HTMLSelectElement>(`[data-layer-id="${id}"] select[data-action="raster.select"]`);

describe("AppShell Raster instances", () => {
  it("uses only published manifest choices and disables add until all inputs are valid", async () => {
    options = []; defaultRasterId = undefined; await mount();
    const execute = vi.spyOn(agentActions, "execute");
    await field('[aria-label="Raster layer name"]', "Raster A", "input");
    expect(submit().disabled).toBe(true);
    expect(element(form).textContent).toMatch(/manifest|available/i);
    element(form).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await settle();
    expect(execute).not.toHaveBeenCalledWith(AGENT_ACTIONS.layerAdd, expect.anything());
    options = [{ id: "from-real-manifest", label: "Manifest choice" }]; defaultRasterId = "from-real-manifest"; publish(); await settle();
    expect([...element<HTMLSelectElement>('[aria-label="Raster layer selection"]').options].filter(option => !option.disabled).map(option => [option.value, option.text])).toEqual([["from-real-manifest", "Manifest choice"]]);
    expect(element<HTMLSelectElement>('[aria-label="Raster layer source"]').value).toBe("local:single-raster-manifest");
    expect(submit().disabled).toBe(false);
    await field('[aria-label="Raster layer name"]', "  ", "input"); expect(submit().disabled).toBe(true);
    await field('[aria-label="Raster layer name"]', "Raster A", "input");
    await field('[aria-label="Raster layer group"]', ""); expect(submit().disabled).toBe(true);
    expect(element(form).querySelector('[type="file"]')).toBeNull();
  });

  it("adds two independent Raster records through the real shared handler and waits for completion", async () => {
    await mount(); const execute = vi.spyOn(agentActions, "execute");
    await field('[aria-label="Raster layer name"]', " Raster A ", "input");
    await field('[aria-label="Raster layer group"]', "102");
    await field('[aria-label="Raster layer selection"]', "temperature_015");
    submit().click(); await settle();
    expect(loads).toHaveLength(1); const first = loads[0]!.id;
    expect(execute).toHaveBeenCalledWith(AGENT_ACTIONS.layerAdd, { layer: {
      name: "Raster A", type: ProjectLayerType.Raster, sourceRef: "local:single-raster-manifest", groupId: 102, active: true, alpha: 1, rasterId: "temperature_015",
    } });
    expect(session.getRasterId(first)).toBe("temperature_015");
    expect(submit().disabled).toBe(true); expect(rasterSelect(first).disabled).toBe(true);
    expect(row(first).querySelector('.ordinary-raster-status')?.textContent).toContain("loading");
    expect(document.querySelector('.point-layer-action-message')?.textContent).toContain("Adding Raster A");
    loads[0]!.completion.resolve(); await settle();
    expect(element<HTMLInputElement>('[aria-label="Raster layer name"]').value).toBe("");
    expect(row(first).querySelector('.ordinary-raster-status')?.textContent).toContain("ready");
    await field('[aria-label="Raster layer name"]', "Raster B", "input");
    await field('[aria-label="Raster layer selection"]', "temperature_000"); submit().click(); await settle();
    expect(loads).toHaveLength(2); const second = loads[1]!.id; loads[1]!.completion.resolve(); await settle();
    expect(session.getRasterId(first)).toBe("temperature_015"); expect(session.getRasterId(second)).toBe("temperature_000");
    expect(agentActions.getState().ui).toMatchObject({ pointLayerActionBusy: false, pointLayerActionError: "" });
  });

  it("shows add failure without clearing input or inventing a successful completion", async () => {
    await mount(); await field('[aria-label="Raster layer name"]', "Failing raster", "input"); submit().click(); await settle();
    expect(loads).toHaveLength(1); loads[0]!.completion.reject(new Error("Raster source unavailable")); await settle();
    expect(element('.point-layer-action-error[role="alert"]').textContent).toContain("Raster source unavailable");
    expect(element<HTMLInputElement>('[aria-label="Raster layer name"]').value).toBe("Failing raster");
    expect(submit().disabled).toBe(false);
    expect(row(loads[0]!.id).querySelector('.ordinary-raster-status')?.textContent).toContain("error");
    expect(document.querySelector('.point-layer-action-message')).toBeNull();
  });

  it("selects through the shared action and restores authoritative choice on failure", async () => {
    const first = add("Raster A"), second = add("Raster B"); await mount(); const execute = vi.spyOn(agentActions, "execute");
    await field(`[data-layer-id="${first}"] select[data-action="raster.select"]`, "temperature_015");
    expect(execute).toHaveBeenCalledWith(AGENT_ACTIONS.rasterSelect, { layerId: first, rasterId: "temperature_015" });
    expect(selections).toHaveLength(1); expect(rasterSelect(first).disabled).toBe(true);
    selections[0]!.completion.reject(new Error("Selection load failed")); await settle();
    expect(rasterSelect(first).value).toBe("temperature_000");
    expect(element('.point-layer-action-error').textContent).toContain("Selection load failed");
    expect(rasterSelect(first).disabled).toBe(false);
    await field(`[data-layer-id="${first}"] select[data-action="raster.select"]`, "temperature_015");
    selections[1]!.completion.resolve(); await settle();
    expect(rasterSelect(first).value).toBe("temperature_015"); expect(session.getRasterId(first)).toBe("temperature_015");
    expect(session.getRasterId(second)).toBe("temperature_000");
  });

  it("keeps default fallback only for absent storage and exposes invalid/unknown saved choices", async () => {
    const absent = session.addLayer({ name: "Legacy raster", type: ProjectLayerType.Raster, sourceRef: "local:single-raster-manifest", groupId: 101, active: true, alpha: 1 });
    const malformed = add("Malformed raster", { future: true }), missing = add("Unknown raster", "missing-entry");
    await mount();
    expect(rasterSelect(absent).value).toBe("temperature_000");
    expect(rasterSelect(malformed).value).toBe(""); expect(rasterSelect(missing).value).toBe("missing-entry");
    for (const id of [malformed, missing]) expect(row(id).querySelector('.ordinary-raster-error[role="alert"]')?.textContent).toMatch(/invalid|unavailable/i);
    expect(session.getLayer(malformed)?.rasterId).toEqual({ future: true }); expect(session.getRasterId(missing)).toBe("missing-entry");
    expect(session.getRasterId(absent)).toBeUndefined();
  });

  it.each([null, false, 0, ""])("does not turn an explicit falsy saved selection into the default: %j", async raw => {
    const id = add("Invalid raster", raw); await mount();
    expect(rasterSelect(id).value).toBe("");
    expect(row(id).querySelector('.ordinary-raster-error')?.textContent).toContain("invalid");
    expect(session.getLayer(id)?.rasterId).toBe(raw);
  });

  it("disables and clears a stale add choice when manifest options disappear", async () => {
    await mount(); await field('[aria-label="Raster layer name"]', "Raster A", "input");
    await field('[aria-label="Raster layer selection"]', "temperature_015");
    options = []; defaultRasterId = undefined; publish(); await settle();
    expect(submit().disabled).toBe(true);
    expect(element<HTMLSelectElement>('[aria-label="Raster layer selection"]').value).toBe("");
  });

  it("retains failed removals for retry and removes only the selected non-default instance", async () => {
    const first = add("Raster A"), second = add("Raster B"); await mount();
    const remove = () => row(first).querySelector<HTMLButtonElement>('button[data-action="layer.remove"]')!;
    expect(remove()).not.toBeNull(); remove().click(); await settle();
    expect(removals).toHaveLength(1); expect(remove().disabled).toBe(true);
    expect(session.getLayer(first)).toBeDefined();
    removals[0]!.completion.reject(new Error("Removal frame failed")); await settle();
    expect(session.getLayer(first)).toBeDefined(); expect(remove().disabled).toBe(false);
    expect(element('.point-layer-action-error').textContent).toContain("Removal frame failed");
    remove().click(); await settle(); removals[1]!.completion.resolve(); await settle();
    expect(session.getLayer(first)).toBeUndefined(); expect(session.getLayer(second)).toBeDefined();
    for (const id of Object.values(RUNTIME_LAYER_IDS)) expect(row(id).querySelector('button[data-action="layer.remove"]')).toBeNull();
  });

  it("keeps shared visibility/opacity and stable default nodes across search/group moves", async () => {
    const first = add("Raster A"); await mount();
    const ids = ["single-raster-select", "single-raster-opacity", "single-raster-visibility", "single-raster-state", "atlas-status", "load-points", "point-state-chip"];
    const nodes = ids.map(id => element(`#${id}`));
    const defaultSelect = element<HTMLSelectElement>("#single-raster-select"); defaultSelect.disabled = false;
    defaultSelect.innerHTML = '<option value="native-bound">Native bound</option>'; defaultSelect.value = "native-bound";
    const listener = vi.fn(); defaultSelect.addEventListener("change", listener);
    element("#single-raster-state").textContent = "Native ready";
    const originalRow = row(first), selector = rasterSelect(first);
    element<HTMLInputElement>(`#layer-${first}-visibility`).click(); await settle();
    await field(`[data-layer-id="${first}"] input[data-action="layer.setOpacity"]`, "35", "input");
    expect(session.getLayer(first)).toMatchObject({ active: false, alpha: 0.35 });
    controller.setLayerGroup(first, 102); await settle();
    await agentActions.execute(AGENT_ACTIONS.layerSearchSet, { query: "no-matches" }); await settle();
    await agentActions.execute(AGENT_ACTIONS.layerStyleOpen, { layerId: first }); await settle();
    expect(row(first)).toBe(originalRow); expect(rasterSelect(first)).toBe(selector);
    ids.forEach((id, index) => expect(element(`#${id}`)).toBe(nodes[index]));
    expect(defaultSelect.value).toBe("native-bound"); expect(defaultSelect.disabled).toBe(false);
    expect(element("#single-raster-state").textContent).toBe("Native ready");
    defaultSelect.dispatchEvent(new Event("change")); expect(listener).toHaveBeenCalledOnce();
    expect(row(first).querySelector('.layer-swatch')?.classList.contains("raster")).toBe(true);
    expect(row(first).querySelector('.point-performance-lab')).toBeNull();
    expect(row(first).textContent).not.toContain("PALEOMAP finite rotations");
  });
});
