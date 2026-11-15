import { ProjectLayerType } from "@timemachine/generated-api";
import { AGENT_ACTIONS, AGENT_DECLARATIONS } from "../agent-actions/actions";
import { agentActions, AgentActionBusyError, AgentActionUnsupportedError, AgentActionValidationError } from "../agent-actions/registry";
import { validateApiInput } from "../agent-actions/contracts";
import { OperationInterruptedError } from "../agent-actions/operation";
import { RUNTIME_LAYER_IDS, type ProjectLayerSnapshot, type ProjectSession } from "../project/project-session";
import { layerInstanceInputSchema } from "./instance-action-schema";
import { defaultNativePointStyle } from "./native-point-style";
import { defaultNativeLineStyle } from "./native-line-style";
import { defaultNativePolygonStyle } from "./native-polygon-style";

export const SYNTHETIC_POINT_SOURCE = "fixture:goal-points-v1";
export const SYNTHETIC_LINE_SOURCE = "fixture:goal-lines-v1";
export const SYNTHETIC_POLYGON_SOURCE = "fixture:goal-polygons-v1";
export const SINGLE_RASTER_SOURCE = "local:single-raster-manifest";
export const PALEO_ATLAS_SOURCE = "local:paleoatlas-manifest";
export type LayerInstanceInput = Pick<ProjectLayerSnapshot, "name" | "type" | "sourceRef" | "groupId" | "active" | "alpha"> & { rasterId?: string };
export interface LayerInstanceAdapter {
  assertCanAdd(input: LayerInstanceInput): void;
  /** Resolves after the candidate's native frame; rejects after owned cleanup. */
  load(layerId: number, sourceRef: string, signal?: AbortSignal): Promise<void>;
  /** Resolves after release/removal frame; cancelledLoad retains an explicit cancelled-load error on the business record. */
  remove(layerId: number, cancelledLoad?: boolean): Promise<void>;
  /** Keeps the business record; resolves only after cleanup and the replacement frame. */
  retry?(layerId: number, signal?: AbortSignal): Promise<void>;
  publish(): void;
  persist(): void;
}

export function registerLayerInstanceActions(session: ProjectSession, adapter: LayerInstanceAdapter): { isRetrying(layerId: number): boolean } {
  const retrying = new Set<number>();
  const removing = new Map<number, number>();
  agentActions.register(AGENT_DECLARATIONS[AGENT_ACTIONS.layerAdd], async (params, context) => {
    const invalid = validateApiInput(layerInstanceInputSchema, params.layer);
    if (invalid) throw new AgentActionValidationError(invalid);
    const input = params.layer as LayerInstanceInput;
    if (!input.name.trim() || !session.getGroup(input.groupId)) throw new AgentActionValidationError("A nonblank layer name and existing group are required.");
    if (Object.hasOwn(input, "rasterId") && (input.type !== ProjectLayerType.Raster || !input.rasterId?.trim())) {
      throw new AgentActionValidationError("rasterId must be a nonblank string supplied only for a Raster layer.");
    }
    if (!((input.type === ProjectLayerType.Point && input.sourceRef === SYNTHETIC_POINT_SOURCE) ||
      (input.type === ProjectLayerType.Line && input.sourceRef === SYNTHETIC_LINE_SOURCE) ||
      (input.type === ProjectLayerType.Polygon && input.sourceRef === SYNTHETIC_POLYGON_SOURCE) ||
      (input.type === ProjectLayerType.Raster && input.sourceRef === SINGLE_RASTER_SOURCE) ||
      (input.type === ProjectLayerType.Atlas && input.sourceRef === PALEO_ATLAS_SOURCE))) {
      throw new AgentActionUnsupportedError("This layer binding supports matching synthetic vector samples or the local Raster/Atlas manifests. No service fallback is performed.");
    }
    if (context?.signal?.aborted) throw new OperationInterruptedError("cancelled");
    adapter.assertCanAdd(input);
    const layerId = session.addLayer({ ...input, ...(input.type === ProjectLayerType.Polygon
      ? { polygonStyle: defaultNativePolygonStyle() } : input.type === ProjectLayerType.Line
        ? { lineStyle: defaultNativeLineStyle() } : input.type === ProjectLayerType.Point ? { pointStyle: defaultNativePointStyle() } : {}) });
    adapter.publish();
    adapter.persist();
    await adapter.load(layerId, input.sourceRef, context?.signal);
    if (context?.signal?.aborted) {
      // Cancellation can arrive between the runtime's resolving microtask and
      // this continuation. Do not leave a visible candidate behind that result.
      await adapter.remove(layerId, true);
      throw new OperationInterruptedError("cancelled");
    }
    if (!session.getLayer(layerId)) throw new OperationInterruptedError("superseded");
    return { data: { layerId, sourceRef: input.sourceRef, frameConfirmed: true } };
  });
  agentActions.register(AGENT_DECLARATIONS[AGENT_ACTIONS.layerRemove], async params => {
    const layerId = params.layerId as number;
    const layer = session.getLayer(layerId);
    if (!layer) throw new AgentActionValidationError(`Unknown layer ${layerId}.`);
    if ((Object.values(RUNTIME_LAYER_IDS) as number[]).includes(layerId) || ![ProjectLayerType.Point, ProjectLayerType.Line, ProjectLayerType.Polygon, ProjectLayerType.Raster, ProjectLayerType.Atlas].includes(layer.type)) {
      throw new AgentActionUnsupportedError("This removal binding supports non-default Point, Line, Polygon, Raster and Atlas instances only.");
    }
    if (retrying.has(layerId)) throw new AgentActionBusyError("Wait for this layer retry to finish before removing it.");
    removing.set(layerId, (removing.get(layerId) ?? 0) + 1);
    try {
      await adapter.remove(layerId);
      // Concurrent removals can share the runtime's release completion.
      if (session.getLayer(layerId)) {
        session.removeLayer(layerId);
        adapter.publish();
        adapter.persist();
      }
      return { data: { layerId, removed: true, frameConfirmed: true } };
    } finally {
      const remaining = removing.get(layerId)! - 1;
      if (remaining) removing.set(layerId, remaining); else removing.delete(layerId);
    }
  });
  agentActions.register(AGENT_DECLARATIONS[AGENT_ACTIONS.layerRetry], async (params, context) => {
    const layerId = params.layerId as number;
    const layer = session.getLayer(layerId);
    if (!layer) throw new AgentActionValidationError(`Unknown layer ${layerId}.`);
    if (!adapter.retry || layerId === RUNTIME_LAYER_IDS.points || layerId === RUNTIME_LAYER_IDS.plateModel || !(
      (layer.type === ProjectLayerType.Point && layer.sourceRef === SYNTHETIC_POINT_SOURCE) ||
      (layer.type === ProjectLayerType.Line && layer.sourceRef === SYNTHETIC_LINE_SOURCE) ||
      (layer.type === ProjectLayerType.Polygon && layer.sourceRef === SYNTHETIC_POLYGON_SOURCE) ||
      (layer.type === ProjectLayerType.Raster && layer.sourceRef === SINGLE_RASTER_SOURCE) ||
      (layer.type === ProjectLayerType.Atlas && layer.sourceRef === PALEO_ATLAS_SOURCE)
    )) throw new AgentActionUnsupportedError("Retry is available only for implemented vector samples and Raster/Atlas sources.");
    if (retrying.has(layerId) || removing.has(layerId)) throw new AgentActionBusyError("This layer is already retrying or being removed.");
    if (context?.signal?.aborted) throw new OperationInterruptedError("cancelled");
    retrying.add(layerId);
    try {
      await adapter.retry(layerId, context?.signal);
      if (context?.signal?.aborted) {
        await adapter.remove(layerId, true);
        throw new OperationInterruptedError("cancelled");
      }
      if (!session.getLayer(layerId)) throw new OperationInterruptedError("superseded");
      return { data: { layerId, sourceRef: layer.sourceRef, frameConfirmed: true } };
    } finally { retrying.delete(layerId); }
  });
  return { isRetrying: layerId => retrying.has(layerId) };
}
