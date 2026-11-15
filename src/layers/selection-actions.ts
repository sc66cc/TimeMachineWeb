import { agentActions, AgentActionUnsupportedError } from "../agent-actions/registry";
import { AGENT_DECLARATIONS, type AgentActionId } from "../agent-actions/actions";
import { redactSensitive, type AgentActionHandler, type AgentActionParam } from "../agent-actions/types";
import type { ApiSchema } from "../agent-actions/contracts";
import { summarizeFeatureAttributes } from "./feature-attributes";
import { FeatureSelection, type SelectionKey, type SelectionSource } from "./selection";

export interface SelectionFeature {
  owner: object;
  sourceRef: string;
  attributes: Record<string, unknown> | null;
  selectable: boolean;
}
export interface SelectionActionPorts {
  assertViewport(viewportId: string): void;
  /** Throws on an unknown feature or an unavailable source; null attributes are valid. */
  readFeature(key: SelectionKey): SelectionFeature;
}

export function selectFeature(selection: FeatureSelection, ports: SelectionActionPorts, key: SelectionKey, source: SelectionSource): void {
  ports.assertViewport(key.viewportId);
  const feature = ports.readFeature(key);
  if (!feature.selectable) throw new AgentActionUnsupportedError("This feature is not selectable in the current committed view.");
  selection.select(key, source, feature.owner);
}

export function clearFeatureSelection(selection: FeatureSelection, ports: SelectionActionPorts, viewportId: string, source: SelectionSource): void {
  ports.assertViewport(viewportId);
  if (selection.snapshot().key === null || selection.snapshot().key?.viewportId === viewportId) selection.clear(source);
  else selection.invalidatePending();
}

const keySchema: ApiSchema = {
  type: "object", additionalProperties: false, required: ["viewportId", "layerId", "featureId"],
  properties: { viewportId: { type: "string", minLength: 1 }, layerId: { type: "integer", minimum: 1 }, featureId: { type: "string", minLength: 1 } },
};
const viewportSchema: ApiSchema = {
  type: "object", additionalProperties: false, required: ["viewportId"],
  properties: { viewportId: { type: "string", minLength: 1 } },
};
const selectionSchema: ApiSchema = {
  type: "object", additionalProperties: false, required: ["selection"], properties: {
    selection: { type: "object", additionalProperties: false, required: ["key", "source"], properties: {
      key: { oneOf: [keySchema, { type: "null" }] }, source: { type: "string", enum: ["ui", "api", "runtime"] },
    } },
  },
};

/** Registers only executable select/clear/read operations. Pick/box remain reserved. */
export function registerSelectionActions(selection: FeatureSelection, ports: SelectionActionPorts): void {
  const register = (id: string, kind: "command" | "query", description: string,
    params: readonly AgentActionParam[], inputSchema: ApiSchema, outputSchema: ApiSchema, handler: AgentActionHandler): void => {
    agentActions.register(AGENT_DECLARATIONS[id as AgentActionId] ?? { id, title: id, description, status: "ready", params }, handler);
    agentActions.setContract(id, {
      kind, scope: "p0-p3", effect: kind === "query" ? "read" : "ui-local", completion: "state-committed",
      requirements: ["existing-viewport", "current-source-owner"],
      completionNote: kind === "query" ? "Read only; no selection change, persistence, job or frame event."
        : "Selection state and inspector update only; no project persistence, job or frame guarantee.",
    }, async () => ({ inputSchema, outputSchema, examples: [] }));
  };
  const keyParam: AgentActionParam = { name: "key", type: "object", required: true, description: "Complete viewport, layer and feature identity." };
  const viewportParam: AgentActionParam = { name: "viewportId", type: "string", required: true, description: "Existing viewport identifier." };
  const readKey = (params: Record<string, unknown>): SelectionKey => {
    const key = params.key as SelectionKey;
    ports.assertViewport(key.viewportId);
    return key;
  };
  const snapshotFor = (viewportId: string) => {
    const snapshot = selection.snapshot();
    return snapshot.key && snapshot.key.viewportId !== viewportId ? { key: null, source: "runtime" } : snapshot;
  };
  register("feature.select", "command", "Select an existing visible feature through the same owner used by the UI.", [keyParam],
    { type: "object", additionalProperties: false, required: ["key"], properties: { key: keySchema } }, selectionSchema, params => {
      selectFeature(selection, ports, params.key as SelectionKey, "api");
      return { data: { selection: selection.snapshot() } };
    });
  register("feature.clear", "command", "Clear the target viewport's selection and inspector.", [viewportParam], viewportSchema, selectionSchema, params => {
    clearFeatureSelection(selection, ports, params.viewportId as string, "api");
    return { data: { selection: snapshotFor(params.viewportId as string) } };
  });
  register("selection.snapshot", "query", "Read authoritative selection without changing it.", [viewportParam], viewportSchema, selectionSchema, params => {
    ports.assertViewport(params.viewportId as string);
    return { data: { selection: snapshotFor(params.viewportId as string) } };
  });
  register("feature.attributes", "query", "Read a bounded, redacted source-attribute projection. Hidden existing features may be read without selecting them.",
    [keyParam, { name: "fields", type: "array", description: "Optional unique field names; maximum32, each at most128 characters." }],
    { type: "object", additionalProperties: false, required: ["key"], properties: { key: keySchema, fields: { type: "array", items: { type: "string", minLength: 1 } } } },
    { type: "object", additionalProperties: false, required: ["key", "sourceRef", "attributes", "missingFields", "truncated"], properties: {
      key: keySchema, sourceRef: { type: "string" }, attributes: { type: ["object", "null"], additionalProperties: true },
      missingFields: { type: "array", items: { type: "string" } }, truncated: { type: "boolean" },
    } }, params => {
      const key = readKey(params), feature = ports.readFeature(key);
      const summary = summarizeFeatureAttributes(feature.attributes, params.fields === undefined ? undefined : { fields: params.fields as string[] });
      // Account for the facade's additional wrapper depth before advertising completeness.
      // Both trees are already bounded by the summary helper; no dataset is copied here.
      const attributes = redactSensitive(summary.attributes, 1);
      const truncated = summary.truncated || JSON.stringify(attributes) !== JSON.stringify(summary.attributes);
      return { data: { key, sourceRef: feature.sourceRef, ...summary, attributes, truncated } };
    });
}
