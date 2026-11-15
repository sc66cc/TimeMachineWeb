import {
  ProjectDocumentV2TO,
  ProjectLayerTO,
  ProjectLayerType,
} from "@timemachine/generated-api";
import {
  DEFAULT_POINT_STYLE,
  normalizePointStyleExpression,
  type PointStyleExpression,
} from "@timemachine/point-runtime";
import { defaultNativePointStyle } from "../layers/native-point-style";
import { defaultNativeLineStyle, type NativeLineStyle } from "../layers/native-line-style";
import { defaultNativePolygonStyle, type NativePolygonStyle } from "../layers/native-polygon-style";
import { LOCAL_PROJECT_DRAFT_KEY, parseProjectCloudContext, writeProjectDraft, type ProjectCloudContext } from "./project-cloud-context";
export { LOCAL_PROJECT_DRAFT_KEY } from "./project-cloud-context";

export const RUNTIME_LAYER_IDS = {
  atlas: 1,
  points: 2,
  raster: 3,
  plateModel: 4,
} as const;

export const RUNTIME_LAYER_GROUP_IDS = {
  data: 101,
  reconstruction: 102,
} as const;

export interface CameraSnapshot {
  direction: readonly [number, number, number];
  position: readonly [number, number, number];
  up: readonly [number, number, number];
}

export interface ProjectLayerSnapshot {
  active: boolean;
  alpha: number;
  groupId: number;
  id: number;
  name: string;
  pointStyle?: PointStyleExpression;
  lineStyle?: NativeLineStyle;
  polygonStyle?: NativePolygonStyle;
  /** Stored raw value is preserved for forward compatibility; use getRasterId for a validated ID. */
  rasterId?: unknown;
  sourceRef: string;
  type: ProjectLayerType;
}

export interface ProjectLayerGroupSnapshot {
  parentId?: number;
  active: boolean;
  alpha: number;
  collapsed: boolean;
  id: number;
  name: string;
}

export interface ProjectSessionSnapshot {
  camera?: CameraSnapshot;
  currentTimeMa: number;
  groups: ProjectLayerGroupSnapshot[];
  layers: ProjectLayerSnapshot[];
  name: string;
  savedAt: string;
  schemaVersion: 2;
  /** Highest allocated layer/group ID, including removed records. Older v2 drafts omit it. */
  lastId?: number;
  /** Optional v2 compatibility envelope. Kept locally; never uploaded as a DTO field. */
  cloudDocument?: Record<string, unknown>;
  /** Local project ownership and cloud revision; omitted from cloud DTO export. */
  cloudContext?: ProjectCloudContext;
}

export interface ProjectCompatibilityIssue {
  path: string;
  code: string;
  message: string;
  preserved: boolean;
}

export interface ProjectCompatibilityReport {
  source: "new" | "local" | "cloud";
  schemaVersion: number | null;
  writable: boolean;
  /** Unknown local fields can remain locally editable without a lossless cloud DTO mapping. */
  cloudWritable: boolean;
  issues: ProjectCompatibilityIssue[];
}

export interface ProjectLocalSaveState {
  status: "dirty" | "saving" | "saved" | "error" | "readonly";
  revision: number;
  savedRevision?: number;
  savedAt?: string;
  message?: string;
}

export interface ProjectRestoreResult {
  status: "empty" | "restored" | "readonly" | "invalid" | "unavailable";
  session?: ProjectSession;
  compatibility: ProjectCompatibilityReport;
  /** Original bytes for an explicit local export, never for diagnostic logging. */
  original?: string;
}

interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Its messages are module-owned descriptions with no input values. */
class ProjectDataError extends Error {}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Match the existing RPC JSON representation, but reject data JSON would silently lose. */
function cloneJSON<T>(input: T): T {
  const ancestors = new Set<object>();
  const copy = (value: unknown): unknown => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || !value || ancestors.has(value)) {
      throw new ProjectDataError("Project data must contain finite, acyclic JSON values.");
    }
    if (value instanceof Date) {
      if (!Number.isFinite(value.getTime())) throw new ProjectDataError("Project date must be valid.");
      return value.toISOString();
    }
    ancestors.add(value);
    let result: unknown;
    if (Array.isArray(value)) result = value.map(copy);
    else {
      const entries = value instanceof Map ? [...value] : Object.entries(value);
      result = Object.fromEntries(entries.map(([key, item]) => {
        if (typeof key !== "string") throw new ProjectDataError("Project map keys must be strings.");
        return [key, copy(item)];
      }));
    }
    ancestors.delete(value);
    return result;
  };
  return copy(input) as T;
}

function equalValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => equalValue(item, right[index]));
  if (!record(left) || !record(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equalValue(left[key], right[key]));
}

function reportFor(source: ProjectCompatibilityReport["source"], schemaVersion: unknown = 2): ProjectCompatibilityReport {
  return { source, schemaVersion: typeof schemaVersion === "number" && Number.isFinite(schemaVersion) ? schemaVersion : null, writable: true, cloudWritable: true, issues: [] };
}

function reportIssue(report: ProjectCompatibilityReport, path: string, code: string, message: string, readonly = false): void {
  report.issues.push({ path, code, message, preserved: true });
  if (readonly) { report.writable = false; report.cloudWritable = false; }
}

function reportUnknownFields(report: ProjectCompatibilityReport, value: Record<string, unknown>, keys: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      reportIssue(report, `${path}.${key}`, "preserved-field", report.source === "local"
        ? "This field is preserved in local drafts; cloud export requires a compatible DTO mapping."
        : "This field is preserved without being interpreted by the Web client.");
      if (report.source === "local") report.cloudWritable = false;
    }
  }
}

function inspectSensitiveFields(value: unknown, report: ProjectCompatibilityReport, path = "$"): void {
  if (typeof value === "string") {
    if (/[?&](?:x-amz-signature|x-goog-signature|signature|access_token|token)=/i.test(value)) {
      reportIssue(report, path, "nonpersistent-data", "A temporary signed URL cannot be persisted.", true);
    } else if (/^\s*[\[{]/.test(value)) {
      let nested: unknown;
      try { nested = JSON.parse(value); } catch { return; /* Opaque extensions remain strings. */ }
      inspectSensitiveFields(nested, report, path);
    }
  } else if (record(value) || Array.isArray(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:(?:access|refresh|session|auth|id)[_-]?)?token$|^(?:password|passwd|secret|client[_-]?secret|authorization|credentials?)$/i.test(key) && item !== "" && item !== null && item !== 0 && item !== false) {
        reportIssue(report, `${path}.${key}`, "nonpersistent-data", "Credential-like data cannot be persisted.", true);
      } else inspectSensitiveFields(item, report, `${path}.${key}`);
    }
  }
}

function normalization(report: ProjectCompatibilityReport, path: string): void {
  reportIssue(report, path, "normalization-required", "Opening this value requires normalization; the original remains read-only.", true);
}

function legacyDefault(report: ProjectCompatibilityReport, path: string): void {
  reportIssue(report, path, "legacy-default", "The existing v2 compatibility default supplies this missing value.");
}

function serializePersistentSnapshot(snapshot: ProjectSessionSnapshot): string {
  const serialized = JSON.stringify(snapshot, (_key, value: unknown) => {
    if ((typeof value === "number" && !Number.isFinite(value)) || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") throw new ProjectDataError("Project data must contain only finite JSON values.");
    return value;
  });
  const check = reportFor("local");
  inspectSensitiveFields(JSON.parse(serialized), check);
  if (!check.writable) throw new ProjectDataError("Project contains credential-like data or a temporary signed URL and cannot be persisted.");
  return serialized;
}

function knownLayerType(type: unknown): type is ProjectLayerType {
  return Number.isInteger(type) && (type as number) >= ProjectLayerType.Point && (type as number) <= ProjectLayerType.PlateModel;
}

const DEFAULT_GROUPS: readonly ProjectLayerGroupSnapshot[] = [
  {
    active: true,
    alpha: 1,
    collapsed: false,
    id: RUNTIME_LAYER_GROUP_IDS.data,
    name: "Data layers",
  },
  {
    active: true,
    alpha: 1,
    collapsed: false,
    id: RUNTIME_LAYER_GROUP_IDS.reconstruction,
    name: "Reconstruction",
  },
];

const DEFAULT_LAYERS: readonly ProjectLayerSnapshot[] = [
  {
    active: true,
    alpha: 1,
    groupId: RUNTIME_LAYER_GROUP_IDS.data,
    id: RUNTIME_LAYER_IDS.atlas,
    name: "1 Phanerozoic paleogeographic maps",
    sourceRef: "local:paleoatlas-manifest",
    type: ProjectLayerType.Atlas,
  },
  {
    active: true,
    alpha: 1,
    groupId: RUNTIME_LAYER_GROUP_IDS.data,
    id: RUNTIME_LAYER_IDS.points,
    name: "PBDB point dataset",
    pointStyle: normalizePointStyleExpression(DEFAULT_POINT_STYLE),
    sourceRef: "local:pbdb-wgp1",
    type: ProjectLayerType.Point,
  },
  {
    active: true,
    alpha: 0.9,
    groupId: RUNTIME_LAYER_GROUP_IDS.data,
    id: RUNTIME_LAYER_IDS.raster,
    name: "Single raster layer",
    sourceRef: "local:single-raster-manifest",
    type: ProjectLayerType.Raster,
  },
  {
    active: true,
    alpha: 1,
    groupId: RUNTIME_LAYER_GROUP_IDS.reconstruction,
    id: RUNTIME_LAYER_IDS.plateModel,
    name: "Plate model",
    sourceRef: "local:paleomap-plate-model",
    type: ProjectLayerType.PlateModel,
  },
];

function cloneGroup(
  group: ProjectLayerGroupSnapshot,
): ProjectLayerGroupSnapshot {
  return structuredClone(group);
}

function defaultGroupId(type: ProjectLayerType): number {
  return type === ProjectLayerType.PlateModel
    ? RUNTIME_LAYER_GROUP_IDS.reconstruction
    : RUNTIME_LAYER_GROUP_IDS.data;
}

function cloneLayer(layer: ProjectLayerSnapshot): ProjectLayerSnapshot {
  return {
    ...structuredClone(layer),
    lineStyle: layer.type === ProjectLayerType.Line ? cloneNativeLineStoredStyle(layer.lineStyle) : structuredClone(layer.lineStyle),
    polygonStyle: layer.type === ProjectLayerType.Polygon ? cloneNativePolygonStoredStyle(layer.polygonStyle) : structuredClone(layer.polygonStyle),
    rasterId: cloneRasterStoredId(layer.rasterId),
    pointStyle: layer.type === ProjectLayerType.Point && layer.id !== RUNTIME_LAYER_IDS.points
      ? cloneNativeStoredStyle(layer.pointStyle)
      : layer.type === ProjectLayerType.Point && layer.pointStyle
      ? normalizePointStyleExpression(layer.pointStyle)
      : structuredClone(layer.pointStyle),
  };
}

/** Preserve explicit values for runtime validation instead of silently repairing unsupported native styles. */
function cloneNativeStoredStyle(style: unknown): PointStyleExpression {
  return style === undefined ? defaultNativePointStyle() : structuredClone(style) as PointStyleExpression;
}

function cloneNativeLineStoredStyle(style: unknown): NativeLineStyle {
  return style === undefined ? defaultNativeLineStyle() : structuredClone(style) as NativeLineStyle;
}

function cloneNativePolygonStoredStyle(style: unknown): NativePolygonStyle {
  return style === undefined ? defaultNativePolygonStyle() : structuredClone(style) as NativePolygonStyle;
}

function cloneRasterStoredId(value: unknown): unknown {
  const copy = structuredClone(value);
  const pending: unknown[] = [copy];
  const visited = new Set<object>();
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "number" && !Number.isFinite(item)) throw new ProjectDataError("Stored raster ID must contain only finite JSON numbers.");
    if (item !== null && typeof item === "object" && !visited.has(item)) {
      visited.add(item);
      for (const nested of Object.values(item)) pending.push(nested);
    }
  }
  return copy;
}

function isFiniteTuple(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((component) => Number.isFinite(component))
  );
}

type LayerPathNode = ProjectDocumentV2TO["LayerPathTree"]["ChildList"][number];

function isProjectId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validateTree(groups: readonly ProjectLayerGroupSnapshot[], layers: readonly ProjectLayerSnapshot[]): number {
  const ids = new Set<number>();
  let maximum = RUNTIME_LAYER_GROUP_IDS.reconstruction as number;
  for (const record of [...groups, ...layers]) {
    if (!isProjectId(record.id) || ids.has(record.id)) throw new ProjectDataError("Project IDs must be positive safe integers and unique across layers and groups.");
    ids.add(record.id);
    maximum = Math.max(maximum, record.id);
  }
  const byId = new Map(groups.map(group => [group.id, group]));
  for (const group of groups) {
    const ancestors = new Set<number>([group.id]);
    let parentId = group.parentId;
    while (parentId !== undefined) {
      if (!isProjectId(parentId) || !byId.has(parentId)) throw new ProjectDataError("Layer group parent must exist.");
      if (ancestors.has(parentId)) throw new ProjectDataError("Layer groups must not contain a cycle.");
      ancestors.add(parentId);
      parentId = byId.get(parentId)!.parentId;
    }
  }
  if (layers.some(layer => !byId.has(layer.groupId))) throw new ProjectDataError("Layer target group must exist.");
  return maximum;
}

function restoredLastId(value: unknown, maximum: number): number {
  if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) {
    throw new ProjectDataError("Project lastId must be a nonnegative safe integer.");
  }
  return Math.max(maximum, (value as number | undefined) ?? 0);
}

function parseSnapshot(serialized: string, report = reportFor("local")): ProjectSessionSnapshot {
  const value = JSON.parse(serialized) as Partial<ProjectSessionSnapshot>;
  if (
    !record(value) ||
    value.schemaVersion !== 2 ||
    typeof value.name !== "string" ||
    !Number.isFinite(value.currentTimeMa) ||
    !Array.isArray(value.layers)
  ) {
    throw new ProjectDataError("Stored project draft does not match schema version 2.");
  }
  reportUnknownFields(report, value, ["camera", "currentTimeMa", "groups", "layers", "name", "savedAt", "schemaVersion", "lastId", "cloudDocument", "cloudContext"], "$");
  try { parseProjectCloudContext(value.cloudContext); }
  catch { throw new ProjectDataError("The local cloud context is invalid. Review the original project before saving."); }
  inspectSensitiveFields(value, report);
  if (value.currentTimeMa! < 0) normalization(report, "$.currentTimeMa");
  if (value.groups === undefined) legacyDefault(report, "$.groups");
  if (value.lastId === undefined) legacyDefault(report, "$.lastId");
  if (typeof value.savedAt !== "string") legacyDefault(report, "$.savedAt");

  const groups =
    value.groups === undefined
      ? DEFAULT_GROUPS.map(cloneGroup)
      : value.groups.map((group) => {
          if (
            typeof group !== "object" ||
            group === null ||
            !Number.isInteger(group.id) ||
            typeof group.name !== "string" ||
            typeof group.active !== "boolean" ||
            typeof group.collapsed !== "boolean" ||
            !Number.isFinite(group.alpha)
          ) {
            throw new ProjectDataError(
              "Stored project draft contains an invalid layer group.",
            );
          }
          reportUnknownFields(report, group as unknown as Record<string, unknown>, ["active", "alpha", "collapsed", "id", "name", "parentId"], `$.groups[${group.id}]`);
          if (group.alpha < 0 || group.alpha > 1) normalization(report, `$.groups[${group.id}].alpha`);
          return {
            ...structuredClone(group),
            active: group.active,
            alpha: Math.min(1, Math.max(0, group.alpha)),
            collapsed: group.collapsed,
            id: group.id,
            name: group.name,
            ...(group.parentId !== undefined ? { parentId: group.parentId } : {}),
          };
        });
  const groupIds = new Set(groups.map((group) => group.id));
  const layers = value.layers.map((layer) => {
    if (
      typeof layer !== "object" ||
      layer === null ||
      !Number.isInteger(layer.id) ||
      typeof layer.name !== "string" ||
      typeof layer.sourceRef !== "string" ||
      typeof layer.active !== "boolean" ||
      !Number.isFinite(layer.alpha) ||
      !Number.isInteger(layer.type)
    ) {
      throw new ProjectDataError("Stored project draft contains an invalid layer.");
    }
    const type = layer.type as ProjectLayerType;
    reportUnknownFields(report, layer as unknown as Record<string, unknown>, ["active", "alpha", "groupId", "id", "name", "pointStyle", "lineStyle", "polygonStyle", "rasterId", "sourceRef", "type"], `$.layers[${layer.id}]`);
    if (!knownLayerType(type)) reportIssue(report, `$.layers[${layer.id}].type`, "unsupported-layer", "This layer type is preserved but cannot execute in the Web client.", true);
    if (layer.alpha < 0 || layer.alpha > 1) normalization(report, `$.layers[${layer.id}].alpha`);
    if (type === ProjectLayerType.Point && layer.id === RUNTIME_LAYER_IDS.points && layer.pointStyle !== undefined && !equalValue(layer.pointStyle, normalizePointStyleExpression(layer.pointStyle))) normalization(report, `$.layers[${layer.id}].pointStyle`);
    const preferredGroupId = defaultGroupId(type);
    if (layer.groupId === undefined) legacyDefault(report, `$.layers[${layer.id}].groupId`);
    const fallbackGroupId = groupIds.has(preferredGroupId)
      ? preferredGroupId
      : groups[0]?.id;
    if (fallbackGroupId === undefined) {
      throw new ProjectDataError(
        "Stored project draft must contain at least one layer group.",
      );
    }
    return {
      ...structuredClone(layer),
      active: layer.active,
      alpha: Math.min(1, Math.max(0, layer.alpha)),
      groupId:
        layer.groupId === undefined ? fallbackGroupId : layer.groupId,
      id: layer.id,
      name: layer.name,
      lineStyle: type === ProjectLayerType.Line ? cloneNativeLineStoredStyle(layer.lineStyle) : layer.lineStyle,
      polygonStyle: type === ProjectLayerType.Polygon ? cloneNativePolygonStoredStyle(layer.polygonStyle) : layer.polygonStyle,
      rasterId: cloneRasterStoredId(layer.rasterId),
      pointStyle:
        type === ProjectLayerType.Point
          ? layer.id === RUNTIME_LAYER_IDS.points
            ? normalizePointStyleExpression(layer.pointStyle)
            : cloneNativeStoredStyle(layer.pointStyle)
          : layer.pointStyle,
      sourceRef: layer.sourceRef,
      type,
    };
  });

  cloneJSON(value);
  const lastId = restoredLastId(value.lastId, validateTree(groups, layers));
  const camera = value.camera;
  const parsedCamera =
    camera &&
    isFiniteTuple(camera.position) &&
    isFiniteTuple(camera.direction) &&
    isFiniteTuple(camera.up)
      ? {
          ...structuredClone(camera),
          position: camera.position,
          direction: camera.direction,
          up: camera.up,
        }
      : undefined;
  if (camera !== undefined && parsedCamera === undefined) normalization(report, "$.camera");

  return {
    ...value,
    camera: parsedCamera,
    currentTimeMa: Math.max(0, value.currentTimeMa ?? 0),
    groups,
    layers,
    name: value.name,
    savedAt:
      typeof value.savedAt === "string"
        ? value.savedAt
        : new Date(0).toISOString(),
    schemaVersion: 2,
    lastId,
  };
}

function parsePointStyleExtension(
  serialized: string | undefined,
  layerId: number = RUNTIME_LAYER_IDS.points,
): PointStyleExpression {
  if (layerId !== RUNTIME_LAYER_IDS.points) {
    if (serialized === undefined) return defaultNativePointStyle();
    try { return cloneNativeStoredStyle(JSON.parse(serialized)); }
    catch { throw new ProjectDataError("Stored ordinary point style must contain valid JSON."); }
  }
  if (!serialized) {
    return normalizePointStyleExpression(DEFAULT_POINT_STYLE);
  }
  try {
    return normalizePointStyleExpression(JSON.parse(serialized));
  } catch {
    return normalizePointStyleExpression(DEFAULT_POINT_STYLE);
  }
}

function parseLineStyleExtension(serialized: string | undefined): NativeLineStyle {
  if (serialized === undefined) return defaultNativeLineStyle();
  try { return cloneNativeLineStoredStyle(JSON.parse(serialized)); }
  catch { throw new ProjectDataError("Stored ordinary line style must contain valid JSON."); }
}

function parsePolygonStyleExtension(serialized: string | undefined): NativePolygonStyle {
  if (serialized === undefined) return defaultNativePolygonStyle();
  try { return cloneNativePolygonStoredStyle(JSON.parse(serialized)); }
  catch { throw new ProjectDataError("Stored ordinary polygon style must contain valid JSON."); }
}

function parseRasterIdExtension(serialized: string | undefined): unknown {
  if (serialized === undefined) return undefined;
  let value: unknown;
  try { value = JSON.parse(serialized) as unknown; }
  catch { throw new ProjectDataError("Stored raster ID must contain valid JSON."); }
  return cloneRasterStoredId(value);
}

function checkedRasterId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new ProjectDataError("Raster ID must be a nonempty string.");
  return value;
}

export class ProjectSession {
  private camera: CameraSnapshot | undefined;
  private currentTimeMa = 0;
  private readonly groups = new Map<
    number,
    ProjectLayerGroupSnapshot
  >();
  private readonly layers = new Map<number, ProjectLayerSnapshot>();
  private name: string;
  private lastId: number = RUNTIME_LAYER_GROUP_IDS.reconstruction;
  private compatibility = reportFor("new");
  private saveState: ProjectLocalSaveState = { status: "dirty", revision: 0 };
  private originalSource: string | undefined;
  private localBaseline: Record<string, unknown> | undefined;
  private contextId: string | undefined;
  private documentBaseline: Record<string, unknown> | undefined;
  private documentReference: { layers: ProjectLayerSnapshot[]; groups: ProjectLayerGroupSnapshot[]; camera?: CameraSnapshot } | undefined;

  constructor(name = "Untitled_6/5/2025 6:10:11 AM") {
    this.name = name;
    for (const group of DEFAULT_GROUPS) {
      this.groups.set(group.id, cloneGroup(group));
    }
    for (const layer of DEFAULT_LAYERS) {
      this.layers.set(layer.id, cloneLayer(layer));
    }
  }

  static fromDocument(document: ProjectDocumentV2TO): ProjectSession {
    const original = cloneJSON(document) as unknown as Record<string, unknown>;
    if (record(original) && typeof original.SchemaVersion === "number" && original.SchemaVersion > 2) {
      return ProjectSession.readonlyOriginal(JSON.stringify(original), original, "cloud");
    }
    if (
      !record(original) ||
      document.SchemaVersion !== 2 ||
      typeof document.Name !== "string" ||
      !Number.isFinite(document.CurrentTimeMa) ||
      !Array.isArray(document.LayerList)
    ) {
      throw new ProjectDataError("Cloud project does not match schema version 2.");
    }
    // Use a detached JSON baseline, including DTO fields the current Web UI does not edit.
    document = original as unknown as ProjectDocumentV2TO;
    const session = new ProjectSession(document.Name);
    session.originalSource = JSON.stringify(original);
    session.documentBaseline = original;
    session.compatibility = reportFor("cloud", original.SchemaVersion);
    const report = session.compatibility;
    reportUnknownFields(report, original, Object.keys(new ProjectDocumentV2TO()), "$");
    inspectSensitiveFields(original, report);
    if (Object.hasOwn(original, "cloudDocument")) reportIssue(report, "$.cloudDocument", "reserved-envelope", "A local compatibility envelope cannot be uploaded as a cloud DTO field.", true);
    if (Object.hasOwn(original, "cloudContext")) reportIssue(report, "$.cloudContext", "reserved-envelope", "Local cloud context is reserved for browser persistence.", true);
    if (document.LegacyExtensions !== undefined && !record(document.LegacyExtensions)) normalization(report, "$.LegacyExtensions");
    if (document.LayerPathTree !== undefined && !record(document.LayerPathTree)) normalization(report, "$.LayerPathTree");
    if (document.LayerPathTree?.ChildList === null) normalization(report, "$.LayerPathTree.ChildList");
    if (document.CurrentTimeMa < 0) normalization(report, "$.CurrentTimeMa");
    session.currentTimeMa = Math.max(0, document.CurrentTimeMa);
    session.layers.clear();
    const extensions =
      document.LegacyExtensions instanceof Map
        ? document.LegacyExtensions
        : new Map(
            Object.entries(
              (document.LegacyExtensions ?? {}) as unknown as Record<string, string>,
            ),
          );
    for (const [key, value] of extensions) {
      if (typeof value !== "string") throw new ProjectDataError("Cloud project extensions must contain strings.");
      if (key !== "camera" && !/^(?:groupCollapsed|sourceRef|pointStyle|lineStyle|polygonStyle|rasterId):[1-9]\d*$/.test(key)) reportIssue(report, `$.LegacyExtensions.${key}`, "preserved-field", "This extension is preserved without being executed.");
    }
    session.groups.clear();
    if (document.LayerPathTree) reportUnknownFields(report, document.LayerPathTree as unknown as Record<string, unknown>, ["LastID", "ChildList"], "$.LayerPathTree");
    const groupNodes = document.LayerPathTree?.ChildList ?? [];
    const pending = groupNodes.map(node => ({ node, parentId: undefined as number | undefined })).reverse();
    const seenNodes = new Set<LayerPathNode>();
    while (pending.length) {
      const { node, parentId } = pending.pop()!;
      if (!node || seenNodes.has(node) || !isProjectId(node.ID) || session.groups.has(node.ID) || typeof node.Name !== "string" ||
          !Number.isFinite(node.Value?.Alpha ?? 1) || typeof (node.Value?.Active ?? true) !== "boolean" ||
          (node.ChildList !== undefined && !Array.isArray(node.ChildList))) {
        throw new ProjectDataError("Cloud project contains an invalid or duplicate layer group.");
      }
      seenNodes.add(node);
      if (node.Value === undefined) legacyDefault(report, `$.LayerPathTree[${node.ID}].Value`);
      else if (!record(node.Value)) normalization(report, `$.LayerPathTree[${node.ID}].Value`);
      if (node.Value?.Active === null) normalization(report, `$.LayerPathTree[${node.ID}].Value.Active`);
      if (node.Value?.Alpha === null) normalization(report, `$.LayerPathTree[${node.ID}].Value.Alpha`);
      if (node.ChildList === undefined) legacyDefault(report, `$.LayerPathTree[${node.ID}].ChildList`);
      reportUnknownFields(report, node as unknown as Record<string, unknown>, ["ID", "Name", "Value", "ChildList"], `$.LayerPathTree[${node.ID}]`);
      if (node.Value) reportUnknownFields(report, node.Value as unknown as Record<string, unknown>, ["Active", "Alpha"], `$.LayerPathTree[${node.ID}].Value`);
      if ((node.Value?.Alpha ?? 1) < 0 || (node.Value?.Alpha ?? 1) > 1) normalization(report, `$.LayerPathTree[${node.ID}].Value.Alpha`);
      const collapsed = extensions.get(`groupCollapsed:${node.ID}`);
      if (collapsed !== undefined && collapsed !== "true" && collapsed !== "false") normalization(report, `$.LegacyExtensions.groupCollapsed:${node.ID}`);
      session.groups.set(node.ID, {
        active: node.Value?.Active ?? true,
        alpha: Math.min(1, Math.max(0, node.Value?.Alpha ?? 1)),
        collapsed: extensions.get(`groupCollapsed:${node.ID}`) === "true",
        id: node.ID, name: node.Name,
        ...(parentId !== undefined ? { parentId } : {}),
      });
      for (const child of [...(node.ChildList ?? [])].reverse()) pending.push({ node: child, parentId: node.ID });
    }
    // Legacy ungrouped layers need defaults; an explicitly empty project stays empty.
    if (session.groups.size === 0 && document.LayerList.length > 0) {
      legacyDefault(report, "$.LayerPathTree.ChildList");
      for (const group of DEFAULT_GROUPS) session.groups.set(group.id, cloneGroup(group));
    }
    for (const layer of document.LayerList) {
      if (!isProjectId(layer.ID) || session.layers.has(layer.ID) || typeof layer.Name !== "string" ||
          typeof layer.Active !== "boolean" || !Number.isFinite(layer.Alpha)) {
        throw new ProjectDataError("Cloud project contains an invalid or duplicate layer.");
      }
      const type =
        typeof layer.Type === "number"
          ? layer.Type
          : (layer.Type as unknown as { Value?: number } | null)?.Value;
      if (!Number.isInteger(type)) {
        reportIssue(report, `$.LayerList[${layer.ID}].Type`, "unsupported-layer", "The layer type is not a supported integer enum; no runtime layers are opened.", true);
        session.layers.clear(); session.groups.clear();
        return session;
      }
      if (!knownLayerType(type)) reportIssue(report, `$.LayerList[${layer.ID}].Type`, "unsupported-layer", "This layer type is preserved but cannot execute in the Web client.", true);
      if (layer.Alpha < 0 || layer.Alpha > 1) normalization(report, `$.LayerList[${layer.ID}].Alpha`);
      reportUnknownFields(report, layer as unknown as Record<string, unknown>, Object.keys(new ProjectLayerTO()), `$.LayerList[${layer.ID}]`);
      const preferredGroupId = defaultGroupId(type as ProjectLayerType);
      if (layer.PathTreeNodeID === undefined || layer.PathTreeNodeID === 0) legacyDefault(report, `$.LayerList[${layer.ID}].PathTreeNodeID`);
      const fallbackGroupId = session.groups.has(preferredGroupId)
        ? preferredGroupId
        : session.groups.keys().next().value;
      if (fallbackGroupId === undefined) {
        throw new ProjectDataError(
          "Cloud project must contain at least one layer group.",
        );
      }
      session.layers.set(layer.ID, {
        active: layer.Active,
        alpha: Math.min(1, Math.max(0, layer.Alpha)),
        groupId: layer.PathTreeNodeID === undefined || layer.PathTreeNodeID === 0
          ? fallbackGroupId : layer.PathTreeNodeID,
        id: layer.ID,
        name: layer.Name,
        lineStyle: type === ProjectLayerType.Line ? parseLineStyleExtension(extensions.get(`lineStyle:${layer.ID}`)) : undefined,
        polygonStyle: type === ProjectLayerType.Polygon ? parsePolygonStyleExtension(extensions.get(`polygonStyle:${layer.ID}`)) : undefined,
        rasterId: type === ProjectLayerType.Raster ? parseRasterIdExtension(extensions.get(`rasterId:${layer.ID}`)) : undefined,
        pointStyle:
          type === ProjectLayerType.Point
            ? parsePointStyleExtension(
                extensions.get(`pointStyle:${layer.ID}`),
                layer.ID,
              )
            : undefined,
        sourceRef:
          extensions.get(`sourceRef:${layer.ID}`) ??
          `cloud:layer:${layer.ID}`,
        type: type as ProjectLayerType,
      });
    }
    session.lastId = restoredLastId(document.LastID,
      restoredLastId(document.LayerPathTree?.LastID, validateTree(session.groupList, session.layerList)));
    const serializedCamera = extensions.get("camera");
    if (serializedCamera) {
      try {
        const camera = JSON.parse(serializedCamera) as CameraSnapshot;
        if (
          isFiniteTuple(camera.position) &&
          isFiniteTuple(camera.direction) &&
          isFiniteTuple(camera.up)
        ) {
          session.camera = {
            ...structuredClone(camera),
            direction: camera.direction,
            position: camera.position,
            up: camera.up,
          };
        } else normalization(report, "$.LegacyExtensions.camera");
      } catch {
        normalization(report, "$.LegacyExtensions.camera");
      }
    }
    for (const layer of session.layers.values()) {
      const stored = extensions.get(`pointStyle:${layer.id}`);
      if (stored !== undefined && layer.id === RUNTIME_LAYER_IDS.points && layer.type === ProjectLayerType.Point) {
        try { if (!equalValue(JSON.parse(stored), layer.pointStyle)) normalization(report, `$.LegacyExtensions.pointStyle:${layer.id}`); }
        catch { normalization(report, `$.LegacyExtensions.pointStyle:${layer.id}`); }
      }
    }
    session.documentReference = { layers: session.layerList, groups: session.groupList, camera: session.cameraSnapshot };
    return session;
  }

  static restore(storage: StorageAdapter): ProjectSession | undefined {
    const serialized = storage.getItem(LOCAL_PROJECT_DRAFT_KEY);
    if (!serialized) {
      return undefined;
    }
    return ProjectSession.fromLocalSerialized(serialized);
  }

  private static fromLocalSerialized(serialized: string): ProjectSession {
    const report = reportFor("local");
    const snapshot = parseSnapshot(serialized, report);
    const session = new ProjectSession(snapshot.name);
    session.originalSource = serialized;
    session.localBaseline = cloneJSON(JSON.parse(serialized));
    session.contextId = parseProjectCloudContext(session.localBaseline?.cloudContext)?.contextId;
    session.compatibility = report;
    session.saveState = { status: "saved", revision: 0, savedRevision: 0, savedAt: snapshot.savedAt };
    if (snapshot.cloudDocument !== undefined) {
      if (!record(snapshot.cloudDocument)) throw new ProjectDataError("The cloud compatibility envelope must be a document.");
      const imported = ProjectSession.fromDocument(snapshot.cloudDocument as unknown as ProjectDocumentV2TO);
      session.documentBaseline = imported.documentBaseline;
      session.documentReference = imported.documentReference;
      report.writable &&= imported.compatibility.writable;
      report.cloudWritable &&= imported.compatibility.cloudWritable;
      report.issues.push(...imported.compatibility.issues.map(issue => ({ ...issue, path: `$.cloudDocument${issue.path.slice(1)}` })));
    }
    session.currentTimeMa = snapshot.currentTimeMa;
    session.lastId = snapshot.lastId!;
    session.camera = snapshot.camera;
    session.groups.clear();
    for (const group of snapshot.groups) {
      session.groups.set(group.id, cloneGroup(group));
    }
    session.layers.clear();
    for (const layer of snapshot.layers) {
      session.layers.set(layer.id, cloneLayer(layer));
    }
    return session;
  }

  static restoreWithReport(storage: StorageAdapter): ProjectRestoreResult {
    let original: string | null;
    try { original = storage.getItem(LOCAL_PROJECT_DRAFT_KEY); }
    catch {
      const compatibility = reportFor("local", null);
      reportIssue(compatibility, "$", "storage-unavailable", "Local storage cannot be read; no draft was modified.", true);
      return { status: "unavailable", compatibility };
    }
    if (original === null) return { status: "empty", compatibility: reportFor("local") };
    try {
      const value = cloneJSON(JSON.parse(original));
      if (record(value) && typeof value.schemaVersion === "number" && value.schemaVersion > 2) {
        const session = ProjectSession.readonlyOriginal(original, value, "local");
        return { status: "readonly", session, compatibility: session.compatibilityReport, original };
      }
      const session = ProjectSession.fromLocalSerialized(original);
      return { status: session.isReadOnly ? "readonly" : "restored", session, compatibility: session.compatibilityReport, original };
    } catch (error) {
      const compatibility = reportFor("local", null);
      const syntax = error instanceof SyntaxError;
      const message = syntax ? "The draft does not contain valid JSON; original bytes were not modified."
        : error instanceof ProjectDataError ? error.message
        : "The draft cannot be interpreted safely; original bytes were not modified.";
      reportIssue(compatibility, "$", syntax ? "invalid-json" : "invalid-draft", message, true);
      return { status: "invalid", compatibility, original };
    }
  }

  private static readonlyOriginal(original: string, value: Record<string, unknown>, source: "local" | "cloud"): ProjectSession {
    const name = source === "local" ? value.name : value.Name;
    const session = new ProjectSession(typeof name === "string" ? name : "Unsupported project");
    session.layers.clear(); session.groups.clear();
    session.originalSource = original;
    session.compatibility = reportFor(source, source === "local" ? value.schemaVersion : value.SchemaVersion);
    reportIssue(session.compatibility, "$", "future-schema", "This project uses a newer schema; no runtime layers are opened.", true);
    return session;
  }

  get compatibilityReport(): ProjectCompatibilityReport { return structuredClone(this.compatibility); }
  get isReadOnly(): boolean { return !this.compatibility.writable; }
  get localSaveState(): ProjectLocalSaveState { return { ...this.saveState, ...(this.isReadOnly ? { status: "readonly" as const } : {}) }; }
  exportOriginal(): string | undefined { return this.originalSource; }

  private assertWritable(): void {
    if (this.isReadOnly) throw new Error("This project is read-only; export the original to preserve unsupported data.");
  }

  private changed(): void {
    this.saveState = { ...this.saveState, status: "dirty", revision: this.saveState.revision + 1, message: undefined };
  }

  private assign<T, K extends keyof T>(target: T, key: K, value: T[K]): void {
    this.assertWritable();
    if (!equalValue(target[key], value)) { target[key] = value; this.changed(); }
  }

  get timeMa(): number {
    return this.currentTimeMa;
  }

  get projectName(): string {
    return this.name;
  }

  get cameraSnapshot(): CameraSnapshot | undefined {
    return structuredClone(this.camera);
  }

  get layerList(): ProjectLayerSnapshot[] {
    return [...this.layers.values()].map(cloneLayer);
  }

  get groupList(): ProjectLayerGroupSnapshot[] {
    return [...this.groups.values()].map(cloneGroup);
  }

  getLayer(id: number): ProjectLayerSnapshot | undefined {
    const layer = this.layers.get(id);
    return layer ? cloneLayer(layer) : undefined;
  }

  getGroup(id: number): ProjectLayerGroupSnapshot | undefined {
    const group = this.groups.get(id);
    return group ? cloneGroup(group) : undefined;
  }

  addLayer(input: Omit<ProjectLayerSnapshot, "id">): number {
    this.assertWritable();
    if (!input || "id" in input || typeof input.name !== "string" || typeof input.sourceRef !== "string" ||
        typeof input.active !== "boolean" || !Number.isFinite(input.alpha) || input.alpha < 0 || input.alpha > 1 ||
        !Number.isInteger(input.type) || input.type < ProjectLayerType.Point || input.type > ProjectLayerType.PlateModel ||
        !this.groups.has(input.groupId)) throw new Error("Invalid layer or target group.");
    const layer = cloneLayer({ ...input, id: 0 });
    const id = this.allocateId();
    layer.id = id;
    this.layers.set(id, layer);
    this.changed();
    return id;
  }

  removeLayer(id: number): void {
    this.assertWritable();
    if (!this.layers.has(id)) throw new Error(`Unknown layer ${id}.`);
    this.layers.delete(id);
    this.changed();
  }

  addGroup(input: Omit<ProjectLayerGroupSnapshot, "id">): number {
    this.assertWritable();
    if (!input || "id" in input || typeof input.name !== "string" || typeof input.active !== "boolean" ||
        typeof input.collapsed !== "boolean" || !Number.isFinite(input.alpha) || input.alpha < 0 || input.alpha > 1 ||
        (input.parentId !== undefined && !this.groups.has(input.parentId))) throw new Error("Invalid layer group or parent.");
    const group = cloneGroup({ ...input, id: 0 });
    if (group.parentId === undefined) delete group.parentId;
    const id = this.allocateId();
    group.id = id;
    this.groups.set(id, group);
    this.changed();
    return id;
  }

  moveGroup(id: number, parentId?: number): void {
    this.assertWritable();
    const group = this.groups.get(id);
    if (!group) throw new Error(`Unknown layer group ${id}.`);
    if (parentId !== undefined && !this.groups.has(parentId)) throw new Error("Layer group parent must exist.");
    if (parentId !== undefined && this.groupAncestors(parentId).some(parent => parent.id === id)) {
      throw new Error("A layer group cannot move into itself or its descendants.");
    }
    if (group.parentId !== parentId) {
      if (parentId === undefined) delete group.parentId;
      else group.parentId = parentId;
      this.changed();
    }
  }

  removeGroup(id: number): void {
    this.assertWritable();
    if (!this.groups.has(id)) throw new Error(`Unknown layer group ${id}.`);
    if ([...this.layers.values()].some(layer => layer.groupId === id) ||
        [...this.groups.values()].some(group => group.parentId === id)) throw new Error("Cannot remove a nonempty layer group.");
    this.groups.delete(id);
    this.changed();
  }

  /** Direct and descendant members, in the project's layer order. */
  getGroupLayerIds(id: number): number[] {
    if (!this.groups.has(id)) throw new Error(`Unknown layer group ${id}.`);
    return [...this.layers.values()].filter(layer => this.groupAncestors(layer.groupId).some(group => group.id === id)).map(layer => layer.id);
  }

  getEffectiveLayerVisibility(id: number): boolean {
    const layer = this.layers.get(id);
    return Boolean(!this.isReadOnly && layer?.active && knownLayerType(layer.type) && this.groupAncestors(layer.groupId).every(group => group.active));
  }

  getEffectiveGroupVisibility(id: number): boolean {
    if (!this.groups.has(id)) throw new Error(`Unknown layer group ${id}.`);
    return this.groupAncestors(id).every(group => group.active);
  }

  getEffectiveGroupOpacity(id: number): number {
    if (!this.groups.has(id)) throw new Error(`Unknown layer group ${id}.`);
    return this.groupAncestors(id).reduce((alpha, group) => alpha * group.alpha, 1);
  }

  getEffectiveLayerOpacity(id: number): number {
    const layer = this.layers.get(id);
    return layer ? this.groupAncestors(layer.groupId).reduce((alpha, group) => alpha * group.alpha, layer.alpha) : 1;
  }

  private groupAncestors(id: number): ProjectLayerGroupSnapshot[] {
    const result: ProjectLayerGroupSnapshot[] = [];
    for (let group = this.groups.get(id); group; group = group.parentId === undefined ? undefined : this.groups.get(group.parentId)) result.push(group);
    return result;
  }

  private allocateId(): number {
    if (this.lastId >= Number.MAX_SAFE_INTEGER) throw new Error("Project ID space is exhausted.");
    return ++this.lastId;
  }

  setCamera(camera: CameraSnapshot): void {
    this.assertWritable();
    if (!isFiniteTuple(camera.position) || !isFiniteTuple(camera.direction) || !isFiniteTuple(camera.up)) throw new Error("Project camera must contain finite vectors.");
    const next: CameraSnapshot = {
      ...structuredClone(this.camera),
      ...structuredClone(camera),
      direction: [...camera.direction],
      position: [...camera.position],
      up: [...camera.up],
    };
    if (!equalValue(this.camera, next)) { this.camera = next; this.changed(); }
  }

  setLayerVisibility(id: number, active: boolean): void {
    this.assertWritable();
    const layer = this.layers.get(id);
    if (layer) {
      this.assign(layer, "active", active);
    }
  }

  setLayerSourceRef(id: number, sourceRef: string): void {
    this.assertWritable();
    const layer = this.layers.get(id);
    if (layer) {
      this.assign(layer, "sourceRef", sourceRef);
    }
  }

  setLayerOpacity(id: number, alpha: number): void {
    this.assertWritable();
    if (!Number.isFinite(alpha)) {
      throw new Error("Layer opacity must be a finite number.");
    }
    const layer = this.layers.get(id);
    if (layer) {
      this.assign(layer, "alpha", Math.min(1, Math.max(0, alpha)));
    }
  }

  setLayerGroup(id: number, groupId: number): void {
    this.assertWritable();
    const layer = this.layers.get(id);
    if (!layer || !this.groups.has(groupId)) {
      throw new Error("Layer and target group must exist.");
    }
    this.assign(layer, "groupId", groupId);
  }

  setGroupVisibility(id: number, active: boolean): void {
    this.assertWritable();
    const group = this.groups.get(id);
    if (group) {
      this.assign(group, "active", active);
    }
  }

  setGroupOpacity(id: number, alpha: number): void {
    this.assertWritable();
    if (!Number.isFinite(alpha)) {
      throw new Error("Layer group opacity must be a finite number.");
    }
    const group = this.groups.get(id);
    if (group) {
      this.assign(group, "alpha", Math.min(1, Math.max(0, alpha)));
    }
  }

  setGroupCollapsed(id: number, collapsed: boolean): void {
    this.assertWritable();
    const group = this.groups.get(id);
    if (group) {
      this.assign(group, "collapsed", collapsed);
    }
  }

  setPointStyle(id: number, style: unknown): void {
    this.assertWritable();
    const layer = this.layers.get(id);
    if (!layer || layer.type !== ProjectLayerType.Point) {
      throw new Error("Point style can only be assigned to a point layer.");
    }
    this.assign(layer, "pointStyle", id === RUNTIME_LAYER_IDS.points ? normalizePointStyleExpression(style) : cloneNativeStoredStyle(style));
  }

  setLineStyle(id: number, style: unknown): void {
    this.assertWritable();
    const layer = this.layers.get(id);
    if (!layer || layer.type !== ProjectLayerType.Line) throw new Error("Line style can only be assigned to a line layer.");
    this.assign(layer, "lineStyle", cloneNativeLineStoredStyle(style));
  }

  setPolygonStyle(id: number, style: unknown): void {
    this.assertWritable();
    const layer = this.layers.get(id);
    if (!layer || layer.type !== ProjectLayerType.Polygon) throw new Error("Polygon style can only be assigned to a polygon layer.");
    this.assign(layer, "polygonStyle", cloneNativePolygonStoredStyle(style));
  }

  getRasterId(id: number): string | undefined {
    const layer = this.layers.get(id);
    if (!layer || layer.type !== ProjectLayerType.Raster) throw new Error("Raster ID requires an existing raster layer.");
    return layer.rasterId === undefined ? undefined : checkedRasterId(layer.rasterId);
  }

  setRasterId(id: number, rasterId: string): void {
    this.assertWritable();
    const layer = this.layers.get(id);
    if (!layer || layer.type !== ProjectLayerType.Raster) throw new Error("Raster ID requires an existing raster layer.");
    this.assign(layer, "rasterId", checkedRasterId(rasterId));
  }

  reorderLayers(orderedIds: readonly number[]): void {
    this.assertWritable();
    if (
      orderedIds.length !== this.layers.size ||
      new Set(orderedIds).size !== this.layers.size ||
      orderedIds.some((id) => !this.layers.has(id))
    ) {
      throw new Error("Layer order must contain every layer exactly once.");
    }
    if (equalValue([...this.layers.keys()], orderedIds)) return;
    const reordered = orderedIds.map((id) => this.layers.get(id)!);
    this.layers.clear();
    for (const layer of reordered) {
      this.layers.set(layer.id, layer);
    }
    this.changed();
  }

  setName(name: string): void {
    this.assertWritable();
    const next = name.trim() || "Untitled";
    if (this.name !== next) { this.name = next; this.changed(); }
  }

  setTime(ageMa: number): void {
    this.assertWritable();
    if (!Number.isFinite(ageMa)) {
      throw new Error("Project time must be a finite number.");
    }
    const next = Math.max(0, ageMa);
    if (this.currentTimeMa !== next) { this.currentTimeMa = next; this.changed(); }
  }

  toDocument(): ProjectDocumentV2TO {
    this.assertWritable();
    if (!this.compatibility.cloudWritable) throw new Error("Cloud export requires a compatible mapping for the preserved local fields.");
    serializePersistentSnapshot(this.toSnapshot(new Date(0)));
    const document = this.documentBaseline
      ? cloneJSON(this.documentBaseline) as unknown as ProjectDocumentV2TO
      : new ProjectDocumentV2TO();
    document.Name = this.name;
    if (!this.documentBaseline) document.Version = "phase2";
    document.CurrentTimeMa = this.currentTimeMa;
    document.LastID = this.lastId;
    const oldTree = document.LayerPathTree;
    const originals = new Map<number, LayerPathNode>();
    const pending = [...(oldTree?.ChildList ?? [])];
    while (pending.length) {
      const node = pending.pop()!;
      originals.set(node.ID, node);
      pending.push(...(node.ChildList ?? []));
    }
    const tree = { ...oldTree, LastID: this.lastId, ChildList: [] as LayerPathNode[] };
    const extensions = new Map(Object.entries((document.LegacyExtensions ?? {}) as unknown as Record<string, string>));
    const referenceGroups = new Map(this.documentReference?.groups.map(group => [group.id, group]));
    const referenceLayers = new Map(this.documentReference?.layers.map(layer => [layer.id, layer]));
    const originalLayers = new Map(document.LayerList.map(layer => [layer.ID, layer]));
    const updateExtension = (key: string, value: unknown, previous: unknown, serialized: string): void => {
      if (!this.documentBaseline || !equalValue(value, previous)) extensions.set(key, serialized);
    };
    const nodes = new Map<number, LayerPathNode>();
    for (const group of this.groups.values()) {
      const original = originals.get(group.id);
      nodes.set(group.id, {
        ...original,
        ChildList: [], ID: group.id, Name: group.name,
        Value: { ...original?.Value, Active: group.active, Alpha: group.alpha },
      });
      updateExtension(`groupCollapsed:${group.id}`, group.collapsed, referenceGroups.get(group.id)?.collapsed, String(group.collapsed));
    }
    for (const group of this.groups.values()) {
      const children = group.parentId === undefined ? tree.ChildList : nodes.get(group.parentId)!.ChildList;
      children.push(nodes.get(group.id)!);
    }

    const layerList: ProjectLayerTO[] = [];
    for (const layerState of this.layers.values()) {
      const layer = originalLayers.get(layerState.id) ?? new ProjectLayerTO();
      layer.ID = layerState.id;
      layer.Name = layerState.name;
      layer.Active = layerState.active;
      layer.Alpha = layerState.alpha;
      layer.PathTreeNodeID = layerState.groupId;
      if (typeof layer.Type === "number") Object.assign(layer, { Type: layerState.type });
      else layer.Type.Value = layerState.type;
      layerList.push(layer);
      const reference = referenceLayers.get(layerState.id);
      updateExtension(
        `sourceRef:${layerState.id}`,
        layerState.sourceRef, reference?.sourceRef,
        layerState.sourceRef,
      );
      if (layerState.pointStyle !== undefined) {
        updateExtension(
          `pointStyle:${layerState.id}`,
          layerState.pointStyle, reference?.pointStyle,
          JSON.stringify(layerState.pointStyle),
        );
      }
      if (layerState.lineStyle !== undefined) {
        updateExtension(`lineStyle:${layerState.id}`, layerState.lineStyle, reference?.lineStyle, JSON.stringify(layerState.lineStyle));
      }
      if (layerState.polygonStyle !== undefined) {
        updateExtension(`polygonStyle:${layerState.id}`, layerState.polygonStyle, reference?.polygonStyle, JSON.stringify(layerState.polygonStyle));
      }
      if (layerState.rasterId !== undefined) {
        updateExtension(`rasterId:${layerState.id}`, layerState.rasterId, reference?.rasterId, JSON.stringify(layerState.rasterId));
      }
    }

    if (this.camera) {
      updateExtension(
        "camera",
        this.camera, this.documentReference?.camera,
        JSON.stringify(this.camera),
      );
    }
    Object.assign(document, { LayerList: layerList, LayerPathTree: tree, LegacyExtensions: extensions });
    return document;
  }

  toSnapshot(now = new Date()): ProjectSessionSnapshot {
    const { cloudDocument: _localEnvelope, cloudContext: _localContext, ...baseline } = structuredClone(this.localBaseline ?? {});
    return {
      ...baseline,
      camera: this.cameraSnapshot,
      currentTimeMa: this.currentTimeMa,
      groups: [...this.groups.values()].map(cloneGroup),
      layers: [...this.layers.values()].map(cloneLayer),
      name: this.name,
      savedAt: now.toISOString(),
      schemaVersion: 2,
      lastId: this.lastId,
    };
  }

  serializeLocalDraft(now = new Date()): string {
    this.assertWritable();
    return serializePersistentSnapshot({ ...this.toSnapshot(now),
      ...(this.documentBaseline ? { cloudDocument: cloneJSON(this.documentBaseline) } : {}) });
  }

  save(storage: StorageAdapter, now = new Date()): ProjectSessionSnapshot {
    this.assertWritable();
    const revision = this.saveState.revision;
    this.saveState = { ...this.saveState, status: "saving", message: undefined };
    try {
      const serialized = this.serializeLocalDraft(now);
      const snapshot = JSON.parse(serialized) as ProjectSessionSnapshot;
      writeProjectDraft(storage, serialized, this.contextId);
      this.saveState = { status: this.saveState.revision === revision ? "saved" : "dirty", revision: this.saveState.revision, savedRevision: revision, savedAt: snapshot.savedAt };
      return snapshot;
    } catch (error) {
      this.saveState = { ...this.saveState, status: "error", message: "The local draft was not saved. Current edits remain in memory." };
      throw error;
    }
  }
}
