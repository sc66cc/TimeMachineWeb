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

export const LOCAL_PROJECT_DRAFT_KEY = "timemachine:web:phase1a-project";

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
  sourceRef: string;
  type: ProjectLayerType;
}

export interface ProjectLayerGroupSnapshot {
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
}

interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
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
  return { ...group };
}

function defaultGroupId(type: ProjectLayerType): number {
  return type === ProjectLayerType.PlateModel
    ? RUNTIME_LAYER_GROUP_IDS.reconstruction
    : RUNTIME_LAYER_GROUP_IDS.data;
}

function cloneLayer(layer: ProjectLayerSnapshot): ProjectLayerSnapshot {
  return {
    ...layer,
    pointStyle: layer.pointStyle
      ? normalizePointStyleExpression(layer.pointStyle)
      : undefined,
  };
}

function isFiniteTuple(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((component) => Number.isFinite(component))
  );
}

function parseSnapshot(serialized: string): ProjectSessionSnapshot {
  const value = JSON.parse(serialized) as Partial<ProjectSessionSnapshot>;
  if (
    value.schemaVersion !== 2 ||
    typeof value.name !== "string" ||
    !Number.isFinite(value.currentTimeMa) ||
    !Array.isArray(value.layers)
  ) {
    throw new Error("Stored project draft does not match schema version 2.");
  }

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
            throw new Error(
              "Stored project draft contains an invalid layer group.",
            );
          }
          return {
            active: group.active,
            alpha: Math.min(1, Math.max(0, group.alpha)),
            collapsed: group.collapsed,
            id: group.id,
            name: group.name,
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
      throw new Error("Stored project draft contains an invalid layer.");
    }
    const type = layer.type as ProjectLayerType;
    const preferredGroupId = defaultGroupId(type);
    const fallbackGroupId = groupIds.has(preferredGroupId)
      ? preferredGroupId
      : groups[0]?.id;
    if (fallbackGroupId === undefined) {
      throw new Error(
        "Stored project draft must contain at least one layer group.",
      );
    }
    return {
      active: layer.active,
      alpha: Math.min(1, Math.max(0, layer.alpha)),
      groupId:
        Number.isInteger(layer.groupId) && groupIds.has(layer.groupId)
          ? layer.groupId
          : fallbackGroupId,
      id: layer.id,
      name: layer.name,
      pointStyle:
        type === ProjectLayerType.Point
          ? normalizePointStyleExpression(layer.pointStyle)
          : undefined,
      sourceRef: layer.sourceRef,
      type,
    };
  });

  const camera = value.camera;
  const parsedCamera =
    camera &&
    isFiniteTuple(camera.position) &&
    isFiniteTuple(camera.direction) &&
    isFiniteTuple(camera.up)
      ? {
          position: camera.position,
          direction: camera.direction,
          up: camera.up,
        }
      : undefined;

  return {
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
  };
}

function parsePointStyleExtension(
  serialized: string | undefined,
): PointStyleExpression {
  if (!serialized) {
    return normalizePointStyleExpression(DEFAULT_POINT_STYLE);
  }
  try {
    return normalizePointStyleExpression(JSON.parse(serialized));
  } catch {
    return normalizePointStyleExpression(DEFAULT_POINT_STYLE);
  }
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
    if (
      document.SchemaVersion !== 2 ||
      typeof document.Name !== "string" ||
      !Number.isFinite(document.CurrentTimeMa) ||
      !Array.isArray(document.LayerList)
    ) {
      throw new Error("Cloud project does not match schema version 2.");
    }
    const session = new ProjectSession(document.Name);
    session.currentTimeMa = Math.max(0, document.CurrentTimeMa);
    session.layers.clear();
    const extensions =
      document.LegacyExtensions instanceof Map
        ? document.LegacyExtensions
        : new Map(
            Object.entries(
              document.LegacyExtensions as unknown as Record<string, string>,
            ),
          );
    session.groups.clear();
    const groupNodes = document.LayerPathTree?.ChildList ?? [];
    for (const node of groupNodes) {
      if (!Number.isInteger(node.ID) || typeof node.Name !== "string") {
        continue;
      }
      session.groups.set(node.ID, {
        active: node.Value?.Active ?? true,
        alpha: Math.min(1, Math.max(0, node.Value?.Alpha ?? 1)),
        collapsed:
          extensions.get(`groupCollapsed:${node.ID}`) === "true",
        id: node.ID,
        name: node.Name,
      });
    }
    if (session.groups.size === 0) {
      for (const group of DEFAULT_GROUPS) {
        session.groups.set(group.id, cloneGroup(group));
      }
    }
    for (const layer of document.LayerList) {
      const type =
        typeof layer.Type === "number"
          ? layer.Type
          : (layer.Type as unknown as { Value?: number }).Value ?? 0;
      const preferredGroupId = defaultGroupId(type as ProjectLayerType);
      const fallbackGroupId = session.groups.has(preferredGroupId)
        ? preferredGroupId
        : session.groups.keys().next().value;
      if (fallbackGroupId === undefined) {
        throw new Error(
          "Cloud project must contain at least one layer group.",
        );
      }
      session.layers.set(layer.ID, {
        active: layer.Active,
        alpha: Math.min(1, Math.max(0, layer.Alpha)),
        groupId: session.groups.has(layer.PathTreeNodeID)
          ? layer.PathTreeNodeID
          : fallbackGroupId,
        id: layer.ID,
        name: layer.Name,
        pointStyle:
          type === ProjectLayerType.Point
            ? parsePointStyleExtension(
                extensions.get(`pointStyle:${layer.ID}`),
              )
            : undefined,
        sourceRef:
          extensions.get(`sourceRef:${layer.ID}`) ??
          `cloud:layer:${layer.ID}`,
        type: type as ProjectLayerType,
      });
    }
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
            direction: camera.direction,
            position: camera.position,
            up: camera.up,
          };
        }
      } catch {
        // A project with an invalid optional camera still opens at the home view.
      }
    }
    return session;
  }

  static restore(storage: StorageAdapter): ProjectSession | undefined {
    const serialized = storage.getItem(LOCAL_PROJECT_DRAFT_KEY);
    if (!serialized) {
      return undefined;
    }
    const snapshot = parseSnapshot(serialized);
    const session = new ProjectSession(snapshot.name);
    session.currentTimeMa = snapshot.currentTimeMa;
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

  get timeMa(): number {
    return this.currentTimeMa;
  }

  get projectName(): string {
    return this.name;
  }

  get cameraSnapshot(): CameraSnapshot | undefined {
    return this.camera;
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

  getEffectiveLayerVisibility(id: number): boolean {
    const layer = this.layers.get(id);
    const group = layer ? this.groups.get(layer.groupId) : undefined;
    return Boolean(layer?.active && (group?.active ?? true));
  }

  getEffectiveLayerOpacity(id: number): number {
    const layer = this.layers.get(id);
    if (!layer) {
      return 1;
    }
    const group = this.groups.get(layer.groupId);
    return layer.alpha * (group?.alpha ?? 1);
  }

  setCamera(camera: CameraSnapshot): void {
    this.camera = {
      direction: [...camera.direction],
      position: [...camera.position],
      up: [...camera.up],
    };
  }

  setLayerVisibility(id: number, active: boolean): void {
    const layer = this.layers.get(id);
    if (layer) {
      layer.active = active;
    }
  }

  setLayerSourceRef(id: number, sourceRef: string): void {
    const layer = this.layers.get(id);
    if (layer) {
      layer.sourceRef = sourceRef;
    }
  }

  setLayerOpacity(id: number, alpha: number): void {
    if (!Number.isFinite(alpha)) {
      throw new Error("Layer opacity must be a finite number.");
    }
    const layer = this.layers.get(id);
    if (layer) {
      layer.alpha = Math.min(1, Math.max(0, alpha));
    }
  }

  setLayerGroup(id: number, groupId: number): void {
    const layer = this.layers.get(id);
    if (!layer || !this.groups.has(groupId)) {
      throw new Error("Layer and target group must exist.");
    }
    layer.groupId = groupId;
  }

  setGroupVisibility(id: number, active: boolean): void {
    const group = this.groups.get(id);
    if (group) {
      group.active = active;
    }
  }

  setGroupOpacity(id: number, alpha: number): void {
    if (!Number.isFinite(alpha)) {
      throw new Error("Layer group opacity must be a finite number.");
    }
    const group = this.groups.get(id);
    if (group) {
      group.alpha = Math.min(1, Math.max(0, alpha));
    }
  }

  setGroupCollapsed(id: number, collapsed: boolean): void {
    const group = this.groups.get(id);
    if (group) {
      group.collapsed = collapsed;
    }
  }

  setPointStyle(id: number, style: unknown): void {
    const layer = this.layers.get(id);
    if (!layer || layer.type !== ProjectLayerType.Point) {
      throw new Error("Point style can only be assigned to a point layer.");
    }
    layer.pointStyle = normalizePointStyleExpression(style);
  }

  reorderLayers(orderedIds: readonly number[]): void {
    if (
      orderedIds.length !== this.layers.size ||
      new Set(orderedIds).size !== this.layers.size ||
      orderedIds.some((id) => !this.layers.has(id))
    ) {
      throw new Error("Layer order must contain every layer exactly once.");
    }
    const reordered = orderedIds.map((id) => this.layers.get(id)!);
    this.layers.clear();
    for (const layer of reordered) {
      this.layers.set(layer.id, layer);
    }
  }

  setName(name: string): void {
    this.name = name.trim() || "Untitled";
  }

  setTime(ageMa: number): void {
    if (!Number.isFinite(ageMa)) {
      throw new Error("Project time must be a finite number.");
    }
    this.currentTimeMa = Math.max(0, ageMa);
  }

  toDocument(): ProjectDocumentV2TO {
    const document = new ProjectDocumentV2TO();
    document.Name = this.name;
    document.Version = "phase2";
    document.CurrentTimeMa = this.currentTimeMa;
    document.LastID = Math.max(
      0,
      ...this.layers.keys(),
      ...this.groups.keys(),
    );
    document.LayerPathTree.LastID = Math.max(0, ...this.groups.keys());
    for (const group of this.groups.values()) {
      document.LayerPathTree.ChildList.push({
        ChildList: [],
        ID: group.id,
        Name: group.name,
        Value: {
          Active: group.active,
          Alpha: group.alpha,
        },
      });
      document.LegacyExtensions.set(
        `groupCollapsed:${group.id}`,
        String(group.collapsed),
      );
    }

    for (const layerState of this.layers.values()) {
      const layer = new ProjectLayerTO();
      layer.ID = layerState.id;
      layer.Name = layerState.name;
      layer.Active = layerState.active;
      layer.Alpha = layerState.alpha;
      layer.PathTreeNodeID = layerState.groupId;
      layer.Type.Value = layerState.type;
      document.LayerList.push(layer);
      document.LegacyExtensions.set(
        `sourceRef:${layerState.id}`,
        layerState.sourceRef,
      );
      if (layerState.pointStyle) {
        document.LegacyExtensions.set(
          `pointStyle:${layerState.id}`,
          JSON.stringify(layerState.pointStyle),
        );
      }
    }

    if (this.camera) {
      document.LegacyExtensions.set(
        "camera",
        JSON.stringify(this.camera),
      );
    }
    return document;
  }

  toSnapshot(now = new Date()): ProjectSessionSnapshot {
    return {
      camera: this.camera,
      currentTimeMa: this.currentTimeMa,
      groups: [...this.groups.values()].map(cloneGroup),
      layers: [...this.layers.values()].map(cloneLayer),
      name: this.name,
      savedAt: now.toISOString(),
      schemaVersion: 2,
    };
  }

  save(storage: StorageAdapter, now = new Date()): ProjectSessionSnapshot {
    const snapshot = this.toSnapshot(now);
    storage.setItem(LOCAL_PROJECT_DRAFT_KEY, JSON.stringify(snapshot));
    return snapshot;
  }
}
