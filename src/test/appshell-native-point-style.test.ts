// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { ProjectLayerType } from "@timemachine/generated-api";
import { AGENT_ACTIONS, agentActions } from "../agent-actions";
import { LayerController } from "../layers/layer-controller";
import { LAYER_STATE_EVENT } from "../layers/layer-events";
import { registerLayerStyleAction } from "../layers/style-action";
import { defaultNativePointStyle } from "../layers/native-point-style";
import { ProjectSession } from "../project/project-session";
import type { Phase1BState } from "../phase1b/cloud-client";
import { mountAppShell } from "./support/mount-app-shell";

const fixture = vi.hoisted(() => ({ state: undefined as Phase1BState | undefined }));
vi.mock("../phase1b/cloud-client", async importOriginal => ({
  ...await importOriginal<typeof import("../phase1b/cloud-client")>(), phase1BCloudClient: {
    get snapshot() { return fixture.state!; }, initialize: async () => fixture.state!,
    subscribe(listener: (state: Phase1BState) => void) { listener(fixture.state!); return () => {}; }, getCloudReference: () => undefined,
  },
}));
let mounted: Awaited<ReturnType<typeof mountAppShell>> | undefined;
let session: ProjectSession;
const persists = vi.fn();
function publish(): void {
  window.dispatchEvent(new CustomEvent(LAYER_STATE_EVENT, { detail: { layers: session.layerList, groups: session.groupList } }));
}
beforeEach(() => {
  fixture.state = {
    datasets: [], message: "", plateModels: [], plateModelCatalog: [], projects: [],
    selection: { datasetVersionId: 0, plateModelId: 0, plateModelVersionId: 0, useLocalPlateModelDemo: false },
    serverUrl: "/fixture-service", sharedPlateModels: [], sharedPlateModelsError: "", sharedPlateModelsMineIds: [],
    sharedPlateModelsStatus: "ready", sharedPlateModelsTotal: 0, status: "signed-out", v2WorkspaceAvailable: true,
  };
  session = new ProjectSession(); persists.mockClear();
  const controller = new LayerController(session, { publishState: publish, applyRuntime() {}, applyImageryOrder() {}, syncNativeControls() {}, persist: persists });
  registerLayerStyleAction(session, controller);
});
afterEach(() => { mounted?.unmount(); mounted = undefined; vi.restoreAllMocks(); });
function add(name: string): number {
  return session.addLayer({ name, type: ProjectLayerType.Point, sourceRef: "fixture:goal-points-v1", groupId: 101, active: true, alpha: 1 });
}
function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector); if (!node) throw new Error(`Missing native point style UI: ${selector}`); return node;
}
async function mount(): Promise<void> { mounted = await mountAppShell(); publish(); await nextTick(); }
async function change(id: number, field: "color" | "size", value: string): Promise<void> {
  const input = element<HTMLInputElement>(`.layer-row[data-layer-id="${id}"] input[data-native-point-style="${field}"]`);
  input.value = value; input.dispatchEvent(new Event("change", { bubbles: true }));
  await Promise.resolve(); await nextTick(); await new Promise(resolve => setTimeout(resolve, 0));
}

describe("ordinary point color/size controls", () => {
  it("uses the shared style action, persists independent instances and retains all GPU controls", async () => {
    const first = add("Sample A"), second = add("Sample B"); const gpuStyle = session.getLayer(2)!.pointStyle;
    await mount();
    const load = element<HTMLButtonElement>("#load-points"); const chip = element("#point-state-chip");
    load.disabled = false; chip.textContent = "GPU native ready"; const click = vi.fn(); load.addEventListener("click", click);
    const execute = vi.spyOn(agentActions, "execute");
    await agentActions.execute(AGENT_ACTIONS.layerStyleOpen, { layerId: first }); await nextTick();
    await change(first, "color", "#1255aa"); await change(first, "size", "4.5");
    expect(execute).toHaveBeenCalledWith(AGENT_ACTIONS.layerSetStyle, { layerId: first, style: { singleColor: "#1255aa" } });
    expect(execute).toHaveBeenCalledWith(AGENT_ACTIONS.layerSetStyle, { layerId: first, style: { pointSize: 4.5 } });
    expect(session.getLayer(first)?.pointStyle).toMatchObject({ singleColor: "#1255aa", pointSize: 4.5 });
    expect(session.getLayer(second)?.pointStyle).toEqual(defaultNativePointStyle());
    expect(session.getLayer(2)?.pointStyle).toEqual(gpuStyle); expect(persists).toHaveBeenCalledTimes(2);
    expect(element('.point-layer-action-message[role="status"]').textContent).toContain("Style state updated");
    expect(element("#load-points")).toBe(load); expect(element("#point-state-chip")).toBe(chip);
    expect(load.disabled).toBe(false); expect(chip.textContent).toBe("GPU native ready"); load.click(); expect(click).toHaveBeenCalledOnce();
    expect(document.querySelectorAll(".point-performance-lab")).toHaveLength(1);
    expect(document.querySelectorAll(".point-style-controls")).toHaveLength(1);
    expect(document.querySelectorAll('[data-layer-id="2"] [data-native-point-style]')).toHaveLength(0);
  });

  it("shows a real validation failure and restores the input without changing or persisting style", async () => {
    const id = add("Sample A"); await mount();
    await change(id, "size", "9");
    expect(session.getLayer(id)?.pointStyle).toEqual(defaultNativePointStyle()); expect(persists).not.toHaveBeenCalled();
    expect(element<HTMLInputElement>(`[data-layer-id="${id}"] [data-native-point-style="size"]`).value).toBe("6");
    expect(element('.point-layer-action-error[role="alert"]').textContent).toMatch(/size.*\[0.5, 8\]/i);
    expect(agentActions.getState().ui).toMatchObject({ pointLayerActionBusy: false });
  });

  it("does not display supported controls or pretend a default for an explicit unsupported expression", async () => {
    const id = add("Unsupported sample");
    session.setPointStyle(id, { ...defaultNativePointStyle(), shape: "square" }); await mount();
    expect(document.querySelectorAll(`[data-layer-id="${id}"] [data-native-point-style]`)).toHaveLength(0);
    expect(element(`[data-layer-id="${id}"] .ordinary-point-style-error[role="alert"]`).textContent).toMatch(/circles|not implemented/i);
    expect(session.getLayer(id)?.pointStyle?.shape).toBe("square");
  });
});
