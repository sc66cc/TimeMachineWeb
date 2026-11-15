// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { ProjectLayerType } from "@timemachine/generated-api";
import { AGENT_ACTIONS, agentActions, installAgentActions } from "../agent-actions";
import { OperationInterruptedError } from "../agent-actions/operation";
import { registerLayerInstanceActions } from "../layers/instance-actions";
import { LAYER_STATE_EVENT, type LayerStateDetail } from "../layers/layer-events";
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
type RuntimeState = Pick<LayerStateDetail["layers"][number], "runtimeStatus" | "runtimeError">;
let mounted: Awaited<ReturnType<typeof mountAppShell>> | undefined;
let session: ProjectSession;
const states = new Map<number, RuntimeState>();
const retries: { id: number; signal?: AbortSignal; completion: ReturnType<typeof deferred> }[] = [];
function publish(): void {
  const detail: LayerStateDetail = {
    groups: session.groupList, layers: session.layerList.map(layer => ({ ...layer, ...states.get(layer.id) })),
    rasterOptions: [{ id: "raster-a", label: "Raster A" }], defaultRasterId: "raster-a",
    atlasSource: { sourceRef: "local:paleoatlas-manifest", label: "Published Atlas" },
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
  session = new ProjectSession(); states.clear(); retries.length = 0;
  installAgentActions(window);
  // Keep the real application commands and project records. Only the native
  // completion point is controlled; this does not establish rendered pixels.
  registerLayerInstanceActions(session, {
    assertCanAdd() {}, publish, persist() {},
    async load() { throw new Error("Retry must not add or load a replacement business record."); },
    async remove() { throw new Error("Retry must not remove the business record."); },
    async retry(id, signal) {
      const completion = deferred(); retries.push({ id, signal, completion });
      const abort = () => completion.reject(new OperationInterruptedError("cancelled"));
      signal?.addEventListener("abort", abort, { once: true });
      states.set(id, { runtimeStatus: "loading" }); publish();
      try {
        if (signal?.aborted) abort();
        await completion.promise;
        states.set(id, { runtimeStatus: "ready" }); publish();
      } catch (error) {
        states.set(id, { runtimeStatus: "error", runtimeError: error instanceof Error ? error.message : String(error) });
        publish(); throw error;
      } finally { signal?.removeEventListener("abort", abort); }
    },
  });
});
afterEach(() => { mounted?.unmount(); mounted = undefined; vi.restoreAllMocks(); });
function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector); if (!node) throw new Error(`Missing retry UI: ${selector}`); return node;
}
function row(id: number): HTMLElement { return element(`.layer-row[data-layer-id="${id}"]`); }
function retry(id: number): HTMLButtonElement | null { return row(id).querySelector('button[data-action="layer.retry"]'); }
function add(type: ProjectLayerType): number {
  const sourceRef = type === ProjectLayerType.Atlas ? "local:paleoatlas-manifest"
    : type === ProjectLayerType.Raster ? "local:single-raster-manifest"
      : type === ProjectLayerType.Point ? "fixture:goal-points-v1"
        : type === ProjectLayerType.Line ? "fixture:goal-lines-v1" : "fixture:goal-polygons-v1";
  return session.addLayer({ name: `Failed ${ProjectLayerType[type]}`, type, sourceRef, groupId: 102, active: true, alpha: 0.65,
    ...(type === ProjectLayerType.Point ? { pointStyle: { schemaVersion: 1 as const, colorMode: "single" as const,
      singleColor: "#00ff00", sizeMode: "fixed" as const, pointSize: 7, shape: "circle" as const, occurrenceSizeScale: 1,
      filter: { plateId: null, minimumOccurrence: 0, maximumOccurrence: 65535 } } } : {}),
    ...(type === ProjectLayerType.Raster ? { rasterId: "raster-a" } : {}),
    ...(type === ProjectLayerType.Line ? { lineStyle: { lineColor: "#00ff00", lineWidth: 4 } } : {}),
    ...(type === ProjectLayerType.Polygon ? { polygonStyle: { fillColor: "#00ff00", outlineColor: "#ffff00", outlineWidth: 3 } } : {}),
  });
}
async function settle(): Promise<void> { await Promise.resolve(); await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)); }
async function mount(): Promise<void> { mounted = await mountAppShell(); publish(); await settle(); }

describe("AppShell failed-layer retry", () => {
  it("offers retry only for supported error rows, including default Atlas/Raster", async () => {
    const ordinary = [ProjectLayerType.Point, ProjectLayerType.Line, ProjectLayerType.Polygon, ProjectLayerType.Raster, ProjectLayerType.Atlas].map(add);
    const supported = [RUNTIME_LAYER_IDS.atlas, RUNTIME_LAYER_IDS.raster, ...ordinary];
    for (const layer of session.layerList) states.set(layer.id, { runtimeStatus: "error", runtimeError: "Source unavailable" });
    await mount();
    for (const id of supported) expect(retry(id)?.getAttribute("aria-label")).toBe(`Retry ${session.getLayer(id)!.name} layer`);
    expect(retry(RUNTIME_LAYER_IDS.points)).toBeNull(); expect(retry(RUNTIME_LAYER_IDS.plateModel)).toBeNull();
    for (const status of ["loading", "ready", "removing", "unloaded", undefined] as const) {
      for (const id of supported) states.set(id, { runtimeStatus: status, runtimeError: "Stale error must not enable retry" });
      publish(); await settle();
      for (const id of supported) expect(retry(id)).toBeNull();
    }
  });

  it.each([ProjectLayerType.Point, ProjectLayerType.Line, ProjectLayerType.Polygon, ProjectLayerType.Raster, ProjectLayerType.Atlas])(
    "retries ordinary type %s in place and waits for the same record to become ready", async type => {
      const id = add(type), sibling = add(type);
      for (const layerId of [id, sibling]) states.set(layerId, { runtimeStatus: "error", runtimeError: "Load failed" });
      await mount();
      const before = session.getLayer(id); const count = session.layerList.length; const originalRow = row(id);
      const execute = vi.spyOn(agentActions, "execute");
      expect(retry(id)).not.toBeNull(); retry(id)!.click(); await settle();
      expect(execute).toHaveBeenCalledWith(AGENT_ACTIONS.layerRetry, { layerId: id });
      expect(retries).toHaveLength(1); expect(retries[0]!.id).toBe(id);
      expect(agentActions.getState().ui).toMatchObject({ pointLayerActionBusy: true, pointLayerActionError: "" });
      expect(retry(id)).toBeNull();
      expect(retry(sibling)?.disabled).toBe(true); retry(sibling)!.click(); await settle(); expect(retries).toHaveLength(1);
      expect(row(id).querySelector<HTMLButtonElement>('button[data-action="layer.remove"]')?.disabled).toBe(true);
      expect(document.querySelector('.point-layer-action-message')?.textContent).toContain("Retrying");
      expect(session.getLayer(id)).toEqual(before);
      retries[0]!.completion.resolve(); await settle();
      expect(agentActions.getState().ui).toMatchObject({ pointLayerActionBusy: false, pointLayerActionError: "" });
      expect(row(id)).toBe(originalRow); expect(retry(id)).toBeNull();
      expect(retry(sibling)?.disabled).toBe(false);
      expect(row(id).querySelector('[role="alert"]')).toBeNull();
      expect(document.querySelector('.point-layer-action-message')?.textContent).toContain("Retried");
      expect(session.getLayer(id)).toEqual(before); expect(session.layerList).toHaveLength(count);
    },
  );

  it("retains a failed retry and allows the same layer to retry again", async () => {
    const id = add(ProjectLayerType.Polygon); states.set(id, { runtimeStatus: "error", runtimeError: "First failure" }); await mount();
    const before = session.getLayer(id); expect(retry(id)).not.toBeNull(); retry(id)!.click(); await settle();
    expect(retries).toHaveLength(1);
    retries[0]!.completion.reject(new Error("Polygon source is still unavailable")); await settle();
    expect(element('.point-layer-action-error[role="alert"]').textContent).toContain("Polygon source is still unavailable");
    expect(row(id).querySelector('[role="alert"]')?.textContent).toContain("Polygon source is still unavailable");
    expect(document.querySelector('.point-layer-action-message')).toBeNull();
    expect(retry(id)?.disabled).toBe(false); expect(session.getLayer(id)).toEqual(before);
    retry(id)!.click(); await settle(); expect(retries).toHaveLength(2);
    expect(document.querySelector('.point-layer-action-error')).toBeNull();
    retries[1]!.completion.resolve(); await settle();
    expect(retry(id)).toBeNull(); expect(session.getLayer(id)).toEqual(before);
  });

  it("shows a cancelled V2 retry as recoverable and lets the UI retry the retained record", async () => {
    const id = add(ProjectLayerType.Point); states.set(id, { runtimeStatus: "error", runtimeError: "First failure" }); await mount();
    const before = session.getLayer(id);
    const api = window.timeMachineAgent!.v2;
    const accepted = await api.execute("layer.retry", { layerId: id }, { completion: "accepted" }); await settle();
    expect(accepted).toMatchObject({ ok: true, status: "accepted" }); expect(retries).toHaveLength(1);
    expect(retries[0]!.signal).toBeDefined(); expect(retry(id)).toBeNull();
    await api.jobs.cancel(accepted.jobId!);
    expect(await api.jobs.wait(accepted.jobId!)).toMatchObject({ ok: false, status: "cancelled" }); await settle();
    expect(row(id).querySelector('[role="alert"]')?.textContent).toContain("cancelled");
    expect(session.getLayer(id)).toEqual(before); expect(retry(id)?.disabled).toBe(false);
    retry(id)!.click(); await settle(); expect(retries).toHaveLength(2);
    retries[1]!.completion.resolve(); await settle();
    expect(retry(id)).toBeNull(); expect(session.getLayer(id)).toEqual(before);
  });

  it("keeps default Atlas/Raster native nodes and listeners through retry state changes", async () => {
    for (const id of [RUNTIME_LAYER_IDS.atlas, RUNTIME_LAYER_IDS.raster]) states.set(id, { runtimeStatus: "error", runtimeError: "Default source failed" });
    await mount();
    const ids = ["atlas-visibility", "atlas-frame-value", "atlas-status", "single-raster-state", "single-raster-select", "single-raster-visibility"];
    const nodes = ids.map(id => element(`#${id}`));
    const atlasStatus = element("#atlas-status"); atlasStatus.textContent = "Owned by native runtime";
    const visibility = element<HTMLInputElement>("#atlas-visibility"); visibility.disabled = true;
    const listener = vi.fn(); visibility.addEventListener("change", listener);
    for (const [index, id] of [RUNTIME_LAYER_IDS.atlas, RUNTIME_LAYER_IDS.raster].entries()) {
      const before = session.getLayer(id); expect(retry(id)).not.toBeNull(); retry(id)!.click(); await settle();
      expect(retries).toHaveLength(index + 1);
      expect(retries[index]!.id).toBe(id); expect(retry(id)).toBeNull();
      retries[index]!.completion.resolve(); await settle();
      expect(retry(id)).toBeNull(); expect(session.getLayer(id)).toEqual(before);
      expect(row(id).querySelector('button[data-action="layer.remove"]')).toBeNull();
      ids.forEach((id, index) => expect(element(`#${id}`)).toBe(nodes[index]));
    }
    expect(visibility.disabled).toBe(true); expect(atlasStatus.textContent).toBe("Owned by native runtime");
    visibility.dispatchEvent(new Event("change")); expect(listener).toHaveBeenCalledOnce();
  });
});
