import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectLayerType } from "@timemachine/generated-api";
import { installAgentActions, AgentActionBusyError } from "../agent-actions/registry";
import { ProjectSession } from "../project/project-session";
import { LayerController } from "../layers/layer-controller";
import { registerLayerStyleAction } from "../layers/style-action";

let session: ProjectSession;
let target: Window;
let controller: LayerController;
function createRuntime() {
  return { applyImageryOrder: vi.fn(() => undefined), applyRuntime: vi.fn((_id: number) => undefined), persist: vi.fn(() => undefined), publishState: vi.fn(() => undefined), syncNativeControls: vi.fn(() => undefined) };
}
let runtime: ReturnType<typeof createRuntime>;
const api = () => target.timeMachineAgent!.v2;
beforeEach(() => {
  session = new ProjectSession(); target = {} as Window; installAgentActions(target);
  runtime = createRuntime();
  controller = new LayerController(session, runtime);
  session.addLayer({ name: "Native A", type: ProjectLayerType.Point, sourceRef: "fixture:goal-points-v1", groupId: 101, active: true, alpha: 1 });
  session.addLayer({ name: "Native B", type: ProjectLayerType.Point, sourceRef: "fixture:goal-points-v1", groupId: 101, active: true, alpha: 1 });
  registerLayerStyleAction(session, controller);
});

describe("ordinary point style command", () => {
  it("updates independent polygon fill and boundary fields and refuses cross-type patches", async () => {
    const id = session.addLayer({ name: "Polygon", type: ProjectLayerType.Polygon, sourceRef: "fixture:goal-polygons-v1", groupId: 101, active: true, alpha: 1 });
    const beforePoint = session.getLayer(103);
    expect(await api().execute("layer.setStyle", { layerId: id, style: { fillColor: "#AB1234", outlineWidth: 4 } })).toMatchObject({
      ok: true, data: { layerId: id, style: { fillColor: "#ab1234", outlineColor: "#ffffff", outlineWidth: 4 } },
    });
    expect(await api().execute("layer.setStyle", { layerId: id, style: { outlineColor: "#00ff00" } })).toMatchObject({
      ok: true, data: { style: { fillColor: "#ab1234", outlineColor: "#00ff00", outlineWidth: 4 } },
    });
    const before = session.getLayer(id);
    for (const style of [{ lineColor: "#ffffff" }, { pointSize: 3 }, { fillColor: "red" }, { outlineWidth: 17 }, { fillColor: "#ffffff", lineWidth: 2 }]) {
      expect(await api().execute("layer.setStyle", { layerId: id, style })).toMatchObject({ ok: false });
    }
    expect(session.getLayer(id)).toEqual(before); expect(session.getLayer(103)).toEqual(beforePoint);
    expect(runtime.applyRuntime).toHaveBeenCalledTimes(2);
  });
  it("updates line color and width without changing point or other line instances", async () => {
    const line = { name: "Line", type: ProjectLayerType.Line, sourceRef: "fixture:goal-lines-v1", groupId: 101, active: true, alpha: 1 };
    const id = session.addLayer(line), other = session.addLayer(line);
    const beforePoint = session.getLayer(103), beforeOther = session.getLayer(other);
    expect(await api().execute("layer.setStyle", { layerId: id, style: { lineColor: "#AB1234", lineWidth: 5 } })).toMatchObject({
      ok: true, data: { layerId: id, style: { lineColor: "#ab1234", lineWidth: 5 } },
    });
    expect(session.getLayer(id)).toMatchObject({ lineStyle: { lineColor: "#ab1234", lineWidth: 5 } });
    expect(session.getLayer(103)).toEqual(beforePoint); expect(session.getLayer(other)).toEqual(beforeOther);
    const before = session.getLayer(id);
    for (const style of [{ lineWidth: 17 }, { pointSize: 3 }, { lineColor: "red" }, { lineWidth: 4, pointSize: 2 }]) {
      expect(await api().execute("layer.setStyle", { layerId: id, style })).toMatchObject({ ok: false });
    }
    expect(session.getLayer(id)).toEqual(before);
    expect(runtime.applyRuntime).toHaveBeenCalledTimes(1);
  });
  it("applies patches through the shared controller, preserving another instance and GPU defaults", async () => {
    const beforeB = session.getLayer(104), beforeGpu = session.getLayer(2);
    expect(await api().execute("layer.setStyle", { layerId: 103, style: { singleColor: "#12abef" } })).toMatchObject({ ok: true, data: { layerId: 103, style: { singleColor: "#12abef", pointSize: 6 } } });
    expect(await api().execute("layer.setStyle", { layerId: 103, style: { pointSize: 4 } })).toMatchObject({ ok: true, data: { style: { singleColor: "#12abef", pointSize: 4 } } });
    expect(session.getLayer(103)?.pointStyle).toMatchObject({ colorMode: "single", sizeMode: "fixed", shape: "circle", singleColor: "#12abef", pointSize: 4 });
    expect(session.getLayer(104)).toEqual(beforeB); expect(session.getLayer(2)).toEqual(beforeGpu);
    expect(runtime.applyRuntime).toHaveBeenCalledTimes(2); expect(runtime.persist).toHaveBeenCalledTimes(2);
    expect(await api().catalog.describe("layer.setStyle")).toMatchObject({ completion: "state-committed" });
  });
  it("rejects invalid or unsupported patches without state or renderer mutations", async () => {
    const before = session.layerList;
    for (const style of [{}, { singleColor: "red" }, { pointSize: 0 }, { pointSize: 9 }, { shape: "square" }, { colorMode: "plate" }, { filter: { plateId: 101 } }]) {
      expect(await api().execute("layer.setStyle", { layerId: 103, style })).toMatchObject({ ok: false });
    }
    expect(await api().execute("layer.setStyle", { layerId: 2, style: { pointSize: 3 } })).toMatchObject({ ok: false, error: { kind: "unsupported" } });
    expect(await api().execute("layer.setStyle", { layerId: 9999, style: { pointSize: 3 } })).toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(session.layerList).toEqual(before); expect(runtime.applyRuntime).not.toHaveBeenCalled(); expect(runtime.persist).not.toHaveBeenCalled();
  });
  it("checks cleanup ownership before modifying persistent style", async () => {
    registerLayerStyleAction(session, controller, () => { throw new AgentActionBusyError("Synthetic cleanup pending"); });
    const before = session.getLayer(103);
    expect(await api().execute("layer.setStyle", { layerId: 103, style: { pointSize: 3 } })).toMatchObject({ ok: false, error: { kind: "busy" } });
    expect(session.getLayer(103)).toEqual(before); expect(runtime.persist).not.toHaveBeenCalled();
  });
});
