<script setup lang="ts">
import DevelopmentConsole from "./components/DevelopmentConsole.vue";
import AddLayerPanel, { type AddLayerKind } from "./components/vueui/shell/AddLayerPanel.vue";
import WelcomePanel from "./components/vueui/shell/WelcomePanel.vue";
import { Badge } from "@/components/vueui/badge";
import { Button } from "@/components/vueui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/vueui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/vueui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/vueui/dropdown-menu";
import { Input } from "@/components/vueui/input";
import { labelTextShadow, readableLabelColor } from "./ui/timeline-label-contrast";
import { Label } from "@/components/vueui/label";
import { NativeSelect, NativeSelectOption } from "@/components/vueui/native-select";
import { ScrollArea } from "@/components/vueui/scroll-area";
import { Separator } from "@/components/vueui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/vueui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/vueui/tooltip";
import {
  Bell,
  BoxSelect,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  CloudUpload,
  Database,
  Download,
  Globe,
  Globe2,
  House,
  Info,
  Layers,
  MoreHorizontal,
  PanelLeft,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  SlidersHorizontal,
  Store,
  Trash2,
  Upload,
  X,
} from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type WatchStopHandle } from "vue";
import {
  ProjectLayerType,
  type ProjectRevisionSummaryRO,
} from "@timemachine/generated-api";
import {
  normalizePointStyleExpression,
  POINT_SIZE_MIN_PIXELS,
  POINT_SIZE_MAX_PIXELS,
  type PointStyleExpression,
} from "@timemachine/point-runtime";
import {
  foreignKeyValue,
  phase1BCloudClient,
  type Phase1BState,
} from "./phase1b/cloud-client";
import {
  guessColumnMapping,
  readCsvPreview,
  type CsvPreview,
} from "./phase3/csv-preview";
import {
  cancelJob,
  ingestPointCsv,
  validateMapping,
  validateSourceFile,
  type ColumnMapping,
} from "./phase3/ingest-client";
import {
  ProjectSession,
  RUNTIME_LAYER_IDS,
  type ProjectLayerGroupSnapshot,
  type ProjectLayerSnapshot,
} from "./project/project-session";
import { PROJECT_STATE_EVENT, type ProjectStateDetail } from "./project/project-events";
import {
  LAYER_GROUP_COLLAPSE_CHANGE_EVENT,
  LAYER_GROUP_OPACITY_CHANGE_EVENT,
  LAYER_GROUP_VISIBILITY_CHANGE_EVENT,
  LAYER_OPACITY_CHANGE_EVENT,
  LAYER_ORDER_CHANGE_EVENT,
  LAYER_STATE_EVENT,
  LAYER_VISIBILITY_CHANGE_EVENT,
  POINT_STYLE_CHANGE_EVENT,
  type LayerStateDetail,
} from "./layers/layer-events";
import {
  AGENT_ACTIONS,
  AGENT_DECLARATIONS,
  agentActions,
  type AgentActionId,
} from "./agent-actions";
import {
  AgentActionAuthError,
  AgentActionBusyError,
  AgentActionFailureError,
  AgentActionValidationError,
  AgentActionUnsupportedError,
} from "./agent-actions/registry";
import { redactErrorMessage } from "./agent-actions/types";
import type { OperationContext } from "./agent-actions/operation";
import { readNativePointStyle, type NativePointStyle } from "./layers/native-point-style";
import { readNativeLineStyle, NATIVE_LINE_WIDTH_MIN, NATIVE_LINE_WIDTH_MAX, type NativeLineStyle } from "./layers/native-line-style";
import { readNativePolygonStyle, NATIVE_POLYGON_OUTLINE_WIDTH_MIN, NATIVE_POLYGON_OUTLINE_WIDTH_MAX, type NativePolygonStyle } from "./layers/native-polygon-style";
import {
  requireV2Workspace,
  v2WorkspaceUnavailableReason,
} from "./phase1b/v2-availability";

type SidebarTab = "layers" | "plate-models";

interface TimelineSegment {
  color: string;
  label: string;
  weight: number;
}

const activeSidebarTab = ref<SidebarTab>("layers");
const activeModule = ref("Layer");
const toolbarCollapsed = ref(false);
const toastMessage = ref("");
const toastVisible = ref(false);
const authDialogVisible = ref(false);
const accountMenuVisible = ref(false);
const authEmail = ref("");
const authCode = ref("");
const authBusy = ref(false);
const authAccount = ref("");
const authPassword = ref("");
/** Unity account/password is the default mode on the shared Server. */
const authMode = ref<"account" | "email-code">("account");
const phase1B = ref<Phase1BState>(phase1BCloudClient.snapshot);
const projectState = ref<ProjectStateDetail>();
const timelineMaximum = computed(() => projectState.value?.timeRange?.maxAgeMa ?? 538.8);
const projectActionBusy = ref(false);
const projectActionError = ref("");
const projectReadOnly = computed(() => !projectState.value?.compatibility.writable);
const projectReadOnlyReason = computed(() => projectState.value
  ? "This project is read-only. Review the compatibility report and download its original input."
  : "Project compatibility is being checked. Wait before editing the project.");
const localSaveLabel = computed(() => projectState.value ? ({
  dirty: "Unsaved local changes", saving: "Saving locally…", saved: "Saved locally", error: "Local save failed", readonly: "Read-only local project",
})[projectState.value.localSave.status] : "Checking project compatibility…");
const cloudSaveLabel = computed(() => projectState.value ? ({
  idle: "Not saved to cloud", dirty: "Unsaved cloud changes", saving: "Saving to cloud…", saved: "Saved to cloud", error: "Cloud save failed", readonly: "Cloud save unavailable (read-only)",
})[projectState.value.cloudSave.status] : "Waiting for project state");
const projectReportOpen = computed(() => projectReadOnly.value || Boolean(projectActionError.value) ||
  Boolean(phase1B.value.projectContextError) || Boolean(projectState.value?.compatibility.issues.length) ||
  Boolean(projectState.value?.review) || projectState.value?.localSave.status === "error" || projectState.value?.cloudSave.status === "error");

/*
 * Workbench panel state. Each value below has exactly one writer: the setter
 * used by the button, the keyboard path and the registered action handler, so
 * the UI never both mutates a ref and dispatches the same action.
 */
interface ConsoleHandle {
  clear(): void;
  selectOutput(): boolean;
  snapshot(): { entries: number; pending: number };
}

const ADD_PANEL_KINDS: readonly AddLayerKind[] = ["group", "point", "line", "polygon", "raster", "atlas"];
const addPanelOpen = ref(false);
const addPanelKind = ref<AddLayerKind>("group");
const welcomeOpen = ref(false);
const consoleOpen = ref(false);
const sidebarVisible = ref(true);
const consoleRef = ref<ConsoleHandle>();
const projectDetailsOpen = ref(false);
const consoleSummary = computed(() => consoleRef.value?.snapshot() ?? { entries: 0, pending: 0 });
const addPanelGroups = computed(() => orderedLayerGroups.value.map((group) => ({
  id: group.id,
  name: group.name,
  depth: groupDepth(group.id),
})));

function setAddPanelVisible(visible: boolean, kind?: AddLayerKind): void {
  addPanelOpen.value = visible;
  if (kind) addPanelKind.value = kind;
}

function setAddPanelKind(kind: AddLayerKind): void {
  addPanelKind.value = kind;
}

/** Focus goes back to the trigger only when the panel closes from the panel. */
function focusAddPanelTrigger(): void {
  void nextTick(() => {
    document.querySelector<HTMLElement>('[data-action="ui.addPanel.setVisible"]')?.focus();
  });
}

function closeAddPanel(): void {
  setAddPanelVisible(false);
  focusAddPanelTrigger();
}

function toggleAddPanel(): void {
  setAddPanelVisible(!addPanelOpen.value);
}

function setWelcomeVisible(visible: boolean): void {
  welcomeOpen.value = visible;
}

function setConsoleVisible(visible: boolean): void {
  consoleOpen.value = visible;
}

/**
 * One writer for the drawer: the top bar toggle and the action both land here.
 * Closing while focus sits inside the drawer hands focus back to the toggle, so
 * the keyboard path never ends on the now-inert panel or on `<body>`.
 */
function setSidebarVisible(visible: boolean): void {
  const focusWasInSidebar = Boolean(document.activeElement?.closest("#tm-sidebar"));
  const wasVisible = sidebarVisible.value;
  sidebarVisible.value = visible;
  if (wasVisible && !visible && focusWasInSidebar) {
    void nextTick(() => {
      document.querySelector<HTMLElement>('[data-action="ui.sidebar.setVisible"]')?.focus();
    });
  }
}

/** The one writer for the sign-in dialog: button, Dialog and action all call it. */
function setAuthDialogOpen(open: boolean): void {
  authDialogVisible.value = open;
  if (!open) {
    // The dialog has no DialogTrigger of its own, so focus goes back to the
    // account button that opens it.
    void nextTick(() => {
      document.querySelector<HTMLElement>('[data-action="ui.accountMenu.toggle"]')?.focus();
    });
  }
}

function setAuthMode(mode: unknown): void {
  if (mode === "account" || mode === "email-code") authMode.value = mode;
}

function selectSidebarTab(tab: unknown): void {
  if (tab === "layers" || tab === "plate-models") activeSidebarTab.value = tab;
}

/**
 * The account menu is a controlled DropdownMenu. A signed-out trigger opens the
 * sign-in dialog instead of an empty menu, which is the old behaviour.
 */
function setAccountMenuOpen(open: boolean): void {
  if (!phase1B.value.account) {
    if (open) setAuthDialogOpen(true);
    accountMenuVisible.value = false;
    return;
  }
  accountMenuVisible.value = open;
}

function handleProjectStatusToggle(event: Event): void {
  projectDetailsOpen.value = (event.currentTarget as HTMLDetailsElement).open;
}

/** Escape closes the expanded status card and returns focus to its summary. */
function closeProjectStatus(event: KeyboardEvent): void {
  const details = event.currentTarget as HTMLDetailsElement;
  if (!details.open) return;
  details.open = false;
  projectDetailsOpen.value = false;
  details.querySelector<HTMLElement>("summary")?.focus();
}

function requireProjectEditable(): void {
  if (projectReadOnly.value) throw new AgentActionUnsupportedError(projectReadOnlyReason.value);
}

function handleProjectState(event: Event): void {
  projectState.value = (event as CustomEvent<ProjectStateDetail>).detail;
}

type UploadStep = "select" | "map" | "run";

const uploadDialogVisible = ref(false);
const uploadStep = ref<UploadStep>("select");
const uploadError = ref("");
const uploadBusy = ref(false);
const uploadName = ref("");
const uploadDescription = ref("");
const uploadPreview = ref<CsvPreview | undefined>(undefined);
const uploadFileName = ref("");
const uploadFileSize = ref(0);
const uploadPlateModelId = ref(0);
const uploadProgress = ref(0);
const uploadStage = ref("");
const uploadMessage = ref("");
const uploadJobId = ref(0);
const uploadMapping = ref<ColumnMapping>({
  ageEndColumn: "",
  ageStartColumn: "",
  latitudeColumn: "",
  longitudeColumn: "",
  occurrenceColumn: "",
  plateIdColumn: "",
});
// The File object stays outside reactive state so Vue never walks a 256 MB payload.
let uploadFile: File | undefined;
let uploadAbort: AbortController | undefined;
const defaultProjectSession = new ProjectSession();
const layerRows = ref<LayerStateDetail["layers"]>(
  defaultProjectSession.layerList,
);
const layerGroups = ref<ProjectLayerGroupSnapshot[]>(
  defaultProjectSession.groupList,
);
const layerSearch = ref("");
const newGroupName = ref("");
const newGroupParent = ref("");
const groupActionBusy = ref(false);
const groupActionError = ref("");
const pointLayerActionBusy = ref(false);
const pointLayerActionMessage = ref("");
const pointLayerActionError = ref("");
const newPointLayerName = ref("");
const newPointLayerGroup = ref(String(defaultProjectSession.groupList[0]?.id ?? ""));
const pointFixtureSourceRef = "fixture:goal-points-v1";
const newLineLayerName = ref("");
const newLineLayerGroup = ref(String(defaultProjectSession.groupList[0]?.id ?? ""));
const lineFixtureSourceRef = "fixture:goal-lines-v1";
const newPolygonLayerName = ref("");
const newPolygonLayerGroup = ref(String(defaultProjectSession.groupList[0]?.id ?? ""));
const polygonFixtureSourceRef = "fixture:goal-polygons-v1";
const newRasterLayerName = ref("");
const newRasterLayerGroup = ref(String(defaultProjectSession.groupList[0]?.id ?? ""));
const newRasterLayerSelection = ref("");
const rasterManifestSourceRef = "local:single-raster-manifest";
const rasterOptions = ref<NonNullable<LayerStateDetail["rasterOptions"]>>([]);
const defaultRasterId = ref<string | undefined>();
const availableRasterIds = computed(() => new Set(rasterOptions.value.map(option => option.id)));
const newAtlasLayerName = ref("");
const newAtlasLayerGroup = ref(String(defaultProjectSession.groupList[0]?.id ?? ""));
const atlasManifestSourceRef = "local:paleoatlas-manifest";
const atlasSource = ref<LayerStateDetail["atlasSource"]>();
const atlasSourceAvailable = computed(() => atlasSource.value?.sourceRef === atlasManifestSourceRef);
const defaultLayerIds = new Set<number>(Object.values(RUNTIME_LAYER_IDS));
const selectedLayerId = ref<number | undefined>();
const draggedLayerId = ref<number | undefined>();
const dropTargetLayerId = ref<number | undefined>();
let toastTimer: number | undefined;
let unsubscribePhase1B: (() => void) | undefined;
const unsubscribeStateSections: (() => void)[] = [];
let stopUiStateWatch: WatchStopHandle | undefined;

const moduleItems = [
  { icon: Layers, label: "Layer" },
  { icon: Globe, label: "Atlas" },
  { icon: Database, label: "Database" },
  { icon: Globe2, label: "Multi Globe" },
  { icon: Store, label: "Project Market" },
  { icon: BoxSelect, label: "Area Tool" },
] as const;

const stageSegments: TimelineSegment[] = [
  ["Fo…", 7, "#9acbb1"], ["C…", 6, "#8fc9ad"], ["…", 4, "#a4d4b9"],
  ["Tr…", 7, "#4fae9e"], ["Dar…", 8, "#5ab2a5"], ["K…", 7, "#6ab9ad"],
  ["Lla…", 8, "#9ccbc6"], ["Emsian", 10, "#d8bc77"], ["F…", 8, "#cabf8f"],
  ["Tour…", 9, "#8db6ad"], ["Visean", 10, "#92b9ae"], ["B…", 7, "#8baaa7"],
  ["Cis…", 8, "#df868b"], ["Guad…", 8, "#d67980"], ["L…", 6, "#cc7380"],
  ["Mi…", 7, "#9666bb"], ["Norian", 12, "#9f89c6"], ["Pl…", 7, "#58b3d3"],
  ["To…", 7, "#69b9d6"], ["…", 7, "#77bfd8"], ["Albian", 10, "#8dca79"],
  ["Ca…", 8, "#a4d66f"], ["Y…", 6, "#dda36d"], ["Eocene", 10, "#daa56d"],
  ["Oli…", 7, "#dfb57b"], ["Miocene", 10, "#e5ee4a"], ["Neogene", 9, "#e2ed38"],
].map(([label, weight, color]) => ({
  label: String(label),
  weight: Number(weight),
  color: String(color),
}));

const seriesSegments: TimelineSegment[] = [
  ["Terrene…", 13, "#9acbb1"], ["Cambrian", 18, "#8fc9ad"],
  ["Early O…", 13, "#4fae9e"], ["Middle O…", 12, "#51ae9f"],
  ["Silurian", 12, "#9ccbc6"], ["Early Devonian", 17, "#d8bc77"],
  ["Late Devonian", 14, "#d6c68e"], ["Mississippian", 19, "#8db6ad"],
  ["Pennsylvanian", 18, "#85aaa5"], ["Cisuralian", 14, "#dd8084"],
  ["Guadalupian", 12, "#d67980"], ["Middle Triassic", 13, "#9666bb"],
  ["Late Triassic", 20, "#9c79bd"], ["Early Jurassic", 18, "#58afd0"],
  ["Late Jurassic", 17, "#72bed7"], ["Early Cretaceous", 25, "#77bf73"],
  ["Late Cretaceous", 25, "#91cd6e"], ["Paleocene", 10, "#dfa764"],
  ["Eocene", 15, "#daa56d"], ["Oligocene", 10, "#dab37b"],
  ["Miocene", 15, "#dcec42"], ["Neogene", 10, "#e4ed43"],
].map(([label, weight, color]) => ({
  label: String(label),
  weight: Number(weight),
  color: String(color),
}));

const periodSegments: TimelineSegment[] = [
  { label: "Cambrian", weight: 53.4, color: "#8fc9ad" },
  { label: "Ordovician", weight: 41.6, color: "#4fae9e" },
  { label: "Silurian", weight: 24.6, color: "#9ccbc6" },
  { label: "Devonian", weight: 60.3, color: "#d8bc77" },
  { label: "Carboniferous", weight: 60, color: "#8db6ad" },
  { label: "Permian", weight: 47, color: "#dd8084" },
  { label: "Triassic", weight: 50.6, color: "#9666bb" },
  { label: "Jurassic", weight: 56.3, color: "#58afd0" },
  { label: "Cretaceous", weight: 79, color: "#77bf73" },
  { label: "Paleogene", weight: 43, color: "#dfa764" },
  { label: "Neogene", weight: 23, color: "#dcec42" },
];

const eraSegments: TimelineSegment[] = [
  { label: "Paleozoic", weight: 287, color: "#80bcb1" },
  { label: "Mesozoic", weight: 186, color: "#68b9cf" },
  { label: "Cenozoic", weight: 65.8, color: "#bbd742" },
];

const timelineRows = computed(() => [
  { className: "stages", segments: stageSegments },
  { className: "series", segments: seriesSegments },
  { className: "periods", segments: periodSegments },
  { className: "eras", segments: eraSegments },
  {
    className: "eon",
    segments: [{ label: "Phanerozoic", weight: 538.8, color: "#75bed4" }],
  },
]);

/** Access-range label for a shared (V1) plate model. */
function accessRangeLabel(accessRange: number): string {
  if (accessRange === 1) {
    return "Public";
  }
  if (accessRange === 2) {
    return "Publish";
  }
  return "Private";
}

/** True when the shared model came from `DisplayMine`, i.e. belongs to the user. */
function isMineSharedPlateModel(plateModelId: number): boolean {
  return phase1B.value.sharedPlateModelsMineIds.includes(plateModelId);
}

const publicPlateModels = computed(() =>
  phase1B.value.plateModels.filter(
    (item) => foreignKeyValue(item.Version.AccessRange) !== 0,
  ),
);
const privatePlateModels = computed(() =>
  phase1B.value.plateModels.filter(
    (item) => foreignKeyValue(item.Version.AccessRange) === 0,
  ),
);
const publicDatasets = computed(() =>
  phase1B.value.datasets.filter(
    (item) => foreignKeyValue(item.Version.AccessRange) !== 0,
  ),
);
const privateDatasets = computed(() =>
  phase1B.value.datasets.filter(
    (item) => foreignKeyValue(item.Version.AccessRange) === 0,
  ),
);
// Ingest reads plate polygons from the PlateModel catalog entry, so the wizard offers the
// catalog itself rather than a derived version row. A model with no polygons would fail the
// job server-side, so it is not offered at all.
const ingestPlateModels = computed(() =>
  phase1B.value.plateModelCatalog.filter(
    (model) => model.PlatePolygonCount > 0,
  ),
);
const layerQuery = computed(() => layerSearch.value.trim().toLocaleLowerCase());
const groupsById = computed(() => new Map(layerGroups.value.map(group => [group.id, group])));
const orderedLayerGroups = computed(() => {
  const result: ProjectLayerGroupSnapshot[] = [];
  const visit = (parentId?: number) => {
    for (const group of layerGroups.value) {
      if (group.parentId === parentId) { result.push(group); visit(group.id); }
    }
  };
  visit();
  return result;
});
const layerTreeRows = computed(() => orderedLayerGroups.value.flatMap(group => [
  { key: `group:${group.id}`, group, layer: undefined as LayerStateDetail["layers"][number] | undefined },
  ...layerRows.value.filter(layer => layer.groupId === group.id).map(layer => ({ key: `layer:${layer.id}`, group, layer })),
]));

/** Includes the group itself, then its ancestors. The session validates the tree. */
function groupPath(groupId: number): ProjectLayerGroupSnapshot[] {
  const path: ProjectLayerGroupSnapshot[] = [];
  for (let group = groupsById.value.get(groupId); group; group = group.parentId === undefined ? undefined : groupsById.value.get(group.parentId)) path.push(group);
  return path;
}

function groupNameMatches(groupId: number): boolean {
  return groupPath(groupId).some(group => group.name.toLocaleLowerCase().includes(layerQuery.value));
}

const filteredLayerRows = computed(() => {
  return layerQuery.value
    ? layerRows.value.filter((layer) =>
        layer.name.toLocaleLowerCase().includes(layerQuery.value) || groupNameMatches(layer.groupId),
      )
    : layerRows.value;
});
const visibleGroupIds = computed(() => {
  if (!layerQuery.value) return new Set(layerGroups.value.filter(group => groupPath(group.id).slice(1).every(parent => !parent.collapsed)).map(group => group.id));
  const visible = new Set<number>();
  const includePath = (groupId: number) => groupPath(groupId).forEach(group => visible.add(group.id));
  for (const layer of filteredLayerRows.value) includePath(layer.groupId);
  for (const group of layerGroups.value) if (groupNameMatches(group.id)) includePath(group.id);
  return visible;
});

function layerIsVisible(layer: ProjectLayerSnapshot): boolean {
  return filteredLayerRows.value.includes(layer) && (Boolean(layerQuery.value) || groupPath(layer.groupId).every(group => !group.collapsed));
}

function groupDepth(groupId: number): number { return groupPath(groupId).length - 1; }

function groupParentOptions(groupId: number): ProjectLayerGroupSnapshot[] {
  return orderedLayerGroups.value.filter(group => !groupPath(group.id).some(parent => parent.id === groupId));
}

function groupIsNonempty(groupId: number): boolean {
  return layerRows.value.some(layer => layer.groupId === groupId) || layerGroups.value.some(group => group.parentId === groupId);
}

async function executeGroupAction(id: AgentActionId, params: Record<string, unknown>): Promise<boolean> {
  if (projectReadOnly.value) { groupActionError.value = projectReadOnlyReason.value; return false; }
  if (groupActionBusy.value) return false;
  groupActionBusy.value = true;
  groupActionError.value = "";
  try {
    const result = await agentActions.execute(id, params);
    if (!result.ok) { groupActionError.value = result.error.message; return false; }
    return true;
  } catch (error) {
    groupActionError.value = redactErrorMessage(error instanceof Error ? error.message : String(error));
    return false;
  } finally { groupActionBusy.value = false; }
}

async function addLayerGroup(): Promise<void> {
  const name = newGroupName.value.trim();
  if (!name) return;
  const group = { name, active: true, alpha: 1, collapsed: false, ...(newGroupParent.value ? { parentId: Number(newGroupParent.value) } : {}) };
  if (await executeGroupAction(AGENT_ACTIONS.layerGroupAdd, { group })) newGroupName.value = "";
}

async function moveLayerGroup(groupId: number, event: Event): Promise<void> {
  const select = event.currentTarget as HTMLSelectElement;
  await executeGroupAction(AGENT_ACTIONS.layerGroupMove, { groupId, ...(select.value ? { parentId: Number(select.value) } : {}) });
  // The native select already changed before the action; restore authoritative state on failure.
  select.value = String(groupsById.value.get(groupId)?.parentId ?? "");
}

function matchingLayerCount(groupId: number): number {
  return filteredLayerRows.value.filter((layer) => layer.groupId === groupId).length;
}

function layerVisibilityId(id: number): string {
  if (id === RUNTIME_LAYER_IDS.atlas) return "atlas-visibility";
  if (id === RUNTIME_LAYER_IDS.points) return "point-visibility";
  if (id === RUNTIME_LAYER_IDS.raster) {
    return "single-raster-visibility";
  }
  if (id === RUNTIME_LAYER_IDS.plateModel) return "plate-visibility";
  return `layer-${id}-visibility`;
}

function layerSwatchClass(layer: ProjectLayerSnapshot): string {
  if (layer.type === ProjectLayerType.Atlas) return "atlas";
  if (layer.type === ProjectLayerType.Point) return "points";
  if (layer.type === ProjectLayerType.Line) return "lines";
  if (layer.type === ProjectLayerType.Polygon) return "polygons";
  if (layer.type === ProjectLayerType.Raster) return "raster";
  return layer.type === ProjectLayerType.PlateModel ? "plates" : "unsupported";
}

function isSupportedLayerType(layer: ProjectLayerSnapshot): boolean {
  return [ProjectLayerType.Point, ProjectLayerType.Line, ProjectLayerType.Polygon, ProjectLayerType.Raster,
    ProjectLayerType.Atlas, ProjectLayerType.PlateModel].includes(layer.type);
}

function isOrdinaryPointLayer(layer: ProjectLayerSnapshot): boolean {
  return layer.type === ProjectLayerType.Point && !defaultLayerIds.has(layer.id);
}

function isOrdinaryLineLayer(layer: ProjectLayerSnapshot): boolean {
  return layer.type === ProjectLayerType.Line && !defaultLayerIds.has(layer.id);
}

function isOrdinaryPolygonLayer(layer: ProjectLayerSnapshot): boolean {
  return layer.type === ProjectLayerType.Polygon && !defaultLayerIds.has(layer.id);
}

function isOrdinaryRasterLayer(layer: ProjectLayerSnapshot): boolean {
  return layer.type === ProjectLayerType.Raster && !defaultLayerIds.has(layer.id);
}

function isOrdinaryAtlasLayer(layer: ProjectLayerSnapshot): boolean {
  return layer.type === ProjectLayerType.Atlas && !defaultLayerIds.has(layer.id);
}

function canRetryLayer(layer: LayerStateDetail["layers"][number]): boolean {
  return layer.runtimeStatus === "error" && (isOrdinaryPointLayer(layer) || isOrdinaryLineLayer(layer) ||
    isOrdinaryPolygonLayer(layer) || layer.type === ProjectLayerType.Raster || layer.type === ProjectLayerType.Atlas);
}

function selectedRasterId(layer: ProjectLayerSnapshot): string {
  return layer.rasterId === undefined ? defaultRasterId.value ?? ""
    : typeof layer.rasterId === "string" ? layer.rasterId : "";
}

function rasterSelectionError(layer: ProjectLayerSnapshot): string {
  if (layer.rasterId !== undefined && (typeof layer.rasterId !== "string" || !layer.rasterId.trim())) {
    return "Saved raster selection is invalid.";
  }
  return availableRasterIds.value.has(selectedRasterId(layer)) ? "" : "Raster selection is unavailable in the manifest.";
}

const nativePointStyles = computed(() => new Map(layerRows.value.filter(isOrdinaryPointLayer).map(layer => {
  let value: { style?: NativePointStyle; error?: string };
  try { value = { style: readNativePointStyle(layer.pointStyle) }; }
  catch (error) { value = { error: redactErrorMessage(error instanceof Error ? error.message : String(error)) }; }
  return [layer.id, value];
})));

const nativeLineStyles = computed(() => new Map(layerRows.value.filter(isOrdinaryLineLayer).map(layer => {
  let value: { style?: NativeLineStyle; error?: string };
  try { value = { style: readNativeLineStyle(layer.lineStyle) }; }
  catch (error) { value = { error: redactErrorMessage(error instanceof Error ? error.message : String(error)) }; }
  return [layer.id, value];
})));

const nativePolygonStyles = computed(() => new Map(layerRows.value.filter(isOrdinaryPolygonLayer).map(layer => {
  let value: { style?: NativePolygonStyle; error?: string };
  try { value = { style: readNativePolygonStyle(layer.polygonStyle) }; }
  catch (error) { value = { error: redactErrorMessage(error instanceof Error ? error.message : String(error)) }; }
  return [layer.id, value];
})));

async function changeNativePointStyle(layer: ProjectLayerSnapshot, field: "singleColor" | "pointSize", event: Event): Promise<void> {
  const input = event.currentTarget as HTMLInputElement;
  const value = field === "pointSize" ? Number(input.value) : input.value;
  await executePointLayerAction(AGENT_ACTIONS.layerSetStyle, { layerId: layer.id, style: { [field]: value } },
    `Updating ${layer.name} style…`, `Style state updated for ${layer.name}.`);
  const current = nativePointStyles.value.get(layer.id)?.style;
  if (current) input.value = String(current[field]);
}

async function changeNativeLineStyle(layer: ProjectLayerSnapshot, field: "lineColor" | "lineWidth", event: Event): Promise<void> {
  const input = event.currentTarget as HTMLInputElement;
  const value = field === "lineWidth" ? Number(input.value) : input.value;
  await executePointLayerAction(AGENT_ACTIONS.layerSetStyle, { layerId: layer.id, style: { [field]: value } },
    `Updating ${layer.name} style…`, `Style state updated for ${layer.name}.`);
  const current = nativeLineStyles.value.get(layer.id)?.style;
  if (current) input.value = String(current[field]);
}

async function changeNativePolygonStyle(layer: ProjectLayerSnapshot, field: keyof NativePolygonStyle, event: Event): Promise<void> {
  const input = event.currentTarget as HTMLInputElement;
  const value = field === "outlineWidth" ? Number(input.value) : input.value;
  await executePointLayerAction(AGENT_ACTIONS.layerSetStyle, { layerId: layer.id, style: { [field]: value } },
    `Updating ${layer.name} style…`, `Style state updated for ${layer.name}.`);
  const current = nativePolygonStyles.value.get(layer.id)?.style;
  if (current) input.value = String(current[field]);
}

async function executePointLayerAction(actionId: string, params: Record<string, unknown>, pending: string, completed: string): Promise<boolean> {
  if (projectReadOnly.value) { pointLayerActionError.value = projectReadOnlyReason.value; return false; }
  if (pointLayerActionBusy.value) return false;
  pointLayerActionBusy.value = true;
  pointLayerActionMessage.value = pending;
  pointLayerActionError.value = "";
  try {
    const result = await agentActions.execute(actionId, params);
    if (!result.ok) {
      pointLayerActionError.value = result.error.message;
      pointLayerActionMessage.value = "";
      return false;
    }
    pointLayerActionMessage.value = completed;
    return true;
  } catch (error) {
    pointLayerActionError.value = redactErrorMessage(error instanceof Error ? error.message : String(error));
    pointLayerActionMessage.value = "";
    return false;
  } finally { pointLayerActionBusy.value = false; }
}

async function removePointLayer(layer: ProjectLayerSnapshot): Promise<void> {
  if (!isOrdinaryPointLayer(layer) && !isOrdinaryLineLayer(layer) && !isOrdinaryPolygonLayer(layer) && !isOrdinaryRasterLayer(layer) && !isOrdinaryAtlasLayer(layer)) return;
  await executePointLayerAction(AGENT_ACTIONS.layerRemove, { layerId: layer.id }, `Removing ${layer.name}…`, `Removed ${layer.name}.`);
}

async function retryLayer(layer: LayerStateDetail["layers"][number]): Promise<void> {
  if (!canRetryLayer(layer)) return;
  await executePointLayerAction(AGENT_ACTIONS.layerRetry, { layerId: layer.id }, `Retrying ${layer.name}…`, `Retried ${layer.name}.`);
}

async function addPointLayer(): Promise<void> {
  const name = newPointLayerName.value.trim();
  const groupId = Number(newPointLayerGroup.value);
  if (!name || !groupsById.value.has(groupId)) return;
  const layer = { name, type: ProjectLayerType.Point, sourceRef: pointFixtureSourceRef, groupId, active: true, alpha: 1 };
  if (await executePointLayerAction(AGENT_ACTIONS.layerAdd, { layer }, `Adding ${name}…`, `Added ${name}.`)) newPointLayerName.value = "";
}

async function addLineLayer(): Promise<void> {
  const name = newLineLayerName.value.trim();
  const groupId = Number(newLineLayerGroup.value);
  if (!name || !groupsById.value.has(groupId)) return;
  const layer = { name, type: ProjectLayerType.Line, sourceRef: lineFixtureSourceRef, groupId, active: true, alpha: 1 };
  if (await executePointLayerAction(AGENT_ACTIONS.layerAdd, { layer }, `Adding ${name}…`, `Added ${name}.`)) newLineLayerName.value = "";
}

async function addPolygonLayer(): Promise<void> {
  const name = newPolygonLayerName.value.trim();
  const groupId = Number(newPolygonLayerGroup.value);
  if (!name || !groupsById.value.has(groupId)) return;
  const layer = { name, type: ProjectLayerType.Polygon, sourceRef: polygonFixtureSourceRef, groupId, active: true, alpha: 1 };
  if (await executePointLayerAction(AGENT_ACTIONS.layerAdd, { layer }, `Adding ${name}…`, `Added ${name}.`)) newPolygonLayerName.value = "";
}

async function addRasterLayer(): Promise<void> {
  const name = newRasterLayerName.value.trim();
  const groupId = Number(newRasterLayerGroup.value);
  const rasterId = newRasterLayerSelection.value;
  if (!name || !groupsById.value.has(groupId) || !availableRasterIds.value.has(rasterId)) return;
  const layer = { name, type: ProjectLayerType.Raster, sourceRef: rasterManifestSourceRef, groupId, active: true, alpha: 1, rasterId };
  if (await executePointLayerAction(AGENT_ACTIONS.layerAdd, { layer }, `Adding ${name}…`, `Added ${name}.`)) newRasterLayerName.value = "";
}

async function addAtlasLayer(): Promise<void> {
  const name = newAtlasLayerName.value.trim();
  const groupId = Number(newAtlasLayerGroup.value);
  if (!name || !groupsById.value.has(groupId) || !atlasSourceAvailable.value) return;
  const layer = { name, type: ProjectLayerType.Atlas, sourceRef: atlasManifestSourceRef, groupId, active: true, alpha: 1 };
  if (await executePointLayerAction(AGENT_ACTIONS.layerAdd, { layer }, `Adding ${name}…`, `Added ${name}.`)) newAtlasLayerName.value = "";
}

async function changeRasterSelection(layer: ProjectLayerSnapshot, event: Event): Promise<void> {
  const select = event.currentTarget as HTMLSelectElement;
  if (availableRasterIds.value.has(select.value)) {
    await executePointLayerAction(AGENT_ACTIONS.rasterSelect, { layerId: layer.id, rasterId: select.value },
      `Selecting raster for ${layer.name}…`, `Raster selection updated for ${layer.name}.`);
  }
  const current = layerRows.value.find(item => item.id === layer.id);
  select.value = current ? selectedRasterId(current) : "";
}

function showLayerStyle(id = selectedLayerId.value): void {
  const layerId = id ?? layerRows.value[0]?.id;
  const layer = layerRows.value.find((item) => item.id === layerId);
  if (!layer) {
    throw new AgentActionValidationError("The requested layer is not available.");
  }
  if (!filteredLayerRows.value.some((item) => item.id === layerId)) layerSearch.value = "";
  for (const id of groupPath(layer.groupId).map(group => group.id).reverse()) {
    const group = groupsById.value.get(id);
    if (group?.collapsed) toggleGroup(group);
  }
  activeSidebarTab.value = "layers";
  selectedLayerId.value = layerId;
}

function closeLayerStyle(): void {
  selectedLayerId.value = undefined;
}

function toggleLayerStyle(id: number): void {
  if (selectedLayerId.value === id) closeLayerStyle();
  else showLayerStyle(id);
}

function changeLayerVisibility(
  layer: ProjectLayerSnapshot,
  event: Event,
): void {
  requireProjectEditable();
  const active = (event.currentTarget as HTMLInputElement).checked;
  layer.active = active;
  window.dispatchEvent(
    new CustomEvent(LAYER_VISIBILITY_CHANGE_EVENT, {
      detail: { active, id: layer.id },
    }),
  );
}

function changeLayerOpacity(
  layer: ProjectLayerSnapshot,
  event: Event,
): void {
  requireProjectEditable();
  const alpha = Number((event.currentTarget as HTMLInputElement).value) / 100;
  layer.alpha = alpha;
  window.dispatchEvent(
    new CustomEvent(LAYER_OPACITY_CHANGE_EVENT, {
      detail: { alpha, id: layer.id },
    }),
  );
}

function publishPointStyle(
  layer: ProjectLayerSnapshot,
  style: PointStyleExpression,
): void {
  requireProjectEditable();
  const normalized = normalizePointStyleExpression(style);
  layer.pointStyle = normalized;
  window.dispatchEvent(
    new CustomEvent(POINT_STYLE_CHANGE_EVENT, {
      detail: { id: layer.id, style: normalized },
    }),
  );
}

function changePointStyleField(
  layer: ProjectLayerSnapshot,
  field:
    | "colorMode"
    | "occurrenceSizeScale"
    | "pointSize"
    | "shape"
    | "singleColor"
    | "sizeMode",
  event: Event,
): void {
  const input = event.currentTarget as HTMLInputElement | HTMLSelectElement;
  const style = normalizePointStyleExpression(layer.pointStyle);
  if (field === "pointSize" || field === "occurrenceSizeScale") {
    style[field] = Number(input.value);
  } else if (field === "colorMode") {
    style.colorMode = input.value as PointStyleExpression["colorMode"];
  } else if (field === "shape") {
    style.shape = input.value as PointStyleExpression["shape"];
  } else if (field === "sizeMode") {
    style.sizeMode = input.value as PointStyleExpression["sizeMode"];
  } else {
    style.singleColor = input.value;
  }
  publishPointStyle(layer, style);
}

function changePointFilter(
  layer: ProjectLayerSnapshot,
  field: "maximumOccurrence" | "minimumOccurrence" | "plateId",
  event: Event,
): void {
  const input = event.currentTarget as HTMLInputElement;
  const style = normalizePointStyleExpression(layer.pointStyle);
  if (field === "plateId") {
    style.filter.plateId =
      input.value.trim() === "" ? null : Number(input.value);
  } else {
    style.filter[field] = Number(input.value);
  }
  publishPointStyle(layer, style);
}

function beginLayerDrag(event: DragEvent, id: number): void {
  if (projectReadOnly.value || layerSearch.value) {
    event.preventDefault();
    return;
  }
  draggedLayerId.value = id;
  event.dataTransfer?.setData("text/plain", String(id));
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
  }
}

function finishLayerDrag(): void {
  draggedLayerId.value = undefined;
  dropTargetLayerId.value = undefined;
}

function dropLayer(targetId: number): void {
  requireProjectEditable();
  const sourceId = draggedLayerId.value;
  finishLayerDrag();
  if (sourceId === undefined || sourceId === targetId) {
    return;
  }
  const sourceIndex = layerRows.value.findIndex(
    (layer) => layer.id === sourceId,
  );
  const targetIndex = layerRows.value.findIndex(
    (layer) => layer.id === targetId,
  );
  if (sourceIndex < 0 || targetIndex < 0) {
    return;
  }
  const nextLayers = [...layerRows.value];
  const targetLayer = nextLayers[targetIndex];
  const [movedLayer] = nextLayers.splice(sourceIndex, 1);
  if (!movedLayer || !targetLayer) {
    return;
  }
  movedLayer.groupId = targetLayer.groupId;
  nextLayers.splice(targetIndex, 0, movedLayer);
  layerRows.value = nextLayers;
  publishLayerOrder();
}

function dropLayerIntoGroup(groupId: number): void {
  requireProjectEditable();
  const sourceId = draggedLayerId.value;
  finishLayerDrag();
  if (sourceId === undefined) {
    return;
  }
  const nextLayers = [...layerRows.value];
  const sourceIndex = nextLayers.findIndex(
    (layer) => layer.id === sourceId,
  );
  if (sourceIndex < 0) {
    return;
  }
  const [movedLayer] = nextLayers.splice(sourceIndex, 1);
  if (!movedLayer) {
    return;
  }
  movedLayer.groupId = groupId;
  const groupEnd = nextLayers.reduce(
    (lastIndex, layer, index) =>
      layer.groupId === groupId ? index + 1 : lastIndex,
    0,
  );
  nextLayers.splice(groupEnd, 0, movedLayer);
  layerRows.value = nextLayers;
  publishLayerOrder();
}

function publishLayerOrder(): void {
  window.dispatchEvent(
    new CustomEvent(LAYER_ORDER_CHANGE_EVENT, {
      detail: {
        groupIdByLayer: Object.fromEntries(
          layerRows.value.map((layer) => [layer.id, layer.groupId]),
        ),
        orderedIds: layerRows.value.map((layer) => layer.id),
      },
    }),
  );
}

function changeGroupVisibility(
  group: ProjectLayerGroupSnapshot,
  event: Event,
): void {
  requireProjectEditable();
  group.active = (event.currentTarget as HTMLInputElement).checked;
  window.dispatchEvent(
    new CustomEvent(LAYER_GROUP_VISIBILITY_CHANGE_EVENT, {
      detail: { active: group.active, id: group.id },
    }),
  );
}

function changeGroupOpacity(
  group: ProjectLayerGroupSnapshot,
  event: Event,
): void {
  requireProjectEditable();
  group.alpha =
    Number((event.currentTarget as HTMLInputElement).value) / 100;
  window.dispatchEvent(
    new CustomEvent(LAYER_GROUP_OPACITY_CHANGE_EVENT, {
      detail: { alpha: group.alpha, id: group.id },
    }),
  );
}

function toggleGroup(group: ProjectLayerGroupSnapshot): void {
  requireProjectEditable();
  group.collapsed = !group.collapsed;
  window.dispatchEvent(
    new CustomEvent(LAYER_GROUP_COLLAPSE_CHANGE_EVENT, {
      detail: { collapsed: group.collapsed, id: group.id },
    }),
  );
}

function handleLayerState(event: Event): void {
  const detail = (event as CustomEvent<LayerStateDetail>).detail;
  layerGroups.value = detail.groups.map((group) => ({ ...group }));
  layerRows.value = detail.layers.map((layer) => ({ ...layer }));
  rasterOptions.value = (detail.rasterOptions ?? []).map(({ id, label }) => ({ id, label }));
  defaultRasterId.value = detail.defaultRasterId;
  atlasSource.value = detail.atlasSource ? { ...detail.atlasSource } : undefined;
  if (!availableRasterIds.value.has(newRasterLayerSelection.value)) {
    newRasterLayerSelection.value = detail.defaultRasterId && availableRasterIds.value.has(detail.defaultRasterId) ? detail.defaultRasterId : "";
  }
  if (newGroupParent.value && !groupsById.value.has(Number(newGroupParent.value))) newGroupParent.value = "";
  if (newPointLayerGroup.value && !groupsById.value.has(Number(newPointLayerGroup.value))) newPointLayerGroup.value = "";
  if (newLineLayerGroup.value && !groupsById.value.has(Number(newLineLayerGroup.value))) newLineLayerGroup.value = "";
  if (newPolygonLayerGroup.value && !groupsById.value.has(Number(newPolygonLayerGroup.value))) newPolygonLayerGroup.value = "";
  if (newRasterLayerGroup.value && !groupsById.value.has(Number(newRasterLayerGroup.value))) newRasterLayerGroup.value = "";
  if (newAtlasLayerGroup.value && !groupsById.value.has(Number(newAtlasLayerGroup.value))) newAtlasLayerGroup.value = "";
  if (
    selectedLayerId.value !== undefined &&
    !layerRows.value.some((layer) => layer.id === selectedLayerId.value)
  ) {
    selectedLayerId.value = layerRows.value[0]?.id;
  }
}

/**
 * Band colour is data and stays untouched; only the label adapts, to whichever
 * of black/white has the higher WCAG ratio on that exact band colour.
 */
function segmentStyle(segment: TimelineSegment): Record<string, string> {
  const label = readableLabelColor(segment.color);
  return {
    background: segment.color,
    color: label,
    textShadow: labelTextShadow(label),
    flex: `${segment.weight} 1 0px`,
  };
}

function timelineExtensionStyle(segments: TimelineSegment[]): Record<string, string> {
  const originalWeight = segments.reduce((total, segment) => total + segment.weight, 0);
  return segmentStyle({ label: "", color: "#d8dde2", weight: (timelineMaximum.value - 538.8) / 538.8 * originalWeight });
}

function toggleAccountMenu(): void {
  if (phase1B.value.account) {
    accountMenuVisible.value = !accountMenuVisible.value;
  } else {
    setAuthDialogOpen(true);
  }
}

function showToast(message: string): void {
  toastMessage.value = message;
  toastVisible.value = true;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastVisible.value = false;
  }, 1800);
}

/**
 * The shared business handlers.
 *
 * Each one performs the real work and throws on failure. The UI calls them and
 * turns the outcome into a toast; the action facade calls the same function and
 * returns the outcome to the caller. Neither path decides success from the
 * previously cached session state.
 */
async function requestProjectSave(): Promise<void> {
  if (!phase1B.value.account) {
    setAuthDialogOpen(true);
    showToast(
      phase1B.value.status === "disabled"
        ? phase1B.value.message
        : "Sign in to save this project to the cloud",
    );
    return;
  }
  await executeProjectAction(AGENT_ACTIONS.projectSave, {}, "Cloud project saved");
}

async function executeProjectAction(actionId: string, params: Record<string, unknown>, message: string): Promise<void> {
  if (projectActionBusy.value) return;
  projectActionBusy.value = true;
  projectActionError.value = "";
  try {
    const result = await agentActions.execute(actionId, params);
    if (!result.ok) { projectActionError.value = result.error.message; return; }
    showToast(message);
  } catch (error) {
    projectActionError.value = redactErrorMessage(error instanceof Error ? error.message : String(error));
  } finally { projectActionBusy.value = false; }
}

async function sendLoginCode(): Promise<void> {
  try {
    await requestLoginCode();
    showToast("Verification code sent");
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
}

/**
 * The shared business handler behind the Send code button and the
 * `auth.sendCode` action: validates its own input, performs the real request
 * and throws on failure, so neither path can report a code that was never
 * sent.
 */
async function requestLoginCode(): Promise<void> {
  if (authBusy.value) {
    throw new AgentActionBusyError("An authentication request is already running.");
  }
  if (!authEmail.value.trim()) {
    throw new AgentActionValidationError(
      "auth.sendCode requires a non-empty 'email'.",
    );
  }
  authBusy.value = true;
  try {
    await phase1BCloudClient.sendLoginCode(authEmail.value);
  } finally {
    authBusy.value = false;
  }
}

/**
 * The shared sign-in business handlers.
 *
 * Each one validates its own input, performs the real request and resolves with
 * the state the Server returned for THIS sign-in, so a failure can never be
 * masked by a previously cached account. The UI wrappers below and the
 * `auth.login` action both call these.
 */
async function signIn(
  mode: "account" | "email-code",
  identifier: string,
  secret: string,
): Promise<Phase1BState> {
  if (authBusy.value) {
    throw new AgentActionBusyError("An authentication request is already running.");
  }
  authBusy.value = true;
  const normalizedSecret = mode === "email-code" ? secret.trim() : secret;
  try {
    const accountMode = mode === "account";
    if (!identifier.trim()) {
      throw new AgentActionValidationError(
        `auth.login requires a non-empty '${accountMode ? "account" : "email"}'.`,
      );
    }
    if (accountMode ? !secret : !secret.trim()) {
      throw new AgentActionValidationError(
        `auth.login requires a non-empty '${accountMode ? "password" : "code"}'.`,
      );
    }
    authMode.value = mode;
    if (accountMode) authAccount.value = identifier;
    else authEmail.value = identifier;
    const state = accountMode
      ? await phase1BCloudClient.loginWithPassword(identifier, secret)
      : await phase1BCloudClient.login(identifier, normalizedSecret);
    if (!state.account) {
      throw new AgentActionValidationError("Sign-in did not produce a session.");
    }
    setAuthDialogOpen(false);
    return state;
  } catch (error) {
    // Verification codes are also secrets even though the general API uses
    // "code" for ordinary business error codes elsewhere.
    const message = redactErrorMessage(error instanceof Error ? error.message : String(error), { secret, normalizedSecret });
    throw error instanceof AgentActionFailureError
      ? new AgentActionFailureError(error.kind, message)
      : new Error(message);
  } finally {
    authBusy.value = false;
    authPassword.value = "";
    authCode.value = "";
  }
}

/** UI wrapper: the password field never lingers in component state. */
async function signInWithPassword(): Promise<void> {
  const password = authPassword.value;
  try {
    await signIn("account", authAccount.value, password);
    showToast("Signed in and shared catalog refreshed");
  } catch (error) {
    showToast(redactErrorMessage(error instanceof Error ? error.message : String(error), { password }));
  }
}

async function signInWithEmailCode(): Promise<void> {
  const code = authCode.value;
  try {
    await signIn("email-code", authEmail.value, code);
    showToast("Signed in and shared catalog refreshed");
  } catch (error) {
    showToast(redactErrorMessage(error instanceof Error ? error.message : String(error), { secret: code }));
  }
}

async function logout(): Promise<void> {
  accountMenuVisible.value = false;
  await phase1BCloudClient.logout();
  showToast("Signed out");
}

/** Reports the real outcome instead of always announcing success. */
async function refreshCloudWorkspace(context?: OperationContext): Promise<Phase1BState> {
  try {
    const state = await phase1BCloudClient.refreshCatalogs(context ? {
      signal: context.signal,
      context: { traceId: context.traceId, jobId: context.jobId, actionId: AGENT_ACTIONS.catalogRefresh },
    } : undefined);
    if (
      state.sharedPlateModelsStatus === "error" ||
      state.sharedPlateModelsStatus === "incomplete"
    ) {
      showToast(
        state.sharedPlateModelsError || "Catalog refresh failed.",
      );
      return state;
    }
    showToast(
      state.account ? "Cloud workspace refreshed" : "Public catalog refreshed",
    );
    return state;
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

function selectPlateModel(versionId: number): void {
  requireProjectEditable();
  phase1BCloudClient.selectPlateModel(versionId);
  showToast("Versioned plate model selected; reloading…");
  window.setTimeout(() => window.location.reload(), 280);
}

/** Selects a shared (V1) plate model by its `UserPlateModel` ID. */
function selectSharedPlateModel(plateModelId: number): void {
  requireProjectEditable();
  phase1BCloudClient.selectSharedPlateModel(plateModelId);
  showToast(`Shared plate model ${plateModelId} selected; reloading…`);
  window.setTimeout(() => window.location.reload(), 280);
}

function selectLocalPlateModelDemo(): void {
  requireProjectEditable();
  phase1BCloudClient.selectLocalPlateModelDemo();
  showToast("Local demo plate model selected; reloading…");
  window.setTimeout(() => window.location.reload(), 280);
}

function selectDataset(versionId: number): void {
  requireProjectEditable();
  phase1BCloudClient.selectDataset(versionId);
  showToast("Dataset selected; reloading its versioned manifest…");
  window.setTimeout(() => window.location.reload(), 280);
}

async function openCloudProject(
  project: ProjectRevisionSummaryRO,
): Promise<void> {
  if (projectReadOnly.value) { projectActionError.value = projectReadOnlyReason.value; return; }
  await executeProjectAction(AGENT_ACTIONS.projectOpen, { revisionId: foreignKeyValue(project.Revision) }, "Cloud project opened");
}

function handleProjectSaved(event: Event): void {
  const detail = (event as CustomEvent<{ message?: string }>).detail;
  showToast(detail?.message ?? "Local draft saved");
}

function handleProjectSaveError(event: Event): void {
  const detail = (event as CustomEvent<{ message?: string }>).detail;
  showToast(detail?.message ?? "Project save failed");
}

function handleAuthRequired(): void {
  setAuthDialogOpen(true);
}

function requireUploadAccess(): void {
  requireProjectEditable();
  requireV2Workspace(phase1B.value.v2WorkspaceAvailable, "dataset ingest");
  if (!phase1B.value.account) {
    setAuthDialogOpen(true);
    throw new AgentActionAuthError("Sign in to upload a dataset.");
  }
}

function openUploadWizard(): void {
  requireUploadAccess();
  if (uploadBusy.value) {
    throw new AgentActionBusyError("An ingest job is already running.");
  }
  uploadFile = undefined;
  uploadPreview.value = undefined;
  uploadFileName.value = "";
  uploadFileSize.value = 0;
  uploadName.value = "";
  uploadDescription.value = "";
  uploadError.value = "";
  uploadProgress.value = 0;
  uploadStage.value = "";
  uploadMessage.value = "";
  uploadJobId.value = 0;
  uploadStep.value = "select";
  const firstPlateModel = ingestPlateModels.value[0];
  uploadPlateModelId.value = firstPlateModel
    ? foreignKeyValue(firstPlateModel.PlateModel)
    : 0;
  uploadDialogVisible.value = true;
}

function showUploadWizard(): void {
  try { openUploadWizard(); }
  catch (error) { showToast(redactErrorMessage(error instanceof Error ? error.message : String(error))); }
}

function goBackInUploadWizard(step: unknown = "select"): void {
  requireUploadAccess();
  if (uploadBusy.value) {
    throw new AgentActionBusyError("An ingest job is already running.");
  }
  if (!uploadDialogVisible.value) {
    throw new AgentActionValidationError("Open the upload wizard before changing its step.");
  }
  if (step !== "select" && step !== "map" && step !== "run") {
    throw new AgentActionValidationError("upload.back 'step' must be 'select', 'map' or 'run'.");
  }
  uploadStep.value = step;
}

function showUploadStep(step: UploadStep): void {
  try { goBackInUploadWizard(step); }
  catch (error) { showToast(redactErrorMessage(error instanceof Error ? error.message : String(error))); }
}

function closeUploadWizard(): void {
  if (uploadBusy.value) {
    // Refuse instead of silently appearing to close a running job.
    throw new AgentActionBusyError(
      "An ingest job is running; cancel it before closing the wizard.",
    );
  }
  uploadDialogVisible.value = false;
  uploadFile = undefined;
  uploadPreview.value = undefined;
}

/** Backdrop dismissal: the refusal is reported, never thrown at the DOM. */
function dismissUploadWizard(): void {
  try {
    closeUploadWizard();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
}

/** One writer for Dialog-driven open changes (Esc, overlay, close button). */
function handleUploadDialogOpen(open: boolean): void {
  if (!open) dismissUploadWizard();
}

async function selectUploadFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) {
    return;
  }
  uploadError.value = "";
  const fileError = validateSourceFile(file);
  if (fileError) {
    uploadError.value = fileError;
    input.value = "";
    return;
  }
  uploadBusy.value = true;
  try {
    const preview = await readCsvPreview(file);
    uploadFile = file;
    uploadFileName.value = file.name;
    uploadFileSize.value = file.size;
    uploadPreview.value = preview;
    uploadMapping.value = guessColumnMapping(preview.headerList);
    if (!uploadName.value) {
      uploadName.value = file.name.replace(/\.[^.]+$/, "");
    }
    uploadStep.value = "map";
  } catch (error) {
    uploadError.value = error instanceof Error ? error.message : String(error);
    input.value = "";
  } finally {
    uploadBusy.value = false;
  }
}

/**
 * Applies an optional direct upload request to the wizard state. The File stays
 * outside reactive state so Vue never walks a large payload.
 */
function applyUploadRequest(params: Record<string, unknown>): void {
  if (params.file instanceof Blob) {
    uploadFile =
      params.file instanceof File
        ? params.file
        : new File([params.file], "dataset.csv", { type: "text/csv" });
    uploadFileName.value = uploadFile.name;
    uploadFileSize.value = uploadFile.size;
    uploadPreview.value = undefined;
  }
  if (typeof params.name === "string") {
    uploadName.value = params.name;
  }
  if (typeof params.description === "string") {
    uploadDescription.value = params.description;
  }
  if (typeof params.plateModelId === "number") {
    uploadPlateModelId.value = params.plateModelId;
  }
  if (params.mapping && typeof params.mapping === "object") {
    uploadMapping.value = {
      ...uploadMapping.value,
      ...(params.mapping as Partial<ColumnMapping>),
    };
  }
}

async function startIngest(params: Record<string, unknown> = {}): Promise<void> {
  if (uploadBusy.value) {
    throw new AgentActionBusyError("An ingest job is already running.");
  }
  applyUploadRequest(params);
  if (!uploadFile) {
    throw new AgentActionValidationError("Choose a CSV file first.");
  }
  if (!uploadName.value.trim()) {
    throw new AgentActionValidationError("Give the dataset a name.");
  }
  const mappingError = validateMapping(uploadMapping.value);
  if (mappingError) {
    throw new AgentActionValidationError(mappingError);
  }
  if (uploadPlateModelId.value <= 0) {
    throw new AgentActionValidationError("Select a plate model.");
  }

  uploadError.value = "";
  uploadBusy.value = true;
  uploadStep.value = "run";
  uploadAbort = new AbortController();
  try {
    const outcome = await ingestPointCsv({
      description: uploadDescription.value,
      file: uploadFile,
      mapping: uploadMapping.value,
      name: uploadName.value,
      onJobCreated: (jobId) => {
        uploadJobId.value = jobId;
      },
      onProgress: (progress) => {
        uploadProgress.value = progress.progress;
        uploadStage.value = progress.stage;
        uploadMessage.value = progress.message;
      },
      plateModelId: uploadPlateModelId.value,
      signal: uploadAbort.signal,
    });
    await phase1BCloudClient.refreshCatalogs();
    uploadDialogVisible.value = false;
    uploadFile = undefined;
    uploadPreview.value = undefined;
    // Selecting the new version is what adds its point layer, and the runtime manifest is
    // resolved during bootstrap, so the reload is the auto-add.
    selectDataset(outcome.datasetVersionId);
  } catch (error) {
    // Re-raised after the panel is updated, so an automated caller sees a
    // failure instead of a success.
    uploadError.value = error instanceof Error ? error.message : String(error);
    uploadMessage.value = "";
    throw error;
  } finally {
    uploadBusy.value = false;
    uploadAbort = undefined;
  }
}

/**
 * The shared business handler behind the Cancel job button and the
 * `upload.cancel` action: aborts the in-flight request and cancels the Server
 * job, throwing when the Server refuses. The UI wrapper turns that into a
 * toast; the action returns it as a failure.
 */
async function cancelIngestJob(): Promise<void> {
  const jobId = uploadJobId.value;
  uploadAbort?.abort();
  if (jobId > 0) {
    await cancelJob(jobId);
  }
  uploadBusy.value = false;
  uploadStep.value = "map";
}

async function cancelIngest(): Promise<void> {
  try {
    await cancelIngestJob();
    showToast("Ingest job cancelled");
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
}

function registerAgentActions(): void {
  // Declarations (id, params, status) live in ./agent-actions so the inventory
  // exists before mount; here we only attach the handlers the UI already uses.
  const ready = (
    id: (typeof AGENT_ACTIONS)[keyof typeof AGENT_ACTIONS],
    handler: Parameters<typeof agentActions.register>[1],
  ) => {
    agentActions.register(AGENT_DECLARATIONS[id], handler);
  };

  // --- Sign-in -------------------------------------------------------------
  ready(AGENT_ACTIONS.authLogin, async (params) => {
    const mode = params.mode === undefined ? "account" : params.mode;
    if (mode !== "account" && mode !== "email-code") {
      throw new AgentActionValidationError(
        "auth.login 'mode' must be 'account' or 'email-code'.",
      );
    }
    // The signed-in state comes from the value THIS call returned, never from
    // the previously cached session, so a stale account cannot fake success.
    const state = await signIn(
      mode,
      String((mode === "account" ? params.account : params.email) ?? ""),
      String((mode === "account" ? params.password : params.code) ?? ""),
    );
    // Only a safe session summary is returned; no token, password or digest.
    return {
      data: {
        accountName: state.account!.name,
        signedIn: true,
        status: state.status,
        v2WorkspaceAvailable: state.v2WorkspaceAvailable,
      },
    };
  });

  ready(AGENT_ACTIONS.authSendCode, async (params) => {
    if (typeof params.email !== "string" || !params.email.trim()) {
      throw new AgentActionValidationError(
        "auth.sendCode requires a non-empty 'email'.",
      );
    }
    authEmail.value = params.email;
    // The throwing business function, not the toast wrapper: a failed request
    // must reach the caller as a failure.
    await requestLoginCode();
    return {};
  });

  ready(AGENT_ACTIONS.authLogout, async () => {
    await logout();
    return {};
  });

  // --- Catalog and model selection ----------------------------------------
  ready(AGENT_ACTIONS.catalogRefresh, async (_params, context) => {
    const state = await refreshCloudWorkspace(context);
    if (
      state.sharedPlateModelsStatus === "error" ||
      state.sharedPlateModelsStatus === "incomplete"
    ) {
      // The request itself failed, which is not the caller's parameter error,
      // so it is reported as an execution failure rather than a validation one.
      throw new Error(
        state.sharedPlateModelsError || "Catalog refresh failed.",
      );
    }
    return {
      data: {
        modelCount: state.sharedPlateModels.length,
        status: state.sharedPlateModelsStatus,
        total: state.sharedPlateModelsTotal,
      },
    };
  });

  ready(AGENT_ACTIONS.modelSelect, async (params) => {
    const source =
      params.source === undefined ? "shared" : (params.source as string);
    if (
      source !== "shared" &&
      source !== "v2" &&
      source !== "local-demo"
    ) {
      throw new AgentActionValidationError(
        "model.select 'source' must be 'shared', 'v2' or 'local-demo'.",
      );
    }
    if (source === "shared") {
      if (
        typeof params.plateModelId !== "number" ||
        !Number.isInteger(params.plateModelId) ||
        params.plateModelId <= 0
      ) {
        throw new AgentActionValidationError(
          "model.select requires a positive integer 'plateModelId' for the shared source.",
        );
      }
      selectSharedPlateModel(params.plateModelId);
    } else if (source === "v2") {
      requireV2Workspace(
        phase1B.value.v2WorkspaceAvailable,
        "cloud projects",
      );
      if (
        typeof params.versionId !== "number" ||
        !Number.isInteger(params.versionId) ||
        params.versionId <= 0
      ) {
        throw new AgentActionValidationError(
          "model.select requires a positive integer 'versionId' for the v2 source.",
        );
      }
      selectPlateModel(params.versionId);
    } else {
      selectLocalPlateModelDemo();
    }
    return {
      data: {
        accepted: true,
        plateModelId: phase1B.value.selection.plateModelId,
        plateModelVersionId: phase1B.value.selection.plateModelVersionId,
        source,
      },
      reloadRequired: true,
    };
  });

  ready(AGENT_ACTIONS.datasetSelect, async (params) => {
    requireV2Workspace(
      phase1B.value.v2WorkspaceAvailable,
      "cloud projects",
    );
    if (
      typeof params.datasetVersionId !== "number" ||
      !Number.isInteger(params.datasetVersionId) ||
      params.datasetVersionId <= 0
    ) {
      throw new AgentActionValidationError(
        "dataset.select requires a positive integer 'datasetVersionId'.",
      );
    }
    selectDataset(params.datasetVersionId);
    return { data: { accepted: true }, reloadRequired: true };
  });

  // --- Upload wizard (V2 only) --------------------------------------------
  ready(AGENT_ACTIONS.uploadOpen, async () => {
    openUploadWizard();
    return {};
  });

  ready(AGENT_ACTIONS.uploadClose, () => {
    closeUploadWizard();
    return {};
  });

  ready(AGENT_ACTIONS.uploadBack, (params) => {
    goBackInUploadWizard(params.step);
    return { data: { step: uploadStep.value } };
  });

  ready(AGENT_ACTIONS.uploadRun, async (params) => {
    requireV2Workspace(
      phase1B.value.v2WorkspaceAvailable,
      "dataset ingest",
    );
    // A successful ingest selects the new dataset and reloads the page, so the
    // caller waits for bootId to change.
    await startIngest(params);
    return {
      data: { accepted: true, datasetVersionId: phase1B.value.selection.datasetVersionId },
      reloadRequired: true,
    };
  });

  ready(AGENT_ACTIONS.uploadCancel, async () => {
    requireV2Workspace(
      phase1B.value.v2WorkspaceAvailable,
      "dataset ingest",
    );
    await cancelIngestJob();
    return {};
  });

  // --- Pure UI controls ---------------------------------------------------
  ready(AGENT_ACTIONS.sidebarSelect, (params) => {
    const tab = params.tab;
    if (tab !== "layers" && tab !== "plate-models") {
      throw new AgentActionValidationError(
        "ui.sidebar.select 'tab' must be 'layers' or 'plate-models'.",
      );
    }
    selectSidebarTab(tab);
    return { data: { tab } };
  });
  ready(AGENT_ACTIONS.sidebarSetVisible, (params) => {
    if (typeof params.visible !== "boolean") {
      throw new AgentActionValidationError(
        "ui.sidebar.setVisible requires a boolean 'visible'.",
      );
    }
    setSidebarVisible(params.visible);
    return { data: { visible: sidebarVisible.value } };
  });
  ready(AGENT_ACTIONS.addPanelSetVisible, (params) => {
    const visible = params.visible;
    if (typeof visible !== "boolean") {
      throw new AgentActionValidationError(
        "ui.addPanel.setVisible requires a boolean 'visible'.",
      );
    }
    const kind = params.kind;
    if (kind !== undefined && !ADD_PANEL_KINDS.includes(kind as AddLayerKind)) {
      throw new AgentActionValidationError(
        `ui.addPanel.setVisible 'kind' must be one of ${ADD_PANEL_KINDS.join(", ")}.`,
      );
    }
    setAddPanelVisible(visible, kind as AddLayerKind | undefined);
    return { data: { kind: addPanelKind.value, visible: addPanelOpen.value } };
  });
  ready(AGENT_ACTIONS.welcomeSetVisible, (params) => {
    if (typeof params.visible !== "boolean") {
      throw new AgentActionValidationError(
        "ui.welcome.setVisible requires a boolean 'visible'.",
      );
    }
    setWelcomeVisible(params.visible);
    return { data: { visible: welcomeOpen.value } };
  });
  ready(AGENT_ACTIONS.consoleSetVisible, (params) => {
    if (typeof params.visible !== "boolean") {
      throw new AgentActionValidationError(
        "ui.console.setVisible requires a boolean 'visible'.",
      );
    }
    setConsoleVisible(params.visible);
    return { data: { visible: consoleOpen.value } };
  });
  ready(AGENT_ACTIONS.consoleClear, () => {
    const handle = consoleRef.value;
    if (!handle) {
      throw new AgentActionUnsupportedError("The development console is not mounted.");
    }
    // Output only: a running job keeps running.
    handle.clear();
    return { data: { ...handle.snapshot() } };
  });
  ready(AGENT_ACTIONS.consoleSelectOutput, () => {
    const handle = consoleRef.value;
    // Never a fake success: closed panel or empty transcript has nothing to select.
    if (!handle || !handle.selectOutput()) {
      throw new AgentActionValidationError(
        "ui.console.selectOutput needs an open console with retained output.",
      );
    }
    return { data: { selected: true } };
  });
  ready(AGENT_ACTIONS.authDialogOpen, () => {
    setAuthDialogOpen(true);
    return {};
  });
  ready(AGENT_ACTIONS.authDialogClose, () => {
    setAuthDialogOpen(false);
    return {};
  });
  ready(AGENT_ACTIONS.authModeSet, (params) => {
    const mode = params.mode;
    if (mode !== "account" && mode !== "email-code") {
      throw new AgentActionValidationError(
        "ui.authMode.set 'mode' must be 'account' or 'email-code'.",
      );
    }
    setAuthMode(mode);
    return { data: { mode } };
  });
  ready(AGENT_ACTIONS.toolbarToggle, () => {
    toolbarCollapsed.value = !toolbarCollapsed.value;
    return { data: { collapsed: toolbarCollapsed.value } };
  });
  ready(AGENT_ACTIONS.accountMenuToggle, () => {
    toggleAccountMenu();
    return {
      data: {
        accountMenuOpen: accountMenuVisible.value,
        authDialogOpen: authDialogVisible.value,
      },
    };
  });
  ready(AGENT_ACTIONS.accountMenuSetVisible, (params) => {
    const visible = params.visible === true;
    accountMenuVisible.value = visible && Boolean(phase1B.value.account);
    return { data: { open: accountMenuVisible.value } };
  });
  ready(AGENT_ACTIONS.layerSearchSet, (params) => {
    layerSearch.value =
      typeof params.query === "string" ? (params.query as string) : "";
    return { data: { query: layerSearch.value } };
  });
  ready(AGENT_ACTIONS.layerStyleOpen, (params) => {
    showLayerStyle(
      typeof params.layerId === "number"
        ? (params.layerId as number)
        : undefined,
    );
    return { data: { layerId: selectedLayerId.value ?? null } };
  });
  ready(AGENT_ACTIONS.layerStyleClose, () => {
    closeLayerStyle();
    return { data: { layerId: null } };
  });
  ready(AGENT_ACTIONS.moduleSelect, (params) => {
    const moduleName = params.module;
    if (
      typeof moduleName !== "string" ||
      !moduleItems.some((item) => item.label === moduleName)
    ) {
      throw new AgentActionValidationError(
        `ui.module.select 'module' must be one of ${moduleItems
          .map((item) => item.label)
          .join(", ")}.`,
      );
    }
    activeModule.value = moduleName;
    return { data: { module: activeModule.value } };
  });

  // A Server without the V2 endpoints cannot run these actions at all, and the
  // inventory has to say so instead of advertising a ready handler. The V2
  // capability is discovered asynchronously (after mount), so availability is
  // evaluated live: the real handler stays registered, `listActions()` and
  // `execute()` report `unsupported` until the handshake succeeds and then use
  // the handler again. Nothing here drops or re-registers a handler.
  const v2Actions: [AgentActionId, "cloud projects" | "dataset ingest"][] = [
    [AGENT_ACTIONS.datasetSelect, "cloud projects"],
    [AGENT_ACTIONS.uploadOpen, "dataset ingest"],
    [AGENT_ACTIONS.uploadBack, "dataset ingest"],
    [AGENT_ACTIONS.uploadRun, "dataset ingest"],
    [AGENT_ACTIONS.uploadCancel, "dataset ingest"],
  ];
  for (const [id, capability] of v2Actions) {
    agentActions.setAvailability(id, () =>
      phase1B.value.v2WorkspaceAvailable
        ? undefined
        : v2WorkspaceUnavailableReason(capability),
    );
  }

  // --- State sections -----------------------------------------------------
  unsubscribeStateSections.push(
    agentActions.registerStateSection("session", () => sessionSummary()),
    agentActions.registerStateSection("catalog", () => ({
      error: phase1B.value.sharedPlateModelsError,
      mineIds: [...phase1B.value.sharedPlateModelsMineIds],
      // Only the scalar fields the UI needs; the raw PlateModelSimpleRO objects
      // stay out of the snapshot.
      models: phase1B.value.sharedPlateModels.map((model) => ({
        accessRange: foreignKeyValue(model.AccessRange),
        ageEndMa: model.AgeEnd,
        ageStartMa: model.AgeStart,
        id: foreignKeyValue(model.ID),
        name: model.Name || "(unnamed)",
      })),
      status: phase1B.value.sharedPlateModelsStatus,
      total: phase1B.value.sharedPlateModelsTotal,
    })),
    agentActions.registerStateSection("selection", () => ({
      ...phase1B.value.selection,
    })),
    agentActions.registerStateSection("ui", uiSnapshot),
  );
}

/** Only safe UI controls and progress; never form credentials or file contents. */
function uiSnapshot(): Record<string, unknown> {
  const styleLayer = filteredLayerRows.value.find((layer) => layer.id === selectedLayerId.value);
  return {
    accountMenuOpen: accountMenuVisible.value,
    activeSidebarTab: activeSidebarTab.value,
    activeModule: activeModule.value,
    selectedLayerId: selectedLayerId.value ?? null,
    layerSearch: layerSearch.value,
    layerStyleOpen: activeSidebarTab.value === "layers" && Boolean(styleLayer && layerIsVisible(styleLayer)),
    authDialogOpen: authDialogVisible.value,
    authMode: authMode.value,
    busy: authBusy.value || uploadBusy.value,
    authBusy: authBusy.value,
    uploadBusy: uploadBusy.value,
    toolbarCollapsed: toolbarCollapsed.value,
    uploadStep: uploadStep.value,
    uploadWizardOpen: uploadDialogVisible.value,
    uploadProgress: uploadProgress.value,
    uploadStage: uploadStage.value,
    // The registry applies the same redaction as all other state providers.
    uploadMessage: uploadMessage.value,
    uploadError: uploadError.value,
    uploadJobId: uploadJobId.value,
    pointLayerActionBusy: pointLayerActionBusy.value,
    pointLayerActionMessage: pointLayerActionMessage.value,
    pointLayerActionError: pointLayerActionError.value,
    projectReadOnly: projectReadOnly.value,
    projectStateReady: Boolean(projectState.value),
    projectActionBusy: projectActionBusy.value,
    projectActionError: projectActionError.value,
    addPanelOpen: addPanelOpen.value,
    addPanelKind: addPanelKind.value,
    welcomeOpen: welcomeOpen.value,
    consoleOpen: consoleOpen.value,
    consoleEntryCount: consoleSummary.value.entries,
    consolePendingCount: consoleSummary.value.pending,
    projectStatusOpen: projectDetailsOpen.value || projectReportOpen.value,
    toastVisible: toastVisible.value,
    sidebarVisible: sidebarVisible.value,
  };
}

/** Safe session summary: never contains the access token. */
function sessionSummary(): Record<string, unknown> {
  return {
    accountName: phase1B.value.account?.name ?? "",
    signedIn: Boolean(phase1B.value.account),
    status: phase1B.value.status,
    v2WorkspaceAvailable: phase1B.value.v2WorkspaceAvailable,
  };
}

onMounted(() => {
  // Default desktop shows the sidebar; a narrow first paint starts collapsed so
  // the map uses the available width instead of a 254px strip.
  if (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 1023px)").matches) {
    sidebarVisible.value = false;
  }
  unsubscribePhase1B = phase1BCloudClient.subscribe((state) => {
    phase1B.value = state;
    if (state.account && !authEmail.value) {
      authEmail.value = state.account.email;
    }
    agentActions.notifyStateChanged();
  });
  registerAgentActions();
  stopUiStateWatch = watch(uiSnapshot, () => agentActions.notifyStateChanged("ui"));
  void phase1BCloudClient.initialize();
  window.addEventListener("timemachine:project-saved", handleProjectSaved);
  window.addEventListener("timemachine:project-save-error", handleProjectSaveError);
  window.addEventListener("timemachine:auth-required", handleAuthRequired);
  window.addEventListener(LAYER_STATE_EVENT, handleLayerState);
  window.addEventListener(PROJECT_STATE_EVENT, handleProjectState);
});

onBeforeUnmount(() => {
  stopUiStateWatch?.();
  unsubscribeStateSections.forEach((unsubscribe) => unsubscribe());
  authPassword.value = "";
  authCode.value = "";
  unsubscribePhase1B?.();
  window.removeEventListener("timemachine:project-saved", handleProjectSaved);
  window.removeEventListener("timemachine:project-save-error", handleProjectSaveError);
  window.removeEventListener("timemachine:auth-required", handleAuthRequired);
  window.removeEventListener(LAYER_STATE_EVENT, handleLayerState);
  window.removeEventListener(PROJECT_STATE_EVENT, handleProjectState);
  window.clearTimeout(toastTimer);
});
</script>

<template>
  <div class="viewport">
    <DevelopmentConsole ref="consoleRef" :open="consoleOpen" @update:open="setConsoleVisible" />
    <WelcomePanel :open="welcomeOpen" @update:open="setWelcomeVisible" />
    <div class="stage" :data-sidebar-hidden="sidebarVisible ? undefined : 'true'">
      <header class="topbar tm-ui">
        <TooltipProvider :delay-duration="300">
          <p id="tm-future-note" class="visually-hidden">Not implemented in this build.</p>
          <Tooltip>
            <TooltipTrigger as-child>
              <Button
                variant="ghost"
                size="icon-sm"
                class="top-icon-button topbar__sidebar-toggle"
                :aria-label="sidebarVisible ? 'Hide the sidebar' : 'Show the sidebar'"
                :aria-expanded="sidebarVisible"
                aria-controls="tm-sidebar"
                data-action="ui.sidebar.setVisible"
                @click="setSidebarVisible(!sidebarVisible)"
              ><PanelLeft /></Button>
            </TooltipTrigger>
            <TooltipContent>{{ sidebarVisible ? "Hide the sidebar" : "Show the sidebar" }}</TooltipContent>
          </Tooltip>
          <button
            class="menu-button"
            type="button"
            aria-label="Main menu"
            aria-describedby="tm-future-note"
            title="Not implemented in this build"
            disabled
            data-action="ui.menu.toggle"
          >☰</button>
          <div class="brand" role="group" aria-label="Global Paleogeographic Collaboration Network">
            <span class="brand__seal">GPCN</span>
            <span class="brand__copy">Global Paleogeographic<br />Collaboration Network</span>
          </div>
          <div class="app-title">Time Machine</div>
          <Button
            variant="secondary"
            size="sm"
            class="top-action"
            :disabled="projectReadOnly || projectActionBusy || projectState?.localSave.status === 'saving'"
            data-action="project.saveLocal"
            @click="executeProjectAction(AGENT_ACTIONS.projectSaveLocal, {}, 'Local draft saved')"
          >Save locally</Button>
          <Button
            variant="default"
            size="sm"
            class="top-action"
            :disabled="projectReadOnly || !projectState?.compatibility.cloudWritable || projectActionBusy || projectState?.cloudSave.status === 'saving' || Boolean(phase1B.projectContextError)"
            data-action="project.save"
            @click="requestProjectSave"
          >
            <CloudUpload />
            <span>Save to Cloud</span>
          </Button>
          <Badge variant="outline" class="draft-pill" :data-state="projectState?.cloudSave.status ?? 'waiting'">
            {{ phase1B.projectContextError ? 'Cloud context error' : cloudSaveLabel }}
          </Badge>
          <input
            id="project-name"
            class="project-name"
            value="Untitled_6/5/2025 6:10:11 AM"
            aria-label="Project name"
            :disabled="projectReadOnly" data-action="project.setName"
          />
          <div class="topbar__spacer"></div>
          <DropdownMenu :open="accountMenuVisible" @update:open="setAccountMenuOpen">
            <DropdownMenuTrigger as-child>
              <button
                class="sign-in"
                type="button"
                :aria-expanded="accountMenuVisible"
                data-action="ui.accountMenu.toggle"
              >
                <span class="sign-in__avatar" aria-hidden="true"></span>
                <span>{{ phase1B.account?.name ?? "Not signed in" }}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="account-menu">
              <DropdownMenuLabel v-if="phase1B.account" class="account-menu__identity">
                <strong>{{ phase1B.account.name }}</strong>
                <small>{{ phase1B.account.email }}</small>
              </DropdownMenuLabel>
              <DropdownMenuSeparator v-if="phase1B.account" />
              <DropdownMenuItem data-action="catalog.refresh" @select="refreshCloudWorkspace">
                <RefreshCw />
                Refresh cloud
              </DropdownMenuItem>
              <DropdownMenuItem data-action="auth.logout" @select="logout">Sign out</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="outline"
            size="sm"
            class="top-action"
            disabled
            aria-describedby="tm-future-note"
            title="Not implemented in this build"
            data-action="publish.run"
          >
            <Upload />
            <span>Publish</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            class="top-action"
            disabled
            aria-describedby="tm-future-note"
            title="Not implemented in this build"
            data-action="export.run"
          >
            <Download />
            <span>Export</span>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            class="top-icon-button"
            aria-label="Notifications"
            aria-describedby="tm-future-note"
            title="Not implemented in this build"
            disabled
            data-action="ui.notifications.open"
          ><Bell /></Button>
          <Button
            variant="ghost"
            size="icon-sm"
            class="top-icon-button"
            aria-label="Settings"
            aria-describedby="tm-future-note"
            title="Not implemented in this build"
            disabled
            data-action="ui.settings.open"
          ><Settings /></Button>
          <Button
            variant="ghost"
            size="icon-sm"
            class="top-icon-button"
            aria-label="Information"
            aria-describedby="tm-future-note"
            title="Not implemented in this build"
            disabled
            data-action="ui.info.open"
          ><Info /></Button>
          <Tooltip>
            <TooltipTrigger as-child>
              <Button
                variant="ghost"
                size="icon-sm"
                class="top-icon-button"
                aria-label="Open the welcome panel"
                data-action="ui.welcome.setVisible"
                @click="setWelcomeVisible(true)"
              ><CircleHelp /></Button>
            </TooltipTrigger>
            <TooltipContent>Welcome panel</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </header>

      <details class="project-persistence tm-ui" aria-label="Project persistence" :open="projectReportOpen" @toggle="handleProjectStatusToggle" @keydown.esc.stop.prevent="closeProjectStatus">
        <summary>
          <span data-testid="local-save-status" :data-state="projectState?.localSave.status ?? 'checking'">{{ localSaveLabel }}</span>
          <span data-testid="cloud-save-status" :data-state="projectState?.cloudSave.status ?? 'waiting'">{{ cloudSaveLabel }}</span>
        </summary>
        <template v-if="projectState">
          <p v-if="projectState.localSave.savedAt">Last local save: {{ projectState.localSave.savedAt }} · revision {{ projectState.localSave.savedRevision }}</p>
          <p v-if="projectState.cloudSave.revisionNumber !== undefined">Cloud revision {{ projectState.cloudSave.revisionNumber }}</p>
          <p v-if="projectState.localSave.status === 'error'" data-testid="local-save-error" role="alert">{{ redactErrorMessage(projectState.localSave.message ?? 'The local draft was not saved.') }}</p>
          <p v-if="projectState.cloudSave.status === 'error'" data-testid="cloud-save-error" role="alert">{{ redactErrorMessage(projectState.cloudSave.message ?? 'The cloud revision was not saved.') }}</p>
          <p v-if="projectReadOnly" class="project-readonly-reason">Read-only project. Review the preserved input before making changes.</p>
          <p v-else-if="!projectState.compatibility.cloudWritable">Local editing is available. Cloud saving is disabled until the preserved fields have a compatible mapping.</p>
          <p v-if="projectState.compatibility.issues.length">Compatibility: {{ projectState.compatibility.source }} · schema {{ projectState.compatibility.schemaVersion ?? 'unrecognized' }}</p>
          <ul v-if="projectState.compatibility.issues.length" data-testid="project-compatibility-issues">
            <li v-for="(issue, index) in projectState.compatibility.issues" :key="`${issue.path}:${issue.code}:${index}`">
              <strong>{{ issue.code }}</strong> · {{ redactErrorMessage(issue.path) }}: {{ redactErrorMessage(issue.message) }}
              <span>{{ issue.preserved ? 'Original preserved' : 'See issue details' }}</span>
            </li>
          </ul>
          <Button v-if="projectState.originalAvailable" variant="outline" size="xs" :disabled="projectActionBusy" data-action="project.exportOriginal" data-source="current"
            @click="executeProjectAction(AGENT_ACTIONS.projectExportOriginal, {}, 'Original input download started')">Download original</Button>
          <section v-if="projectState.review" class="project-review" aria-label="Cloud project awaiting review">
            <h3>Cloud project awaiting review</h3>
            <p><strong>{{ redactErrorMessage(projectState.review.name) }}</strong> · schema {{ projectState.review.compatibility.schemaVersion ?? 'unrecognized' }}</p>
            <p>The cloud input was retained for review. Your current project remains active.</p>
            <ul>
              <li v-for="(issue, index) in projectState.review.compatibility.issues" :key="`${issue.path}:${issue.code}:${index}`">
                <strong>{{ issue.code }}</strong> · {{ redactErrorMessage(issue.path) }}: {{ redactErrorMessage(issue.message) }}
                <span>{{ issue.preserved ? 'Original preserved' : 'See issue details' }}</span>
              </li>
            </ul>
            <Button v-if="projectState.review.originalAvailable" variant="outline" size="xs" :disabled="projectActionBusy" data-action="project.exportOriginal" data-source="review"
              @click="executeProjectAction(AGENT_ACTIONS.projectExportOriginal, { source: 'review' }, 'Reviewed original download started')">Download reviewed original</Button>
          </section>
        </template>
        <p v-if="phase1B.projectContextError" data-testid="project-context-error" role="alert">{{ redactErrorMessage(phase1B.projectContextError) }}</p>
        <p v-if="projectActionError" data-testid="project-action-error" role="alert">{{ projectActionError }}</p>
      </details>

      <aside id="tm-sidebar" class="sidebar tm-ui" :inert="!sidebarVisible" :aria-hidden="sidebarVisible ? undefined : 'true'">
        <Tabs :model-value="activeSidebarTab" @update:model-value="selectSidebarTab" class="sidebar-tabs-wrap">
          <TabsList class="sidebar-tabs" aria-label="Data views">
            <TabsTrigger value="layers" class="sidebar-tab" data-action="ui.sidebar.select">Layer</TabsTrigger>
            <TabsTrigger value="plate-models" class="sidebar-tab" data-action="ui.sidebar.select">Plate Model</TabsTrigger>
          </TabsList>
        </Tabs>

        <div class="layer-search">
          <Search class="layer-search__icon" aria-hidden="true" />
          <Input
            v-model="layerSearch"
            type="search"
            autocomplete="off"
            aria-label="Search layers"
            placeholder="Filter layers"
            class="layer-search__input"
            data-action="ui.layerSearch.set"
          />
        </div>

        <div class="sidebar-actions">
          <Button variant="secondary" size="sm" :disabled="projectReadOnly" data-action="upload.open" @click="showUploadWizard">
            <Upload /><span>Upload to Layer</span>
          </Button>
          <Button variant="outline" size="sm" data-action="ui.layerStyle.open" @click="showLayerStyle()">
            <SlidersHorizontal /><span>Layer Style</span>
          </Button>
        </div>

        <section v-show="activeSidebarTab === 'layers'" class="layer-list" aria-label="Layers">
          <Collapsible :open="addPanelOpen" @update:open="setAddPanelVisible">
            <div class="sidebar-add">
              <CollapsibleTrigger as-child>
                <Button
                  variant="default"
                  size="sm"
                  class="sidebar-add__trigger"
                  aria-controls="add-layer-panel"
                  data-action="ui.addPanel.setVisible"
                >
                  <Plus />
                  <span>Add layer / group</span>
                </Button>
              </CollapsibleTrigger>
            </div>
            <CollapsibleContent force-mount>
              <AddLayerPanel
            :open="addPanelOpen"
            :kind="addPanelKind"
            v-model:groupName="newGroupName"
            v-model:groupParent="newGroupParent"
            v-model:pointName="newPointLayerName"
            v-model:pointGroup="newPointLayerGroup"
            v-model:lineName="newLineLayerName"
            v-model:lineGroup="newLineLayerGroup"
            v-model:polygonName="newPolygonLayerName"
            v-model:polygonGroup="newPolygonLayerGroup"
            v-model:rasterName="newRasterLayerName"
            v-model:rasterGroup="newRasterLayerGroup"
            v-model:rasterSelection="newRasterLayerSelection"
            v-model:atlasName="newAtlasLayerName"
            v-model:atlasGroup="newAtlasLayerGroup"
            :read-only="projectReadOnly"
            :group-busy="groupActionBusy"
            :layer-busy="pointLayerActionBusy"
            :groups="addPanelGroups"
            :raster-options="rasterOptions"
            :atlas-available="atlasSourceAvailable"
            :atlas-label="atlasSource?.label ?? ''"
            :point-source-ref="pointFixtureSourceRef"
            :line-source-ref="lineFixtureSourceRef"
            :polygon-source-ref="polygonFixtureSourceRef"
            :raster-source-ref="rasterManifestSourceRef"
            @update:open="setAddPanelVisible"
            @update:kind="setAddPanelKind"
            @add-group="addLayerGroup"
            @add-point="addPointLayer"
            @add-line="addLineLayer"
            @add-polygon="addPolygonLayer"
            @add-raster="addRasterLayer"
            @add-atlas="addAtlasLayer"
            @close="closeAddPanel"
              />
            </CollapsibleContent>
          </Collapsible>
          <!-- Persistent feedback: the panel may be closed, these errors and
               statuses must stay visible to the user. -->
          <p v-if="groupActionError" class="layer-group-error" role="alert">{{ groupActionError }}</p>
          <p v-if="pointLayerActionMessage" class="point-layer-action-message" role="status">{{ pointLayerActionMessage }}</p>
          <p v-if="pointLayerActionError" class="point-layer-action-error" role="alert">{{ pointLayerActionError }}</p>
          <!-- One key space preserves main.ts native bindings when a layer changes groups. -->
          <template v-for="{ key, group, layer } in layerTreeRows" :key="key">
            <template v-if="!layer">
            <div
              v-show="visibleGroupIds.has(group.id)"
              class="layer-group-row"
              :class="{ 'is-drop-target': dropTargetLayerId === -group.id }"
              :data-group-id="group.id"
              :data-depth="groupDepth(group.id)"
              :style="{ marginLeft: `${groupDepth(group.id) * 12}px` }"
              @dragenter.prevent="dropTargetLayerId = -group.id"
              @dragover.prevent
              @drop.prevent="dropLayerIntoGroup(group.id)"
            >
              <Button
                variant="ghost"
                size="icon-xs"
                class="layer-group-row__collapse"
                :aria-label="`${group.collapsed && !layerQuery ? 'Expand' : 'Collapse'} ${group.name}`"
                :aria-expanded="!group.collapsed || Boolean(layerQuery)"
                :disabled="projectReadOnly || (Boolean(layerQuery))"
                :title="layerQuery ? 'Clear the search to change group collapse' : undefined"
                data-action="layer.group.setCollapsed"
                @click="toggleGroup(group)"
              >
                <ChevronRight v-if="group.collapsed && !layerQuery" />
                <ChevronDown v-else />
              </Button>
              <input
                type="checkbox"
                :checked="group.active"
                :aria-label="`${group.name} visibility`"
                :disabled="projectReadOnly" data-action="layer.group.setVisibility"
                @change="changeGroupVisibility(group, $event)"
              />
              <strong>{{ group.name }}</strong>
              <small>{{ matchingLayerCount(group.id) }}</small>
              <input
                class="layer-group-opacity"
                type="range"
                min="0"
                max="100"
                step="1"
                :value="Math.round(group.alpha * 100)"
                :aria-label="`${group.name} opacity`"
                :disabled="projectReadOnly" data-action="layer.group.setOpacity"
                @input="changeGroupOpacity(group, $event)"
              />
              <output>{{ Math.round(group.alpha * 100) }}%</output>
            </div>
            <div
              v-show="visibleGroupIds.has(group.id)"
              class="layer-group-controls"
              :data-group-controls="group.id"
              :style="{ marginLeft: `${groupDepth(group.id) * 12}px` }"
            >
              <label>
                <span>Parent</span>
                <select
                  class="tm-select"
                  :aria-label="`Move ${group.name} to group`"
                  :value="String(group.parentId ?? '')"
                  :disabled="projectReadOnly || groupActionBusy"
                  data-action="layer.group.move"
                  @change="moveLayerGroup(group.id, $event)"
                >
                  <option value="">Root</option>
                  <option v-for="parent in groupParentOptions(group.id)" :key="parent.id" :value="String(parent.id)">
                    {{ "— ".repeat(groupDepth(parent.id)) + parent.name }}
                  </option>
                </select>
              </label>
              <Button
                variant="ghost"
                size="xs"
                class="layer-group-controls__remove"
                :aria-label="`Delete ${group.name} group`"
                :aria-describedby="groupIsNonempty(group.id) ? `group-remove-reason-${group.id}` : undefined"
                :disabled="projectReadOnly || groupActionBusy || groupIsNonempty(group.id)"
                data-action="layer.group.remove"
                @click="executeGroupAction(AGENT_ACTIONS.layerGroupRemove, { groupId: group.id })"
              >
                <Trash2 />
                <span>Delete</span>
              </Button>
              <small v-if="groupIsNonempty(group.id)" :id="`group-remove-reason-${group.id}`">Contains layers or child groups</small>
            </div>
            </template>
          <article
            v-else
            v-show="layerIsVisible(layer)"
            class="layer-row"
            :style="{ marginLeft: `${groupDepth(group.id) * 12}px` }"
            :class="{
              'is-selected': selectedLayerId === layer.id,
              'is-dragging': draggedLayerId === layer.id,
              'is-drop-target': dropTargetLayerId === layer.id,
              'has-options': selectedLayerId === layer.id,
            }"
            :draggable="!projectReadOnly && !layerSearch"
            :data-layer-id="layer.id"
            data-action="ui.layerStyle.open"
            @click="showLayerStyle(layer.id)"
            @dragstart="beginLayerDrag($event, layer.id)"
            @dragenter.prevent="dropTargetLayerId = layer.id"
            @dragover.prevent
            @drop.prevent="dropLayer(layer.id)"
            @dragend="finishLayerDrag"
          >
            <input
              :id="layerVisibilityId(layer.id)"
              type="checkbox"
              :checked="layer.active"
              :aria-label="`${layer.name} visibility`"
              :disabled="projectReadOnly" data-action="layer.setVisibility"
              @click.stop
              @change="changeLayerVisibility(layer, $event)"
            />
            <span
              class="layer-swatch"
              :class="layerSwatchClass(layer)"
              aria-hidden="true"
            ></span>
            <span class="layer-copy">
              <strong>{{ layer.name }}</strong>
              <small v-if="!isSupportedLayerType(layer)" class="unsupported-layer-status">Unsupported layer type {{ layer.type }} · preserved for compatibility review</small>
              <small v-else-if="layer.id === RUNTIME_LAYER_IDS.atlas">
                <span id="atlas-frame-value">—</span> ·
                <span id="atlas-status">Loading atlas…</span>
              </small>
              <small v-else-if="layer.id === RUNTIME_LAYER_IDS.points">
                <span id="point-state-chip">Preparing</span> · GPU point runtime
              </small>
              <small v-else-if="layer.id === RUNTIME_LAYER_IDS.raster">
                <span id="single-raster-state">Preparing</span>
              </small>
              <small v-else-if="layer.type === ProjectLayerType.Point" class="ordinary-point-status">
                Present-day points · {{ layer.runtimeStatus ?? "Status unavailable" }}
                <span v-if="layer.runtimeError" class="ordinary-point-error" role="alert">{{ redactErrorMessage(layer.runtimeError) }}</span>
              </small>
              <small v-else-if="isOrdinaryLineLayer(layer)" class="ordinary-line-status">
                Source-coordinate lines · not reconstructed · {{ layer.runtimeStatus ?? "Status unavailable" }}
                <span v-if="layer.runtimeError" class="ordinary-point-error" role="alert">{{ redactErrorMessage(layer.runtimeError) }}</span>
              </small>
              <small v-else-if="isOrdinaryPolygonLayer(layer)" class="ordinary-polygon-status">
                Source-coordinate polygons · not reconstructed · {{ layer.runtimeStatus ?? "Status unavailable" }}
                <span v-if="layer.runtimeError" class="ordinary-point-error" role="alert">{{ redactErrorMessage(layer.runtimeError) }}</span>
              </small>
              <small v-else-if="isOrdinaryRasterLayer(layer)" class="ordinary-raster-status">
                Raster imagery · {{ layer.runtimeStatus ?? "Status unavailable" }}
                <span v-if="layer.runtimeError" class="ordinary-point-error" role="alert">{{ redactErrorMessage(layer.runtimeError) }}</span>
              </small>
              <small v-else-if="isOrdinaryAtlasLayer(layer)" class="ordinary-atlas-status">
                Atlas imagery · {{ layer.runtimeStatus === "removing" || layer.runtimeStatus === "error" ? layer.runtimeStatus : layer.atlasState?.status ?? layer.runtimeStatus ?? "Status unavailable" }}
                <template v-if="layer.atlasState">
                  <span class="atlas-requested-age"> · Requested: {{ layer.atlasState.requestedAgeMa }} Ma</span>
                  <span v-if="layer.atlasState.status === 'hidden'" class="atlas-hidden-reason"> · {{ layer.atlasState.reason }}</span>
                  <span v-if="layer.atlasState.frame" class="atlas-target-frame"> · Target frame: {{ layer.atlasState.frame.timeMa }} Ma ({{ layer.atlasState.frame.label }})</span>
                  <span class="atlas-committed-frame"> · Last committed frame: {{ layer.atlasState.committedFrame ? `${layer.atlasState.committedFrame.timeMa} Ma (${layer.atlasState.committedFrame.label})` : "none" }}</span>
                </template>
                <span v-if="layer.runtimeError" class="ordinary-point-error" role="alert">{{ redactErrorMessage(layer.runtimeError) }}</span>
              </small>
              <small v-else>PALEOMAP finite rotations</small>
            </span>
            <span
              v-if="layer.id === RUNTIME_LAYER_IDS.points"
              class="layer-inline-actions"
            >
              <Button variant="outline" size="icon-xs" as-child>
                <button
                  id="load-points"
                  type="button"
                  disabled
                  aria-label="Load points"
                  data-action="points.load"
                  @click.stop
                >
                  ▶
                </button>
              </Button>
              <Button variant="outline" size="icon-xs" as-child>
                <button
                  id="unload-points"
                  type="button"
                  disabled
                  aria-label="Unload points"
                  data-action="points.unload"
                  @click.stop
                >
                  ×
                </button>
              </Button>
            </span>
            <span v-else-if="isOrdinaryPointLayer(layer) || isOrdinaryLineLayer(layer) || isOrdinaryPolygonLayer(layer) || isOrdinaryRasterLayer(layer) || isOrdinaryAtlasLayer(layer)" class="layer-inline-actions">
              <Button
                variant="ghost"
                size="icon-xs"
                :aria-label="`${layer.name} options`"
                data-action="ui.layerStyle.open"
                @click.stop="toggleLayerStyle(layer.id)"
              ><MoreHorizontal /></Button>
              <Button
                variant="ghost"
                size="icon-xs"
                :aria-label="`Remove ${layer.name} layer`"
                :disabled="projectReadOnly || pointLayerActionBusy || layer.runtimeStatus === 'removing'"
                data-action="layer.remove"
                @click.stop="removePointLayer(layer)"
              ><X /></Button>
            </span>
            <Button
              v-else
              variant="ghost"
              size="icon-xs"
              :aria-label="`${layer.name} options`"
              data-action="ui.layerStyle.open"
              @click.stop="toggleLayerStyle(layer.id)"
            ><MoreHorizontal /></Button>
            <Button
              v-if="canRetryLayer(layer)"
              variant="outline"
              size="xs"
              class="layer-retry"
              :aria-label="`Retry ${layer.name} layer`"
              :disabled="projectReadOnly || pointLayerActionBusy"
              data-action="layer.retry"
              @click.stop="retryLayer(layer)"
            >
              <RotateCcw />
              <span>Retry {{ layer.name }} layer</span>
            </Button>
            <div
              v-show="selectedLayerId === layer.id"
              class="layer-style-inline"
              @click.stop
            >
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Close layer style"
                data-action="ui.layerStyle.close"
                @click.stop="closeLayerStyle"
              ><X /></Button>
              <span>Opacity</span>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                :value="Math.round(layer.alpha * 100)"
                :aria-label="`${layer.name} opacity`"
                :disabled="projectReadOnly" data-action="layer.setOpacity"
                @input="changeLayerOpacity(layer, $event)"
              />
              <output>{{ Math.round(layer.alpha * 100) }}%</output>
              <div v-if="isOrdinaryRasterLayer(layer)" class="ordinary-point-style-controls ordinary-raster-controls">
                <label>
                  <span>Raster</span>
                  <select :aria-label="`${layer.name} raster source`" :value="selectedRasterId(layer)"
                    :disabled="projectReadOnly || pointLayerActionBusy || layer.runtimeStatus === 'removing' || rasterOptions.length === 0"
                    data-action="raster.select" @change="changeRasterSelection(layer, $event)">
                    <option v-if="!availableRasterIds.has(selectedRasterId(layer))" :value="selectedRasterId(layer)" disabled>Unavailable raster selection</option>
                    <option v-for="option in rasterOptions" :key="option.id" :value="option.id">{{ option.label }}</option>
                  </select>
                </label>
                <p v-if="rasterSelectionError(layer)" class="ordinary-point-style-error ordinary-raster-error" role="alert">{{ rasterSelectionError(layer) }}</p>
              </div>
              <div v-if="isOrdinaryPointLayer(layer)" class="ordinary-point-style-controls">
                <template v-if="nativePointStyles.get(layer.id)?.style">
                  <label>
                    <span>Color</span>
                    <input type="color" :aria-label="`${layer.name} point color`"
                      :value="nativePointStyles.get(layer.id)?.style?.singleColor"
                      :disabled="projectReadOnly || pointLayerActionBusy" data-action="layer.setStyle" data-native-point-style="color"
                      @change="changeNativePointStyle(layer, 'singleColor', $event)" />
                  </label>
                  <label>
                    <span>Size (px)</span>
                    <input type="number" :aria-label="`${layer.name} point size`" step="0.1"
                      :min="POINT_SIZE_MIN_PIXELS" :max="POINT_SIZE_MAX_PIXELS"
                      :value="nativePointStyles.get(layer.id)?.style?.pointSize"
                      :disabled="projectReadOnly || pointLayerActionBusy" data-action="layer.setStyle" data-native-point-style="size"
                      @change="changeNativePointStyle(layer, 'pointSize', $event)" />
                  </label>
                </template>
                <p v-else class="ordinary-point-style-error" role="alert">{{ nativePointStyles.get(layer.id)?.error }}</p>
              </div>
              <div v-if="isOrdinaryLineLayer(layer)" class="ordinary-point-style-controls ordinary-line-style-controls">
                <template v-if="nativeLineStyles.get(layer.id)?.style">
                  <label>
                    <span>Line color</span>
                    <input type="color" :aria-label="`${layer.name} line color`"
                      :value="nativeLineStyles.get(layer.id)?.style?.lineColor"
                      :disabled="projectReadOnly || pointLayerActionBusy" data-action="layer.setStyle" data-native-line-style="color"
                      @change="changeNativeLineStyle(layer, 'lineColor', $event)" />
                  </label>
                  <label>
                    <span>Width (px)</span>
                    <input type="number" :aria-label="`${layer.name} line width`" step="0.1"
                      :min="NATIVE_LINE_WIDTH_MIN" :max="NATIVE_LINE_WIDTH_MAX"
                      :value="nativeLineStyles.get(layer.id)?.style?.lineWidth"
                      :disabled="projectReadOnly || pointLayerActionBusy" data-action="layer.setStyle" data-native-line-style="width"
                      @change="changeNativeLineStyle(layer, 'lineWidth', $event)" />
                  </label>
                </template>
                <p v-else class="ordinary-point-style-error ordinary-line-style-error" role="alert">{{ nativeLineStyles.get(layer.id)?.error }}</p>
              </div>
              <div v-if="isOrdinaryPolygonLayer(layer)" class="ordinary-point-style-controls ordinary-polygon-style-controls">
                <template v-if="nativePolygonStyles.get(layer.id)?.style">
                  <label>
                    <span>Fill color</span>
                    <input type="color" :aria-label="`${layer.name} fill color`"
                      :value="nativePolygonStyles.get(layer.id)?.style?.fillColor"
                      :disabled="projectReadOnly || pointLayerActionBusy" data-action="layer.setStyle" data-native-polygon-style="fill"
                      @change="changeNativePolygonStyle(layer, 'fillColor', $event)" />
                  </label>
                  <label>
                    <span>Outline color</span>
                    <input type="color" :aria-label="`${layer.name} outline color`"
                      :value="nativePolygonStyles.get(layer.id)?.style?.outlineColor"
                      :disabled="projectReadOnly || pointLayerActionBusy" data-action="layer.setStyle" data-native-polygon-style="outline"
                      @change="changeNativePolygonStyle(layer, 'outlineColor', $event)" />
                  </label>
                  <label>
                    <span>Outline width (px)</span>
                    <input type="number" :aria-label="`${layer.name} outline width`" step="0.1"
                      :min="NATIVE_POLYGON_OUTLINE_WIDTH_MIN" :max="NATIVE_POLYGON_OUTLINE_WIDTH_MAX"
                      :value="nativePolygonStyles.get(layer.id)?.style?.outlineWidth"
                      :disabled="projectReadOnly || pointLayerActionBusy" data-action="layer.setStyle" data-native-polygon-style="width"
                      @change="changeNativePolygonStyle(layer, 'outlineWidth', $event)" />
                  </label>
                </template>
                <p v-else class="ordinary-point-style-error ordinary-polygon-style-error" role="alert">{{ nativePolygonStyles.get(layer.id)?.error }}</p>
              </div>
              <div
                v-if="layer.id === RUNTIME_LAYER_IDS.points"
                class="point-performance-lab"
              >
                <label>
                  <span>Benchmark dataset</span>
                  <select id="point-dataset-select" disabled data-action="points.selectDataset">
                    <option>Loading datasets…</option>
                  </select>
                </label>
                <p id="point-status">Preparing point runtime…</p>
                <dl>
                  <div><dt>Points</dt><dd id="point-count">—</dd></div>
                  <div><dt>Resident</dt><dd id="visible-point-count">—</dd></div>
                  <div><dt>File / GPU</dt><dd id="point-memory">—</dd></div>
                  <div><dt>Fetch / upload</dt><dd id="point-load-time">—</dd></div>
                  <div><dt>FPS</dt><dd id="point-fps">—</dd></div>
                  <div><dt>P95 frame</dt><dd id="point-frame-p95">—</dd></div>
                  <div><dt>Input latency</dt><dd id="point-latency">—</dd></div>
                  <div><dt>JS heap</dt><dd id="point-js-heap">—</dd></div>
                </dl>
              </div>
              <div
                v-if="
                  layer.id === RUNTIME_LAYER_IDS.points &&
                  layer.pointStyle
                "
                class="point-style-controls"
              >
                <label>
                  <span>Color</span>
                  <select
                    :value="layer.pointStyle.colorMode"
                    :disabled="projectReadOnly" data-action="points.setStyle"
                    @change="changePointStyleField(layer, 'colorMode', $event)"
                  >
                    <option value="plate">Plate ID</option>
                    <option value="occurrence">Occurrences</option>
                    <option value="single">Single</option>
                  </select>
                </label>
                <label v-if="layer.pointStyle.colorMode === 'single'">
                  <span>Value</span>
                  <input
                    type="color"
                    :value="layer.pointStyle.singleColor"
                    :disabled="projectReadOnly" data-action="points.setStyle"
                    @input="changePointStyleField(layer, 'singleColor', $event)"
                  />
                </label>
                <label>
                  <span>Size</span>
                  <select
                    :value="layer.pointStyle.sizeMode"
                    :disabled="projectReadOnly" data-action="points.setStyle"
                    @change="changePointStyleField(layer, 'sizeMode', $event)"
                  >
                    <option value="fixed">Fixed</option>
                    <option value="occurrence">Occurrences</option>
                  </select>
                </label>
                <label>
                  <span>Pixels</span>
                  <input
                    type="number"
                    min="0.5"
                    max="8"
                    step="0.1"
                    :value="layer.pointStyle.pointSize"
                    :disabled="projectReadOnly" data-action="points.setStyle"
                    @input="changePointStyleField(layer, 'pointSize', $event)"
                  />
                </label>
                <label>
                  <span>Shape</span>
                  <select
                    :value="layer.pointStyle.shape"
                    :disabled="projectReadOnly" data-action="points.setStyle"
                    @change="changePointStyleField(layer, 'shape', $event)"
                  >
                    <option value="circle">Circle</option>
                    <option value="square">Square</option>
                  </select>
                </label>
                <label>
                  <span>Plate</span>
                  <input
                    type="number"
                    min="0"
                    max="65535"
                    placeholder="All"
                    :value="layer.pointStyle.filter.plateId ?? ''"
                    :disabled="projectReadOnly" data-action="points.setStyle"
                    @input="changePointFilter(layer, 'plateId', $event)"
                  />
                </label>
                <label>
                  <span>Occ. min</span>
                  <input
                    type="number"
                    min="0"
                    max="65535"
                    :value="layer.pointStyle.filter.minimumOccurrence"
                    :disabled="projectReadOnly" data-action="points.setStyle"
                    @input="changePointFilter(layer, 'minimumOccurrence', $event)"
                  />
                </label>
                <label>
                  <span>Occ. max</span>
                  <input
                    type="number"
                    min="0"
                    max="65535"
                    :value="layer.pointStyle.filter.maximumOccurrence"
                    :disabled="projectReadOnly" data-action="points.setStyle"
                    @input="changePointFilter(layer, 'maximumOccurrence', $event)"
                  />
                </label>
              </div>
            </div>
          </article>
          </template>
          <p v-if="filteredLayerRows.length === 0 && visibleGroupIds.size === 0" class="layer-empty">
            <span>No matching layers</span>
            <Button variant="outline" size="xs" data-action="ui.addPanel.setVisible" @click="toggleAddPanel">
              <Plus />
              <span>Add layer</span>
            </Button>
          </p>
        </section>

        <ScrollArea v-show="activeSidebarTab === 'plate-models'" class="plate-model-list" aria-label="Plate models">
          <Separator class="catalog-separator" />
          <div class="catalog-heading catalog-heading--first">
            <strong>Shared plate models</strong>
            <Button
              variant="ghost"
              size="icon-xs"
              :disabled="phase1B.sharedPlateModelsStatus === 'loading' || !phase1B.serverUrl"
              aria-label="Refresh shared plate models"
              data-action="catalog.refresh"
              @click="refreshCloudWorkspace"
            ><RefreshCw /></Button>
          </div>

          <p class="catalog-source">
            Server 来源：
            <code v-if="phase1B.serverUrl">{{ phase1B.serverUrl }}</code>
            <span v-else>未配置（VITE_TIMEMACHINE_SERVER_URL）</span>
          </p>
          <p v-if="phase1B.sharedPlateModelsStatus === 'loading'" class="catalog-status">
            正在读取共享板块模型目录…
          </p>
          <p
            v-else-if="phase1B.sharedPlateModelsStatus === 'error'"
            class="catalog-status catalog-status--error"
            data-testid="shared-catalog-error"
          >
            目录读取失败：{{ phase1B.sharedPlateModelsError }}
          </p>
          <p
            v-else-if="phase1B.sharedPlateModels.length === 0"
            class="catalog-status"
            data-testid="shared-catalog-empty"
          >
            {{
              phase1B.account
                ? `Server 返回空目录（Total ${phase1B.sharedPlateModelsTotal}）。私有模型需要对应账号才能看到。`
                : "未登录，仅显示公开目录；当前 Server 公开目录为空。登录后可查看自己的模型。"
            }}
          </p>

          <article
            v-for="item in phase1B.sharedPlateModels"
            :key="`shared-plate-${foreignKeyValue(item.ID)}`"
            class="plate-card"
            :class="{
              'is-active': phase1B.selection.plateModelId === foreignKeyValue(item.ID),
            }"
          >
            <span class="plate-card__icon">◎</span>
            <span>
              <strong>{{ item.Name || '(未命名)' }}</strong>
              <small>
                ID {{ foreignKeyValue(item.ID) }} ·
                {{ accessRangeLabel(foreignKeyValue(item.AccessRange)) }}
                <template v-if="isMineSharedPlateModel(foreignKeyValue(item.ID))"> · 本人</template>
                · {{ item.AgeStart }}–{{ item.AgeEnd }} Ma
              </small>
            </span>
            <Button
              variant="outline"
              size="xs"
              :disabled="projectReadOnly" data-action="model.select"
              @click="selectSharedPlateModel(foreignKeyValue(item.ID))"
            >Use</Button>
          </article>

          <div class="catalog-heading">
            <strong>本地演示数据</strong>
          </div>
          <article
            class="plate-card"
            :class="{ 'is-active': phase1B.selection.useLocalPlateModelDemo }"
          >
            <span class="plate-card__icon">◎</span>
            <span>
              <strong>PALEOMAP</strong>
              <small>本地内置演示数据 · 非 Server 公有资源 · 需显式选择</small>
            </span>
            <Button
              variant="outline"
              size="xs"
              :disabled="projectReadOnly || (phase1B.selection.useLocalPlateModelDemo)"
              data-action="model.select"
              @click="selectLocalPlateModelDemo"
            >Use</Button>
          </article>
          <article class="plate-card dataset-card">
            <span class="plate-card__icon">≋</span>
            <span>
              <strong>PBDB point datasets</strong>
              <small>本地 WGP1 实验数据 · 非 Server 公有资源</small>
            </span>
            <b v-if="phase1B.selection.datasetVersionId === 0">✓</b>
          </article>

          <template v-if="phase1B.v2WorkspaceAvailable">
            <div class="catalog-heading">
              <strong>Versioned plate models</strong>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Refresh versioned catalog"
                data-action="catalog.refresh"
                @click="refreshCloudWorkspace"
              ><RefreshCw /></Button>
            </div>
            <article
              v-for="item in publicPlateModels"
              :key="`public-plate-${foreignKeyValue(item.Version.ID)}`"
              class="plate-card"
              :class="{
                'is-active':
                  phase1B.selection.plateModelVersionId ===
                  foreignKeyValue(item.Version.ID),
              }"
            >
              <span class="plate-card__icon">◎</span>
              <span>
                <strong>{{ item.Version.Name }}</strong>
                <small>v{{ item.Version.VersionNumber }} · {{ item.Version.AgeStartMa }}–{{ item.Version.AgeEndMa }} Ma</small>
              </span>
              <Button
                variant="outline"
                size="xs"
                :disabled="projectReadOnly" data-action="model.select"
                @click="selectPlateModel(foreignKeyValue(item.Version.ID))"
              >Use</Button>
            </article>
            <article
              v-for="item in publicDatasets"
              :key="`public-dataset-${foreignKeyValue(item.Version.ID)}`"
              class="plate-card dataset-card"
              :class="{
                'is-active':
                  phase1B.selection.datasetVersionId ===
                  foreignKeyValue(item.Version.ID),
              }"
            >
              <span class="plate-card__icon">≋</span>
              <span>
                <strong>{{ item.Version.Name }}</strong>
                <small>v{{ item.Version.VersionNumber }} · {{ item.Version.RowCount.toLocaleString() }} rows</small>
              </span>
              <Button
                variant="outline"
                size="xs"
                :disabled="projectReadOnly" data-action="dataset.select"
                @click="selectDataset(foreignKeyValue(item.Version.ID))"
              >Use</Button>
            </article>

            <template
              v-if="
                phase1B.account &&
                (privatePlateModels.length > 0 || privateDatasets.length > 0)
              "
            >
              <div class="catalog-heading">
                <strong>My resources</strong>
                <small>{{ privatePlateModels.length + privateDatasets.length }}</small>
              </div>
              <article
                v-for="item in privatePlateModels"
                :key="`private-plate-${foreignKeyValue(item.Version.ID)}`"
                class="plate-card"
                :class="{
                  'is-active':
                    phase1B.selection.plateModelVersionId ===
                    foreignKeyValue(item.Version.ID),
                }"
              >
                <span class="plate-card__icon">◎</span>
                <span>
                  <strong>{{ item.Version.Name }}</strong>
                  <small>Private · v{{ item.Version.VersionNumber }}</small>
                </span>
                <Button
                  variant="outline"
                  size="xs"
                  :disabled="projectReadOnly" data-action="model.select"
                  @click="selectPlateModel(foreignKeyValue(item.Version.ID))"
                >Use</Button>
              </article>
              <article
                v-for="item in privateDatasets"
                :key="`private-dataset-${foreignKeyValue(item.Version.ID)}`"
                class="plate-card dataset-card"
                :class="{
                  'is-active':
                    phase1B.selection.datasetVersionId ===
                    foreignKeyValue(item.Version.ID),
                }"
              >
                <span class="plate-card__icon">≋</span>
                <span>
                  <strong>{{ item.Version.Name }}</strong>
                  <small>Private · v{{ item.Version.VersionNumber }} · {{ item.Version.RowCount.toLocaleString() }} rows</small>
                </span>
                <Button
                  variant="outline"
                  size="xs"
                  :disabled="projectReadOnly" data-action="dataset.select"
                  @click="selectDataset(foreignKeyValue(item.Version.ID))"
                >Use</Button>
              </article>
            </template>

            <div v-if="phase1B.account" class="catalog-heading cloud-project-heading">
              <strong>Cloud projects</strong><small>{{ phase1B.projects.length }}</small>
            </div>
            <article
              v-for="project in phase1B.projects"
              :key="`project-${foreignKeyValue(project.Revision)}`"
              class="plate-card cloud-project-card"
            >
              <span class="plate-card__icon">▣</span>
              <span>
                <strong>{{ project.Name }}</strong>
                <small>Revision {{ project.RevisionNumber }} · {{ new Date(project.CreateTime).toLocaleDateString() }}</small>
              </span>
              <Button
                variant="outline"
                size="xs"
                :disabled="projectReadOnly" data-action="project.open"
                @click="openCloudProject(project)"
              >
                Open
              </Button>
            </article>
          </template>

          <p v-else class="catalog-status" data-testid="v2-unavailable">
            {{ phase1B.message || "TimeMachine V2 workspace endpoints are unavailable on this Server." }}
          </p>
        </ScrollArea>

        <div class="runtime-diagnostics" aria-hidden="true">
          <input
            id="point-size"
            type="range"
            value="2.2"
            min="0.5"
            max="8"
            step="any"
            :disabled="projectReadOnly" data-action="points.setSize"
          />
          <span id="point-size-value">2.2 px</span>

          <select id="single-raster-select" disabled data-action="raster.select">
            <option>Loading raster…</option>
          </select>
          <input
            id="single-raster-opacity"
            type="range"
            min="0"
            max="1"
            step="0.05"
            value="0.9"
            disabled
            data-action="layer.setOpacity"
          />
          <span id="single-raster-opacity-value">90%</span>
          <p id="single-raster-status"></p>
          <div id="single-raster-legend" hidden>
            <span id="single-raster-colorbar-name"></span>
            <span id="single-raster-colorbar-unit"></span>
            <i id="single-raster-gradient"></i>
            <span id="single-raster-minimum"></span>
            <span id="single-raster-maximum"></span>
          </div>
        </div>
      </aside>

      <main class="workspace" aria-label="3D globe workspace" data-action="feature.select">
        <div id="cesium-container"></div>
        <div class="canvas-vignette" aria-hidden="true"></div>

        <nav
          id="module-toolbar"
          class="module-toolbar tm-ui"
          :class="{ 'is-collapsed': toolbarCollapsed }"
          aria-label="Workspace modules"
        >
          <Button
            v-for="item in moduleItems"
            :key="item.label"
            v-show="!toolbarCollapsed"
            variant="ghost"
            class="module-button"
            :class="{ 'is-active': activeModule === item.label }"
            data-action="ui.module.select"
            @click="activeModule = item.label"
          >
            <component :is="item.icon" aria-hidden="true" />
            <span>{{ item.label }}</span>
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            class="toolbar-collapse"
            :aria-label="toolbarCollapsed ? 'Expand toolbar' : 'Collapse toolbar'"
            data-action="ui.toolbar.toggle"
            @click="toolbarCollapsed = !toolbarCollapsed"
          >
            <ChevronLeft v-if="!toolbarCollapsed" />
            <ChevronRight v-else />
          </Button>
        </nav>

        <div class="time-readout tm-ui"><strong id="age-value">0.0</strong> <span>Ma</span></div>
        <p id="era-label" class="era-label tm-ui">Present day</p>
        <div class="view-options tm-ui">
          <label class="view-options__future" aria-describedby="tm-future-note">
            <input type="checkbox" disabled data-action="ui.majorCities.setVisible" />
            <span>Major cities</span>
          </label>
          <Input
            class="place-search__input view-options__future"
            type="search"
            placeholder="Input a place name."
            aria-label="Search for a place"
            aria-describedby="tm-future-note"
            disabled
            data-action="ui.placeSearch"
          />
          <label class="projection-control" for="projection-select">
            <span class="projection-control__label">Projection</span>
            <select id="projection-select" class="tm-select" data-action="projection.select" disabled>
              <option value="globe">Globe (3D)</option>
              <option value="rectangle">Rectangle</option>
              <option value="mollweide">Mollweide</option>
            </select>
          </label>
          <p id="projection-status" class="projection-status" aria-live="polite"></p>
        </div>

        <Button variant="secondary" size="icon-sm" class="home-camera" as-child>
          <button
            id="home-camera"
            type="button"
            aria-label="Reset globe view"
            data-action="camera.reset"
          >
            <House aria-hidden="true" />
          </button>
        </Button>

        <section class="playback tm-ui" aria-label="Time playback controls">
          <div class="playback__grip" aria-hidden="true"></div>
          <div class="playback__row">
            <output class="time-box"><span id="playback-age-mirror">0.0</span></output>
            <span class="ma-label">Ma</span>
            <div class="transport">
              <Button variant="secondary" size="icon-sm" class="mini-button" as-child>
                <button
                  type="button"
                  data-age="100"
                  aria-label="Jump to 100 Ma"
                  :disabled="projectReadOnly" data-action="time.set"
                >
                  ◀
                </button>
              </Button>
              <Button variant="secondary" size="icon-sm" class="mini-button" as-child>
                <button
                  id="play-button"
                  type="button"
                  aria-label="Play geological time"
                  :disabled="projectReadOnly" data-action="time.setPlaying"
                >
                  <span class="play-icon" aria-hidden="true"></span>
                  <span data-play-label>Play</span>
                </button>
              </Button>
              <Button variant="secondary" size="icon-sm" class="mini-button" as-child>
                <button
                  type="button"
                  data-age="0"
                  aria-label="Jump to present"
                  :disabled="projectReadOnly" data-action="time.set"
                >
                  ▶
                </button>
              </Button>
            </div>
            <Button variant="outline" size="xs" class="mini-button" as-child>
              <button
                id="speed-button"
                type="button"
                :disabled="projectReadOnly" data-action="time.setSpeed"
              >
                25 Ma/s
              </button>
            </Button>
            <Button variant="outline" size="xs" class="mini-button" as-child>
              <button
                id="today-button"
                type="button"
                :disabled="projectReadOnly" data-action="time.set"
              >
                0
              </button>
            </Button>
          </div>
          <div class="playback__row playback__stats">
            <span>Plates <b id="active-plates">—</b></span>
            <span>Features <b id="active-features">—</b></span>
          </div>
        </section>

        <aside id="plate-inspector" class="plate-inspector tm-ui">
          <div id="inspector-empty">Click a feature to inspect</div>
          <div id="inspector-content" hidden>
            <strong id="selected-name">Plate</strong>
            <span id="selected-id">ID —</span>
            <span id="selected-validity">—</span>
            <span id="selected-state">—</span>
            <span id="selected-quaternion">—</span>
            <Button variant="outline" size="xs" class="inspector__clear" as-child>
              <button id="clear-feature-selection" type="button" data-action="feature.clear">Clear selection</button>
            </Button>
          </div>
        </aside>

        <div class="map-caption tm-ui">
          <span id="mesh-stat">Waiting for plate mesh</span>
          <span id="plate-model-status" class="plate-model-status"></span>
        </div>
      </main>

      <section class="timeline tm-ui" aria-label="Geological time scale">
        <div class="timeline__left-rail">
          <span class="timeline__max">{{ timelineMaximum }}</span>
          <span class="timeline__rail-knob">↔</span>
        </div>
        <div class="timeline__scale">
          <div
            v-for="row in timelineRows"
            :key="row.className"
            class="timeline-row"
            :class="row.className"
          >
            <span v-if="timelineMaximum > 538.8" class="segment timeline-range-extension"
              :style="timelineExtensionStyle(row.segments)" :title="`${timelineMaximum}–538.8 Ma`">{{ timelineMaximum }}–538.8 Ma</span>
            <span
              v-for="segment in row.segments"
              :key="`${row.className}-${segment.label}-${segment.weight}`"
              class="segment"
              :style="segmentStyle(segment)"
              :title="segment.label"
            >
              {{ segment.label }}
            </span>
          </div>
        </div>
        <div class="timeline__end-gutter" aria-hidden="true"></div>
        <div id="timeline-ticks" class="timeline-ticks" aria-hidden="true"></div>
        <div id="timeline-needle" class="timeline__marker" aria-hidden="true">
          <span class="timeline__bubble"><b id="timeline-age-mirror">0.0</b></span>
        </div>
        <input
          id="timeline-slider"
          class="timeline-slider"
          type="range"
          min="0"
          :max="timelineMaximum"
          value="0"
          step="0.1"
          aria-label="Geological age in Ma"
          :disabled="projectReadOnly" data-action="time.set"
        />
        <span class="timeline__zero">0.0</span>
        <div class="quick-ages" role="group" aria-label="Quick ages">
          <Button variant="ghost" size="icon-xs" class="quick-ages__button" as-child>
            <button type="button" data-age="32" :disabled="projectReadOnly" data-action="time.set">32</button>
          </Button>
          <Button variant="ghost" size="icon-xs" class="quick-ages__button" as-child>
            <button type="button" data-age="250" :disabled="projectReadOnly" data-action="time.set">250</button>
          </Button>
          <Button variant="ghost" size="icon-xs" class="quick-ages__button" as-child>
            <button type="button" :data-age="timelineMaximum" :disabled="projectReadOnly" data-action="time.set">{{ timelineMaximum }}</button>
          </Button>
        </div>
      </section>

      <div id="loading-overlay" class="loading-overlay">
        <div class="loading-card tm-ui">
          <span class="loading-spinner" aria-hidden="true"></span>
          <p>Preparing reconstruction</p>
          <h2 id="loading-title">Loading PALEOMAP data</h2>
          <p id="loading-detail">Parsing GPML polygons and finite rotations…</p>
          <div class="loading-track"><span id="loading-progress"></span></div>
        </div>
      </div>

      <div class="toast tm-ui" :class="{ 'is-visible': toastVisible }" role="status" aria-live="polite">
        {{ toastMessage }}
      </div>

      <Dialog :open="authDialogVisible" @update:open="setAuthDialogOpen">
        <DialogContent class="auth-dialog tm-ui" :show-close-button="false">
          <DialogHeader>
            <DialogTitle>Sign in to Time Machine</DialogTitle>
            <DialogDescription>
              使用 Server 既有 Unity 账号登录；密码只在本地折算成 Server 约定的摘要，不会保存或记录。
            </DialogDescription>
          </DialogHeader>
          <Tabs :model-value="authMode" @update:model-value="setAuthMode">
            <TabsList class="auth-mode-row" aria-label="Sign-in method">
              <TabsTrigger value="account" data-action="ui.authMode.set">账号密码</TabsTrigger>
              <TabsTrigger value="email-code" data-action="ui.authMode.set">邮箱验证码</TabsTrigger>
            </TabsList>

          <TabsContent value="account" force-mount class="auth-form">
            <Label class="auth-form__field">
              <span>账号</span>
              <Input
                v-model.trim="authAccount"
                type="text"
                autocomplete="username"
                placeholder="Unity 账号"
                data-action="auth.login"
              />
            </Label>
            <Label class="auth-form__field">
              <span>密码</span>
              <Input
                v-model="authPassword"
                type="password"
                autocomplete="current-password"
                placeholder="Server 账号密码"
                data-action="auth.login"
                @keyup.enter="signInWithPassword"
              />
            </Label>
            <Button
              class="auth-dialog__submit"
              type="button"
              data-testid="password-login"
              data-action="auth.login"
              :disabled="authBusy || !authAccount || !authPassword || !phase1B.serverUrl"
              @click="signInWithPassword"
            >
              {{ authBusy ? "Connecting…" : "Sign in" }}
            </Button>
          </TabsContent>

          <TabsContent value="email-code" force-mount class="auth-form">
            <Label class="auth-form__field">
              <span>Email</span>
              <Input
                v-model.trim="authEmail"
                type="email"
                autocomplete="email"
                placeholder="you@example.com"
                data-action="auth.sendCode"
              />
            </Label>
            <div class="auth-code-row">
              <Label class="auth-form__field">
                <span>Verification code</span>
                <Input
                  v-model.trim="authCode"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  placeholder="6-digit code"
                  data-action="auth.login"
                />
              </Label>
              <Button
                variant="outline"
                size="sm"
                :disabled="authBusy || !authEmail || !phase1B.serverUrl"
                data-action="auth.sendCode"
                @click="sendLoginCode"
              >Send code</Button>
            </div>
            <Button
              class="auth-dialog__submit"
              type="button"
              :disabled="authBusy || !authEmail || !authCode || !phase1B.serverUrl"
              data-action="auth.login"
              @click="signInWithEmailCode"
            >
              {{ authBusy ? "Connecting…" : "Sign in" }}
            </Button>
          </TabsContent>

          <p v-if="!phase1B.serverUrl" class="auth-dialog__config">
            {{ phase1B.message || "未配置 Server 地址（VITE_TIMEMACHINE_SERVER_URL）。" }}
          </p>
          <p v-else-if="phase1B.message" class="auth-dialog__config">
            {{ phase1B.message }}
          </p>
          <DialogFooter>
            <Button variant="ghost" size="sm" data-action="ui.authDialog.close" @click="setAuthDialogOpen(false)">Cancel</Button>
          </DialogFooter>
          </Tabs>
        </DialogContent>
      </Dialog>

      <Dialog :open="uploadDialogVisible" @update:open="handleUploadDialogOpen">
        <DialogContent class="upload-dialog tm-ui" :show-close-button="false">
          <DialogHeader>
            <DialogTitle>Upload point dataset</DialogTitle>
            <DialogDescription>
              CSV, TSV and TXT up to 256 MB. Content uploads straight to storage; nothing is read locally after the preview.
            </DialogDescription>
          </DialogHeader>
          <ol class="upload-steps" aria-label="Upload steps">
            <li :aria-current="uploadStep === 'select' ? 'step' : undefined">1 · File</li>
            <li :aria-current="uploadStep === 'map' ? 'step' : undefined">2 · Columns</li>
            <li :aria-current="uploadStep === 'run' ? 'step' : undefined">3 · Processing</li>
          </ol>

          <template v-if="uploadStep === 'select'">
            <p>CSV, TSV, or TXT up to 256 MB. Content uploads straight to storage.</p>
            <label>
              <span>Source file</span>
              <input
                type="file"
                accept=".csv,.tsv,.txt,text/csv"
                :disabled="projectReadOnly || (uploadBusy)"
                data-action="upload.run"
                @change="selectUploadFile"
              />
            </label>
          </template>

          <template v-else-if="uploadStep === 'map'">
            <p class="upload-file-line">
              <strong>{{ uploadFileName }}</strong>
              <small>{{ (uploadFileSize / (1024 * 1024)).toFixed(2) }} MB</small>
            </p>
            <label>
              <span>Dataset name</span>
              <input
                v-model.trim="uploadName"
                type="text"
                maxlength="128"
                :disabled="projectReadOnly" data-action="upload.run"
              />
            </label>
            <label>
              <span>Description</span>
              <input
                v-model.trim="uploadDescription"
                type="text"
                maxlength="1024"
                :disabled="projectReadOnly" data-action="upload.run"
              />
            </label>
            <label>
              <span>Plate model</span>
              <select v-model.number="uploadPlateModelId" :disabled="projectReadOnly" data-action="upload.run">
                <option v-if="ingestPlateModels.length === 0" :value="0">No plate model available</option>
                <option
                  v-for="model in ingestPlateModels"
                  :key="foreignKeyValue(model.PlateModel)"
                  :value="foreignKeyValue(model.PlateModel)"
                >{{ model.Name }}</option>
              </select>
            </label>
            <div class="upload-mapping">
              <label>
                <span>Longitude<em aria-hidden="true">*</em></span>
                <select v-model="uploadMapping.longitudeColumn" :disabled="projectReadOnly" data-action="upload.run">
                  <option value="">Not mapped</option>
                  <option v-for="header in uploadPreview?.headerList ?? []" :key="`lng-${header}`" :value="header">{{ header }}</option>
                </select>
              </label>
              <label>
                <span>Latitude<em aria-hidden="true">*</em></span>
                <select v-model="uploadMapping.latitudeColumn" :disabled="projectReadOnly" data-action="upload.run">
                  <option value="">Not mapped</option>
                  <option v-for="header in uploadPreview?.headerList ?? []" :key="`lat-${header}`" :value="header">{{ header }}</option>
                </select>
              </label>
              <label>
                <span>Age start (Ma)</span>
                <select v-model="uploadMapping.ageStartColumn" :disabled="projectReadOnly" data-action="upload.run">
                  <option value="">Permanent</option>
                  <option v-for="header in uploadPreview?.headerList ?? []" :key="`from-${header}`" :value="header">{{ header }}</option>
                </select>
              </label>
              <label>
                <span>Age end (Ma)</span>
                <select v-model="uploadMapping.ageEndColumn" :disabled="projectReadOnly" data-action="upload.run">
                  <option value="">Permanent</option>
                  <option v-for="header in uploadPreview?.headerList ?? []" :key="`to-${header}`" :value="header">{{ header }}</option>
                </select>
              </label>
              <label>
                <span>Occurrence</span>
                <select v-model="uploadMapping.occurrenceColumn" :disabled="projectReadOnly" data-action="upload.run">
                  <option value="">None</option>
                  <option v-for="header in uploadPreview?.headerList ?? []" :key="`occ-${header}`" :value="header">{{ header }}</option>
                </select>
              </label>
              <label>
                <span>Plate ID</span>
                <select v-model="uploadMapping.plateIdColumn" :disabled="projectReadOnly" data-action="upload.run">
                  <option value="">Assign from model</option>
                  <option v-for="header in uploadPreview?.headerList ?? []" :key="`plate-${header}`" :value="header">{{ header }}</option>
                </select>
              </label>
            </div>
            <div class="upload-preview" role="group" aria-label="Source preview">
              <table>
                <caption>
                  First {{ uploadPreview?.rowList.length ?? 0 }} rows
                  <span v-if="uploadPreview?.truncated">of a larger file</span>
                </caption>
                <thead>
                  <tr>
                    <th v-for="header in uploadPreview?.headerList ?? []" :key="`head-${header}`" scope="col">{{ header }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(row, rowIndex) in uploadPreview?.rowList ?? []" :key="`row-${rowIndex}`">
                    <td v-for="(cell, cellIndex) in row" :key="`cell-${rowIndex}-${cellIndex}`">{{ cell }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="upload-actions">
              <Button
                variant="outline"
                size="sm"
                :disabled="uploadBusy"
                data-action="ui.upload.back"
                @click="showUploadStep('select')"
              >
                Back
              </Button>
              <Button
                class="auth-dialog__submit"
                size="sm"
                type="button"
                :disabled="projectReadOnly || (uploadBusy || ingestPlateModels.length === 0)"
                data-action="upload.run"
                @click="startIngest()"
              >Start ingest</Button>
            </div>
          </template>

          <template v-else>
            <p class="upload-file-line"><strong>{{ uploadName }}</strong></p>
            <div
              class="upload-progress"
              role="progressbar"
              aria-label="Ingest progress"
              :aria-valuenow="Math.round(uploadProgress * 100)"
              aria-valuemin="0"
              aria-valuemax="100"
            >
              <span :style="{ width: `${Math.round(uploadProgress * 100)}%` }"></span>
            </div>
            <p aria-live="polite">{{ uploadMessage || "Working…" }}</p>
            <div class="upload-actions">
              <Button
                variant="destructive"
                size="sm"
                type="button"
                :disabled="!uploadBusy || uploadJobId <= 0"
                data-action="upload.cancel"
                @click="cancelIngest"
              >Cancel job</Button>
              <Button
                variant="outline"
                size="sm"
                type="button"
                :disabled="uploadBusy"
                data-action="ui.upload.back"
                @click="showUploadStep('map')"
              >
                Back
              </Button>
            </div>
          </template>

          <p v-if="uploadError" class="upload-error" role="alert">{{ uploadError }}</p>
          <DialogFooter>
            <Button variant="ghost" size="sm" data-action="upload.close" :disabled="uploadBusy" @click="dismissUploadWizard">Cancel upload</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  </div>
</template>

<style scoped>
/* Auth and upload dialogs: the shared DialogContent keeps its own fixed,
   centred box; these two classes only set the workbench width. */
.auth-dialog {
  width: min(400px, calc(100vw - 32px));
  max-width: min(400px, calc(100vw - 32px));
}
.upload-dialog {
  width: min(620px, calc(100vw - 32px));
  max-width: min(620px, calc(100vw - 32px));
  max-height: calc(100dvh - 64px);
  overflow-y: auto;
}

/* Project status disclosure: native <details>, token skin only.
   Closed it is a compact one-line status chip parked in the top-bar band (see
   the placements below), so it never sits on top of the Home button or the
   module toolbar; expanded it becomes a bounded, scrollable card. */
.project-persistence {
  position: absolute; top: 44px; right: 52px; z-index: 31;
  max-width: min(300px, calc(100% - 64px));
  color: var(--foreground);
  font-size: var(--tm-text-meta); line-height: var(--tm-line-meta); overflow-wrap: anywhere;
}
.project-persistence > summary {
  display: inline-flex; align-items: center; gap: 4px;
  max-width: 100%; min-height: 24px; padding: 0 10px;
  border: 1px solid var(--border); border-radius: 999px;
  background: var(--popover); box-shadow: 0 1px 4px rgb(16 24 32 / 10%);
  cursor: pointer; white-space: nowrap;
}
.project-persistence > summary:hover { background: var(--muted); }
.project-persistence > summary:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.project-persistence summary span {
  display: block; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.project-persistence summary span + span { padding-left: 6px; border-left: 1px solid var(--border); }
/* Expanded: the chip stays as the card header and the body scrolls. */
.project-persistence[open] {
  width: min(380px, calc(100% - 24px)); max-width: none;
  max-height: 44vh; overflow: auto;
  padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-lg);
  background: var(--popover); box-shadow: 0 4px 16px rgb(16 24 32 / 12%);
}
.project-persistence[open] > summary {
  display: flex; max-width: none; min-height: 0; padding: 0 0 6px;
  border: 0; border-radius: 0; background: none; box-shadow: none;
}
.project-persistence p { margin: 7px 0; }
.project-persistence ul { margin: 6px 0; padding-left: 17px; }
.project-persistence li { margin: 6px 0; }
.project-persistence li span { display: block; color: var(--muted-foreground); }
.project-persistence [role="alert"], .project-readonly-reason { color: var(--destructive); }
/* Narrow windows: below the 73px module toolbar (which ends at 122px from the
   window top) and clear of the Home button, which is above it. */
@media (max-width: 1180px) {
  .project-persistence { top: 126px; right: 12px; max-width: min(320px, calc(100% - 510px)); }
}
/* Phone widths: the left column of map overlays reaches x≈242, so the chip
   keeps to the free right-hand strip and shows the local state only (the
   cloud state stays in the DOM and the expanded card). */
@media (max-width: 740px) {
  .project-persistence { max-width: calc(100% - 262px); }
  .project-persistence summary span[data-testid="cloud-save-status"] {
    position: absolute; width: 1px; height: 1px; margin: -1px;
    padding: 0; border: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap;
  }
}
.project-review { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border); }
.project-review h3 { margin: 0; font-size: var(--tm-text-label); }

/* Account menu content (DropdownMenu portals to the body). */
.account-menu__identity { display: grid; gap: 1px; }
.account-menu__identity strong { font-size: var(--tm-text-label); }
.account-menu__identity small { font-size: var(--tm-text-meta); color: var(--muted-foreground); }

/* Layer rows and inline controls. */
.unsupported-layer-status { white-space: normal; overflow-wrap: anywhere; }
.layer-swatch.unsupported { background: var(--destructive); border-radius: 0; }
.layer-swatch.lines { height: 3px; border-radius: 0; background: #38bdf8; }
.layer-swatch.polygons { border-radius: 1px; border: 1px solid #ffffff; background: #38bdf8; }
.layer-copy .ordinary-atlas-status { white-space: normal; overflow-wrap: anywhere; }
.layer-group-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 10px 6px;
  border-bottom: 1px solid var(--border);
  background: var(--muted);
  font-size: var(--tm-text-meta);
}
.layer-group-controls label { display: flex; align-items: center; gap: 5px; min-width: 0; }
.layer-group-controls small { flex: 1 0 100%; color: var(--muted-foreground); font-size: var(--tm-text-meta); }
.sidebar-add { padding: 6px 10px; }
.sidebar-add__trigger { width: 100%; }
.layer-row > .layer-retry {
  grid-column: 3 / -1;
  justify-self: start;
  width: auto;
  max-width: 100%;
  height: auto;
  overflow-wrap: anywhere;
  text-align: left;
}
.ordinary-point-error { display: block; color: var(--destructive); overflow-wrap: anywhere; white-space: normal; }
.point-layer-action-message,
.point-layer-action-error,
.layer-group-error {
  margin: 0;
  padding: 8px 10px;
  font-size: var(--tm-text-meta);
  line-height: var(--tm-line-meta);
  overflow-wrap: anywhere;
}
.point-layer-action-error,
.layer-group-error { color: var(--destructive); }
.ordinary-point-style-controls { grid-column: 1 / -1; display: grid; gap: 6px; }
.ordinary-point-style-controls label { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.ordinary-point-style-controls input[type="number"] { width: 68px; }
.ordinary-raster-controls select { flex: 1; min-width: 0; max-width: 100%; }
.ordinary-point-style-error { margin: 0; color: var(--destructive); overflow-wrap: anywhere; }
.catalog-separator { margin: 0 0 4px; }

/* Auth dialog form. */
.auth-form { display: grid; gap: 10px; }
.auth-form__field { display: grid; gap: 4px; align-items: start; }
.auth-form__field > span { font-size: var(--tm-text-meta); color: var(--muted-foreground); }
.auth-code-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: end; }
.auth-dialog__config {
  margin: 0;
  font-size: var(--tm-text-meta);
  line-height: var(--tm-line-meta);
  color: var(--muted-foreground);
  overflow-wrap: anywhere;
}

/* Upload wizard. */
.upload-steps { display: flex; gap: 6px; margin: 0; padding: 0; list-style: none; }
.upload-steps li {
  flex: 1;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--muted);
  color: var(--muted-foreground);
  font-size: var(--tm-text-meta);
  text-align: center;
}
.upload-steps li[aria-current="step"] {
  border-color: var(--primary);
  background: var(--accent);
  color: var(--accent-foreground);
  font-weight: 600;
}
.upload-file-line { display: flex; gap: 8px; align-items: baseline; margin: 0; }
.upload-file-line strong { font-size: var(--tm-text-label); }
.upload-file-line small { color: var(--muted-foreground); font-size: var(--tm-text-meta); }
.upload-mapping { display: grid; gap: 6px; }
.upload-mapping label { display: grid; gap: 3px; }
.upload-mapping label > span { font-size: var(--tm-text-meta); color: var(--muted-foreground); }
.upload-mapping label em { color: var(--destructive); font-style: normal; }
.upload-preview {
  max-height: 180px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card);
}
.upload-preview table { width: 100%; border-collapse: collapse; font-size: var(--tm-text-meta); }
.upload-preview caption { padding: 4px 6px; color: var(--muted-foreground); text-align: left; }
.upload-preview th, .upload-preview td {
  padding: 3px 6px;
  border-bottom: 1px solid var(--border);
  text-align: left;
  white-space: nowrap;
}
.upload-preview th { position: sticky; top: 0; background: var(--muted); font-weight: 600; }
.upload-actions { display: flex; justify-content: flex-end; gap: 8px; }
.upload-progress {
  height: 8px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--muted);
}
.upload-progress > span { display: block; height: 100%; background: var(--primary); transition: width 120ms linear; }
.upload-error {
  margin: 0;
  font-size: var(--tm-text-meta);
  line-height: var(--tm-line-meta);
  color: var(--destructive);
  overflow-wrap: anywhere;
}
@media (prefers-reduced-motion: reduce) {
  .upload-progress > span { transition: none; }
}
</style>
