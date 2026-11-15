import { ProjectLayerType } from "@timemachine/generated-api";
import { AGENT_ACTIONS, AGENT_DECLARATIONS } from "../agent-actions/actions";
import { agentActions, AgentActionUnsupportedError, AgentActionValidationError } from "../agent-actions/registry";
import { RUNTIME_LAYER_IDS, type ProjectSession } from "../project/project-session";
import type { LayerController } from "./layer-controller";
import { patchNativePointStyle, readNativePointStyle } from "./native-point-style";
import { patchNativeLineStyle, readNativeLineStyle } from "./native-line-style";
import { patchNativePolygonStyle, readNativePolygonStyle } from "./native-polygon-style";

/** Ordinary vector UI and API edits share validation and the existing persistence path. */
export function registerLayerStyleAction(session: ProjectSession, controller: LayerController, assertCanApply?: (layerId: number) => void): void {
  agentActions.register(AGENT_DECLARATIONS[AGENT_ACTIONS.layerSetStyle], params => {
    const layerId = params.layerId as number;
    const layer = session.getLayer(layerId);
    if (!layer) throw new AgentActionValidationError(`Unknown layer ${layerId}.`);
    if (![ProjectLayerType.Point, ProjectLayerType.Line, ProjectLayerType.Polygon].includes(layer.type) || (Object.values(RUNTIME_LAYER_IDS) as number[]).includes(layerId)) {
      throw new AgentActionUnsupportedError("layer.setStyle currently supports ordinary Point, Line and Polygon instances. GPU point styling uses points.setStyle.");
    }
    if (layer.type === ProjectLayerType.Polygon) {
      const style = patchNativePolygonStyle(layer.polygonStyle, params.style);
      assertCanApply?.(layerId);
      controller.setPolygonStyle(layerId, style);
      return { data: { layerId, style: readNativePolygonStyle(session.getLayer(layerId)!.polygonStyle) } };
    }
    if (layer.type === ProjectLayerType.Line) {
      const style = patchNativeLineStyle(layer.lineStyle, params.style);
      assertCanApply?.(layerId);
      controller.setLineStyle(layerId, style);
      return { data: { layerId, style: readNativeLineStyle(session.getLayer(layerId)!.lineStyle) } };
    }
    const style = patchNativePointStyle(layer.pointStyle, params.style);
    assertCanApply?.(layerId);
    controller.setPointStyle(layerId, style);
    return { data: { layerId, style: readNativePointStyle(session.getLayer(layerId)!.pointStyle) } };
  });
}
