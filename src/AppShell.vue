<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type {
  ProjectDocumentV2TO,
  ProjectRevisionSummaryRO,
} from "@timemachine/generated-api";
import {
  normalizePointStyleExpression,
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
  AgentActionBusyError,
  AgentActionValidationError,
} from "./agent-actions/registry";
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
const layerRows = ref<ProjectLayerSnapshot[]>(
  defaultProjectSession.layerList,
);
const layerGroups = ref<ProjectLayerGroupSnapshot[]>(
  defaultProjectSession.groupList,
);
const layerSearch = ref("");
const selectedLayerId = ref<number | undefined>();
const draggedLayerId = ref<number | undefined>();
const dropTargetLayerId = ref<number | undefined>();
let toastTimer: number | undefined;
let unsubscribePhase1B: (() => void) | undefined;

const moduleItems = [
  { icon: "◇", label: "Layer" },
  { icon: "◎", label: "Atlas" },
  { icon: "▱", label: "Database" },
  { icon: "⠿", label: "Multi Globe" },
  { icon: "▰", label: "Project Market" },
  { icon: "▦", label: "Area Tool" },
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
const filteredLayerRows = computed(() => {
  const query = layerSearch.value.trim().toLocaleLowerCase();
  return query
    ? layerRows.value.filter((layer) =>
        layer.name.toLocaleLowerCase().includes(query),
      )
    : layerRows.value;
});
const visibleLayerGroups = computed(() =>
  layerSearch.value
    ? layerGroups.value.filter((group) =>
        filteredLayerRows.value.some(
          (layer) => layer.groupId === group.id,
        ),
      )
    : layerGroups.value,
);

function layersForGroup(groupId: number): ProjectLayerSnapshot[] {
  return filteredLayerRows.value.filter(
    (layer) => layer.groupId === groupId,
  );
}

function layerVisibilityId(id: number): string {
  if (id === RUNTIME_LAYER_IDS.atlas) return "atlas-visibility";
  if (id === RUNTIME_LAYER_IDS.points) return "point-visibility";
  if (id === RUNTIME_LAYER_IDS.raster) {
    return "single-raster-visibility";
  }
  return "plate-visibility";
}

function layerSwatchClass(id: number): string {
  if (id === RUNTIME_LAYER_IDS.atlas) return "atlas";
  if (id === RUNTIME_LAYER_IDS.points) return "points";
  if (id === RUNTIME_LAYER_IDS.raster) return "raster";
  return "plates";
}

function showLayerStyle(id = selectedLayerId.value): void {
  activeSidebarTab.value = "layers";
  selectedLayerId.value = id ?? layerRows.value[0]?.id;
}

function changeLayerVisibility(
  layer: ProjectLayerSnapshot,
  event: Event,
): void {
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
  if (layerSearch.value) {
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
  group.alpha =
    Number((event.currentTarget as HTMLInputElement).value) / 100;
  window.dispatchEvent(
    new CustomEvent(LAYER_GROUP_OPACITY_CHANGE_EVENT, {
      detail: { alpha: group.alpha, id: group.id },
    }),
  );
}

function toggleGroup(group: ProjectLayerGroupSnapshot): void {
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
  if (
    selectedLayerId.value !== undefined &&
    !layerRows.value.some((layer) => layer.id === selectedLayerId.value)
  ) {
    selectedLayerId.value = layerRows.value[0]?.id;
  }
}

function relativeLuminance(color: string): number {
  const channels = [1, 3, 5].map((start) => {
    const value = Number.parseInt(color.slice(start, start + 2), 16) / 255;
    return value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (
    0.2126 * (channels[0] ?? 0) +
    0.7152 * (channels[1] ?? 0) +
    0.0722 * (channels[2] ?? 0)
  );
}

function segmentStyle(segment: TimelineSegment): Record<string, string> {
  return {
    background: segment.color,
    color: relativeLuminance(segment.color) < 0.36 ? "#fff" : "#24343b",
    flex: `${segment.weight} 1 0`,
  };
}

function toggleAccountMenu(): void {
  if (phase1B.value.account) {
    accountMenuVisible.value = !accountMenuVisible.value;
  } else {
    authDialogVisible.value = true;
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
    authDialogVisible.value = true;
    showToast(
      phase1B.value.status === "disabled"
        ? phase1B.value.message
        : "Sign in to save this project to the cloud",
    );
    return;
  }
  // The same registered action the facade exposes, so both paths share one
  // implementation and one set of checks.
  const result = await agentActions.execute(AGENT_ACTIONS.projectSave);
  if (!result.ok) {
    showToast(result.error.message);
    return;
  }
  showToast(
    `Cloud revision ${String(result.data?.revisionNumber ?? "")} saved`,
  );
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
async function signInWithUnityAccount(
  account: string,
  password: string,
): Promise<Phase1BState> {
  if (!account.trim()) {
    throw new AgentActionValidationError(
      "auth.login requires a non-empty 'account'.",
    );
  }
  if (!password) {
    throw new AgentActionValidationError("auth.login requires a 'password'.");
  }
  authAccount.value = account;
  authPassword.value = password;
  return phase1BCloudClient.loginWithPassword(account, password);
}

async function signInWithVerificationCode(
  email: string,
  code: string,
): Promise<Phase1BState> {
  if (!email.trim()) {
    throw new AgentActionValidationError(
      "auth.login requires a non-empty 'email'.",
    );
  }
  if (!code.trim()) {
    throw new AgentActionValidationError("auth.login requires a non-empty 'code'.");
  }
  authEmail.value = email;
  authCode.value = code;
  return phase1BCloudClient.login(email, code);
}

/** UI wrapper: the password field never lingers in component state. */
async function signInWithPassword(): Promise<void> {
  authBusy.value = true;
  try {
    await signInWithUnityAccount(authAccount.value, authPassword.value);
    authDialogVisible.value = false;
    showToast("Signed in and shared catalog refreshed");
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  } finally {
    authBusy.value = false;
    authPassword.value = "";
  }
}

async function signInWithEmailCode(): Promise<void> {
  authBusy.value = true;
  try {
    await signInWithVerificationCode(authEmail.value, authCode.value);
    authDialogVisible.value = false;
    authCode.value = "";
    showToast("Signed in and shared catalog refreshed");
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  } finally {
    authBusy.value = false;
  }
}

async function logout(): Promise<void> {
  accountMenuVisible.value = false;
  await phase1BCloudClient.logout();
  showToast("Signed out");
}

/** Reports the real outcome instead of always announcing success. */
async function refreshCloudWorkspace(): Promise<Phase1BState> {
  try {
    const state = await phase1BCloudClient.refreshCatalogs();
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
  phase1BCloudClient.selectPlateModel(versionId);
  showToast("Versioned plate model selected; reloading…");
  window.setTimeout(() => window.location.reload(), 280);
}

/** Selects a shared (V1) plate model by its `UserPlateModel` ID. */
function selectSharedPlateModel(plateModelId: number): void {
  phase1BCloudClient.selectSharedPlateModel(plateModelId);
  showToast(`Shared plate model ${plateModelId} selected; reloading…`);
  window.setTimeout(() => window.location.reload(), 280);
}

function selectLocalPlateModelDemo(): void {
  phase1BCloudClient.selectLocalPlateModelDemo();
  showToast("Local demo plate model selected; reloading…");
  window.setTimeout(() => window.location.reload(), 280);
}

function selectDataset(versionId: number): void {
  phase1BCloudClient.selectDataset(versionId);
  showToast("Dataset selected; reloading its versioned manifest…");
  window.setTimeout(() => window.location.reload(), 280);
}

async function openCloudProject(
  project: ProjectRevisionSummaryRO,
): Promise<void> {
  // Failures propagate: the caller decides whether that is a toast or a
  // reported action failure.
  const document = await phase1BCloudClient.openProject(project);
  window.dispatchEvent(
    new CustomEvent<{ document: ProjectDocumentV2TO }>(
      "timemachine:cloud-project-open",
      { detail: { document } },
    ),
  );
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
  authDialogVisible.value = true;
}

function openUploadWizard(): void {
  if (!phase1B.value.account) {
    authDialogVisible.value = true;
    showToast(
      phase1B.value.status === "disabled"
        ? phase1B.value.message
        : "Sign in to upload a dataset",
    );
    return;
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
    const state =
      mode === "account"
        ? await signInWithUnityAccount(
            String(params.account ?? ""),
            String(params.password ?? ""),
          )
        : await signInWithVerificationCode(
            String(params.email ?? ""),
            String(params.code ?? ""),
          );
    if (!state.account) {
      throw new AgentActionValidationError("Sign-in did not produce a session.");
    }
    authDialogVisible.value = false;
    authPassword.value = "";
    authCode.value = "";
    // Only a safe session summary is returned; no token, password or digest.
    return {
      data: {
        accountName: state.account.name,
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
  ready(AGENT_ACTIONS.catalogRefresh, async () => {
    const state = await refreshCloudWorkspace();
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

  // --- Cloud projects (V2 only) -------------------------------------------
  ready(AGENT_ACTIONS.projectOpen, async (params) => {
    requireV2Workspace(
      phase1B.value.v2WorkspaceAvailable,
      "cloud projects",
    );
    const project = phase1B.value.projects.find(
      (item) => foreignKeyValue(item.Revision) === params.revisionId,
    );
    if (!project) {
      throw new AgentActionValidationError(
        `No cloud project revision ${String(params.revisionId)} in the catalog.`,
      );
    }
    // main.ts saves the opened session and reloads; the caller verifies the
    // reload through bootId rather than assuming the navigation happened.
    await openCloudProject(project);
    return { data: { accepted: true }, reloadRequired: true };
  });

  // --- Upload wizard (V2 only) --------------------------------------------
  ready(AGENT_ACTIONS.uploadOpen, async () => {
    requireV2Workspace(
      phase1B.value.v2WorkspaceAvailable,
      "dataset ingest",
    );
    openUploadWizard();
    return {};
  });

  ready(AGENT_ACTIONS.uploadClose, () => {
    closeUploadWizard();
    return {};
  });

  ready(AGENT_ACTIONS.uploadBack, (params) => {
    const step = params.step === undefined ? undefined : (params.step as string);
    if (step !== undefined && !["select", "map", "run"].includes(step)) {
      throw new AgentActionValidationError(
        "upload.back 'step' must be 'select', 'map' or 'run'.",
      );
    }
    if (uploadBusy.value) {
      throw new AgentActionBusyError("An ingest job is already running.");
    }
    uploadStep.value = (step ?? "select") as UploadStep;
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
    activeSidebarTab.value = tab;
    return { data: { tab } };
  });
  ready(AGENT_ACTIONS.authDialogOpen, () => {
    authDialogVisible.value = true;
    return {};
  });
  ready(AGENT_ACTIONS.authDialogClose, () => {
    authDialogVisible.value = false;
    return {};
  });
  ready(AGENT_ACTIONS.authModeSet, (params) => {
    const mode = params.mode;
    if (mode !== "account" && mode !== "email-code") {
      throw new AgentActionValidationError(
        "ui.authMode.set 'mode' must be 'account' or 'email-code'.",
      );
    }
    authMode.value = mode;
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
    [AGENT_ACTIONS.projectOpen, "cloud projects"],
    [AGENT_ACTIONS.uploadOpen, "dataset ingest"],
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
  agentActions.registerStateSection("session", () => sessionSummary());
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
  }));
  agentActions.registerStateSection("selection", () => ({
    ...phase1B.value.selection,
  }));
  agentActions.registerStateSection("ui", () => ({
    accountMenuOpen: accountMenuVisible.value,
    activeSidebarTab: activeSidebarTab.value,
    authDialogOpen: authDialogVisible.value,
    authMode: authMode.value,
    busy: authBusy.value || uploadBusy.value,
    toolbarCollapsed: toolbarCollapsed.value,
    uploadStep: uploadStep.value,
    uploadWizardOpen: uploadDialogVisible.value,
  }));
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
  unsubscribePhase1B = phase1BCloudClient.subscribe((state) => {
    phase1B.value = state;
    if (state.account && !authEmail.value) {
      authEmail.value = state.account.email;
    }
  });
  registerAgentActions();
  void phase1BCloudClient.initialize();
  window.addEventListener("timemachine:project-saved", handleProjectSaved);
  window.addEventListener("timemachine:project-save-error", handleProjectSaveError);
  window.addEventListener("timemachine:auth-required", handleAuthRequired);
  window.addEventListener(LAYER_STATE_EVENT, handleLayerState);
});

onBeforeUnmount(() => {
  unsubscribePhase1B?.();
  window.removeEventListener("timemachine:project-saved", handleProjectSaved);
  window.removeEventListener("timemachine:project-save-error", handleProjectSaveError);
  window.removeEventListener("timemachine:auth-required", handleAuthRequired);
  window.removeEventListener(LAYER_STATE_EVENT, handleLayerState);
  window.clearTimeout(toastTimer);
});
</script>

<template>
  <div class="viewport">
    <div class="stage">
      <header class="topbar">
        <button
          class="menu-button"
          type="button"
          aria-label="Open main menu"
          data-action="ui.menu.toggle"
        >☰</button>
        <div class="brand" aria-label="Global Paleogeographic Collaboration Network">
          <span class="brand__seal">GPCN</span>
          <span class="brand__copy">Global Paleogeographic<br />Collaboration Network</span>
        </div>
        <button
          class="top-action"
          type="button"
          data-action="project.save"
          @click="requestProjectSave"
        >
          <span>⇧</span> Save to Cloud
        </button>
        <span class="draft-pill">
          {{
            phase1BCloudClient.getCloudReference()
              ? `Cloud r${phase1BCloudClient.getCloudReference()?.revisionNumber}`
              : "Local Draft"
          }}
        </span>
        <input
          id="project-name"
          class="project-name"
          value="Untitled_6/5/2025 6:10:11 AM"
          aria-label="Project name"
          data-action="project.setName"
        />
        <div class="app-title">Time Machine</div>
        <div class="topbar__spacer"></div>
        <div class="account-area">
          <button
            class="sign-in"
            type="button"
            :aria-expanded="accountMenuVisible"
            data-action="ui.accountMenu.toggle"
            @click="toggleAccountMenu"
          >
            <span class="sign-in__avatar"></span>
            <span>{{ phase1B.account?.name ?? "Not signed in" }}</span>
          </button>
          <div v-if="accountMenuVisible && phase1B.account" class="account-menu">
            <strong>{{ phase1B.account.name }}</strong>
            <small>{{ phase1B.account.email }}</small>
            <button
              type="button"
              data-action="catalog.refresh"
              @click="refreshCloudWorkspace"
            >
              Refresh cloud
            </button>
            <button type="button" data-action="auth.logout" @click="logout">Sign out</button>
          </div>
        </div>
        <button
          class="top-action"
          type="button"
          data-action="publish.run"
          @click="showToast('Publish requires Phase 1B server connection')"
        >
          <span>➤</span> Publish
        </button>
        <button
          class="top-action"
          type="button"
          data-action="export.run"
          @click="showToast('Export options will be connected in a later slice')"
        >
          <span>⇩</span> Export
        </button>
        <button
          class="top-icon-button"
          type="button"
          aria-label="Notifications"
          data-action="ui.notifications.open"
        >♟</button>
        <button
          class="top-icon-button"
          type="button"
          aria-label="Settings"
          data-action="ui.settings.open"
        >⚙</button>
        <button
          class="top-icon-button"
          type="button"
          aria-label="Information"
          data-action="ui.info.open"
        >ⓘ</button>
      </header>

      <aside class="sidebar">
        <div class="sidebar-tabs" role="tablist" aria-label="Data views">
          <button
            class="sidebar-tab"
            type="button"
            role="tab"
            :aria-selected="activeSidebarTab === 'layers'"
            data-action="ui.sidebar.select"
            @click="activeSidebarTab = 'layers'"
          >
            Layer
          </button>
          <button
            class="sidebar-tab"
            type="button"
            role="tab"
            :aria-selected="activeSidebarTab === 'plate-models'"
            data-action="ui.sidebar.select"
            @click="activeSidebarTab = 'plate-models'"
          >
            Plate Model
          </button>
        </div>

        <label class="layer-search">
          <span class="visually-hidden">Search layers</span>
          <input
            v-model="layerSearch"
            type="search"
            autocomplete="off"
            placeholder="Filter layers"
            data-action="ui.layerSearch.set"
          />
          <span aria-hidden="true">⌕</span>
        </label>

        <div class="sidebar-actions">
          <button type="button" data-action="upload.open" @click="openUploadWizard">
            <b>↥</b><span>Upload to Layer</span>
          </button>
          <button type="button" data-action="ui.layerStyle.open" @click="showLayerStyle()">
            <b>◉</b><span>Layer Style</span>
          </button>
        </div>

        <section v-show="activeSidebarTab === 'layers'" class="layer-list" aria-label="Layers">
          <template v-for="group in visibleLayerGroups" :key="group.id">
            <div
              class="layer-group-row"
              :class="{ 'is-drop-target': dropTargetLayerId === -group.id }"
              :data-group-id="group.id"
              @dragenter.prevent="dropTargetLayerId = -group.id"
              @dragover.prevent
              @drop.prevent="dropLayerIntoGroup(group.id)"
            >
              <button
                type="button"
                :aria-label="`${group.collapsed ? 'Expand' : 'Collapse'} ${group.name}`"
                data-action="layer.group.setCollapsed"
                @click="toggleGroup(group)"
              >{{ group.collapsed ? "›" : "⌄" }}</button>
              <input
                type="checkbox"
                :checked="group.active"
                :aria-label="`${group.name} visibility`"
                data-action="layer.group.setVisibility"
                @change="changeGroupVisibility(group, $event)"
              />
              <strong>{{ group.name }}</strong>
              <small>{{ layersForGroup(group.id).length }}</small>
              <input
                class="layer-group-opacity"
                type="range"
                min="0"
                max="100"
                step="1"
                :value="Math.round(group.alpha * 100)"
                :aria-label="`${group.name} opacity`"
                data-action="layer.group.setOpacity"
                @input="changeGroupOpacity(group, $event)"
              />
              <output>{{ Math.round(group.alpha * 100) }}%</output>
            </div>
          <article
            v-for="layer in layersForGroup(group.id)"
            :key="layer.id"
            v-show="!group.collapsed || Boolean(layerSearch)"
            class="layer-row"
            :class="{
              'is-selected': selectedLayerId === layer.id,
              'is-dragging': draggedLayerId === layer.id,
              'is-drop-target': dropTargetLayerId === layer.id,
              'has-options': selectedLayerId === layer.id,
            }"
            :draggable="!layerSearch"
            :data-layer-id="layer.id"
            data-action="ui.layerStyle.open"
            @click="selectedLayerId = layer.id"
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
              data-action="layer.setVisibility"
              @click.stop
              @change="changeLayerVisibility(layer, $event)"
            />
            <span
              class="layer-swatch"
              :class="layerSwatchClass(layer.id)"
              aria-hidden="true"
            ></span>
            <span class="layer-copy">
              <strong>{{ layer.name }}</strong>
              <small v-if="layer.id === RUNTIME_LAYER_IDS.atlas">
                <span id="atlas-frame-value">—</span> ·
                <span id="atlas-status">Loading atlas…</span>
              </small>
              <small v-else-if="layer.id === RUNTIME_LAYER_IDS.points">
                <span id="point-state-chip">Preparing</span> · GPU point runtime
              </small>
              <small v-else-if="layer.id === RUNTIME_LAYER_IDS.raster">
                <span id="single-raster-state">Preparing</span>
              </small>
              <small v-else>PALEOMAP finite rotations</small>
            </span>
            <span
              v-if="layer.id === RUNTIME_LAYER_IDS.points"
              class="layer-inline-actions"
            >
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
            </span>
            <button
              v-else
              type="button"
              :aria-label="`${layer.name} options`"
              data-action="ui.layerStyle.open"
              @click.stop="selectedLayerId = selectedLayerId === layer.id ? undefined : layer.id"
            >•••</button>
            <div
              v-show="selectedLayerId === layer.id"
              class="layer-style-inline"
              @click.stop
            >
              <span>Opacity</span>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                :value="Math.round(layer.alpha * 100)"
                :aria-label="`${layer.name} opacity`"
                data-action="layer.setOpacity"
                @input="changeLayerOpacity(layer, $event)"
              />
              <output>{{ Math.round(layer.alpha * 100) }}%</output>
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
                    data-action="points.setStyle"
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
                    data-action="points.setStyle"
                    @input="changePointStyleField(layer, 'singleColor', $event)"
                  />
                </label>
                <label>
                  <span>Size</span>
                  <select
                    :value="layer.pointStyle.sizeMode"
                    data-action="points.setStyle"
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
                    data-action="points.setStyle"
                    @input="changePointStyleField(layer, 'pointSize', $event)"
                  />
                </label>
                <label>
                  <span>Shape</span>
                  <select
                    :value="layer.pointStyle.shape"
                    data-action="points.setStyle"
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
                    data-action="points.setStyle"
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
                    data-action="points.setStyle"
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
                    data-action="points.setStyle"
                    @input="changePointFilter(layer, 'maximumOccurrence', $event)"
                  />
                </label>
              </div>
            </div>
          </article>
          </template>
          <p v-if="filteredLayerRows.length === 0" class="layer-empty">
            No matching layers
          </p>
        </section>

        <section v-show="activeSidebarTab === 'plate-models'" class="plate-model-list">
          <div class="catalog-heading catalog-heading--first">
            <strong>Shared plate models</strong>
            <button
              type="button"
              :disabled="phase1B.sharedPlateModelsStatus === 'loading' || !phase1B.serverUrl"
              aria-label="Refresh shared plate models"
              data-action="catalog.refresh"
              @click="refreshCloudWorkspace"
            >↻</button>
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
            <button
              type="button"
              data-action="model.select"
              @click="selectSharedPlateModel(foreignKeyValue(item.ID))"
            >Use</button>
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
            <button
              type="button"
              :disabled="phase1B.selection.useLocalPlateModelDemo"
              data-action="model.select"
              @click="selectLocalPlateModelDemo"
            >Use</button>
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
              <button
                type="button"
                aria-label="Refresh versioned catalog"
                data-action="catalog.refresh"
                @click="refreshCloudWorkspace"
              >↻</button>
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
              <button
                type="button"
                data-action="model.select"
                @click="selectPlateModel(foreignKeyValue(item.Version.ID))"
              >Use</button>
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
              <button
                type="button"
                data-action="dataset.select"
                @click="selectDataset(foreignKeyValue(item.Version.ID))"
              >Use</button>
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
                <button
                  type="button"
                  data-action="model.select"
                  @click="selectPlateModel(foreignKeyValue(item.Version.ID))"
                >Use</button>
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
                <button
                  type="button"
                  data-action="dataset.select"
                  @click="selectDataset(foreignKeyValue(item.Version.ID))"
                >Use</button>
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
              <button
                type="button"
                data-action="project.open"
                @click="openCloudProject(project)"
              >
                Open
              </button>
            </article>
          </template>

          <p v-else class="catalog-status" data-testid="v2-unavailable">
            {{ phase1B.message || "TimeMachine V2 workspace endpoints are unavailable on this Server." }}
          </p>
        </section>

        <div class="runtime-diagnostics" aria-hidden="true">
          <input
            id="point-size"
            type="range"
            value="2.2"
            min="0.5"
            max="8"
            step="any"
            data-action="points.setSize"
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

      <main class="workspace" aria-label="3D globe workspace">
        <div id="cesium-container"></div>
        <div class="canvas-vignette" aria-hidden="true"></div>

        <nav
          id="module-toolbar"
          class="module-toolbar"
          :class="{ 'is-collapsed': toolbarCollapsed }"
          aria-label="Workspace modules"
        >
          <button
            v-for="item in moduleItems"
            :key="item.label"
            v-show="!toolbarCollapsed"
            type="button"
            class="module-button"
            :class="{ 'is-active': activeModule === item.label }"
            data-action="ui.module.select"
            @click="activeModule = item.label"
          >
            <b>{{ item.icon }}</b>
            <span>{{ item.label }}</span>
          </button>
          <button
            class="toolbar-collapse"
            type="button"
            :aria-label="toolbarCollapsed ? 'Expand toolbar' : 'Collapse toolbar'"
            data-action="ui.toolbar.toggle"
            @click="toolbarCollapsed = !toolbarCollapsed"
          >
            {{ toolbarCollapsed ? "›" : "‹" }}
          </button>
        </nav>

        <div class="time-readout"><strong id="age-value">0.0</strong> <span>Ma</span></div>
        <p id="era-label" class="era-label">Present day</p>
        <div class="view-options">
          <label
            ><input type="checkbox" data-action="ui.majorCities.setVisible" />
            <span>Major cities</span></label
          >
          <label class="place-search"
            ><input
              type="search"
              placeholder="Input a place name."
              data-action="ui.placeSearch"
            /><span>⌕</span></label
          >
          <label class="projection-control" for="projection-select">
            <span class="projection-control__label">Projection</span>
            <select id="projection-select" data-action="projection.select" disabled>
              <option value="globe">Globe (3D)</option>
              <option value="rectangle">Rectangle</option>
              <option value="mollweide" disabled>Mollweide</option>
            </select>
          </label>
          <p id="projection-status" class="projection-status" aria-live="polite"></p>
        </div>

        <button
          id="home-camera"
          class="home-camera"
          type="button"
          aria-label="Reset globe view"
          data-action="camera.reset"
        >
          ⌂
        </button>

        <section class="playback" aria-label="Time playback controls">
          <div class="playback__grip">••••••••</div>
          <div class="playback__row">
            <output class="time-box"><span id="playback-age-mirror">0.0</span></output>
            <span class="ma-label">Ma</span>
            <div class="transport">
              <button
                type="button"
                data-age="100"
                aria-label="Jump to 100 Ma"
                data-action="time.set"
              >
                ◀
              </button>
              <button
              id="play-button"
              type="button"
              aria-label="Play geological time"
              data-action="time.setPlaying"
            >
                <span class="play-icon" aria-hidden="true"></span>
                <span data-play-label>Play</span>
              </button>
              <button
                type="button"
                data-age="0"
                aria-label="Jump to present"
                data-action="time.set"
              >
                ▶
              </button>
            </div>
            <button
            id="speed-button"
            class="mini-button"
            type="button"
            data-action="time.setSpeed"
          >
            25 Ma/s
          </button>
            <button
            id="today-button"
            class="mini-button"
            type="button"
            data-action="time.set"
          >
            0
          </button>
          </div>
          <div class="playback__row playback__stats">
            <span>Plates <b id="active-plates">—</b></span>
            <span>Features <b id="active-features">—</b></span>
          </div>
        </section>

        <aside id="plate-inspector" class="plate-inspector">
          <div id="inspector-empty">Click a plate to inspect</div>
          <div id="inspector-content" hidden>
            <strong id="selected-name">Plate</strong>
            <span id="selected-id">ID —</span>
            <span id="selected-validity">—</span>
            <span id="selected-state">—</span>
            <span id="selected-quaternion">—</span>
          </div>
        </aside>

        <div class="map-caption">
          <span id="mesh-stat">Waiting for plate mesh</span>
          <span id="plate-model-status" class="plate-model-status"></span>
        </div>
      </main>

      <section class="timeline" aria-label="Geological time scale">
        <div class="timeline__left-rail">
          <span class="timeline__max">538.8</span>
          <span class="timeline__rail-knob">↔</span>
        </div>
        <div class="timeline__scale">
          <div
            v-for="row in timelineRows"
            :key="row.className"
            class="timeline-row"
            :class="row.className"
          >
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
          max="538.8"
          value="0"
          step="0.1"
          aria-label="Geological age in Ma"
          data-action="time.set"
        />
        <span class="timeline__zero">0.0</span>
        <div class="quick-ages" aria-hidden="true">
          <button type="button" data-age="32" data-action="time.set">32</button>
          <button type="button" data-age="250" data-action="time.set">250</button>
          <button type="button" data-age="538.8" data-action="time.set">538.8</button>
        </div>
      </section>

      <div id="loading-overlay" class="loading-overlay">
        <div class="loading-card">
          <span class="loading-spinner" aria-hidden="true"></span>
          <p>Preparing reconstruction</p>
          <h2 id="loading-title">Loading PALEOMAP data</h2>
          <p id="loading-detail">Parsing GPML polygons and finite rotations…</p>
          <div class="loading-track"><span id="loading-progress"></span></div>
        </div>
      </div>

      <div class="toast" :class="{ 'is-visible': toastVisible }" role="status" aria-live="polite">
        {{ toastMessage }}
      </div>

      <div
        v-if="authDialogVisible"
        class="auth-backdrop"
        role="presentation"
        @pointerdown.self="authDialogVisible = false"
      >
        <section class="auth-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-title">
          <button
            class="auth-dialog__close"
            type="button"
            aria-label="Close"
            data-action="ui.authDialog.close"
            @click="authDialogVisible = false"
          >
            ×
          </button>
          <span class="auth-dialog__mark">TM</span>
          <h2 id="auth-title">Sign in to Time Machine</h2>
          <p>
            使用 Server 既有 Unity 账号登录；密码只在本地折算成 Server 约定的摘要，不会保存或记录。
          </p>
          <div class="auth-mode-row" role="tablist" aria-label="Sign-in method">
            <button
              type="button"
              role="tab"
              :aria-selected="authMode === 'account'"
              :class="{ 'is-active': authMode === 'account' }"
              data-action="ui.authMode.set"
              @click="authMode = 'account'"
            >账号密码</button>
            <button
              type="button"
              role="tab"
              :aria-selected="authMode === 'email-code'"
              :class="{ 'is-active': authMode === 'email-code' }"
              data-action="ui.authMode.set"
              @click="authMode = 'email-code'"
            >邮箱验证码</button>
          </div>

          <template v-if="authMode === 'account'">
            <label>
              <span>账号</span>
              <input
                v-model.trim="authAccount"
                type="text"
                autocomplete="username"
                placeholder="Unity 账号"
                data-action="auth.login"
              />
            </label>
            <label>
              <span>密码</span>
              <input
                v-model="authPassword"
                type="password"
                autocomplete="current-password"
                placeholder="Server 账号密码"
                data-action="auth.login"
                @keyup.enter="signInWithPassword"
              />
            </label>
            <button
              class="auth-dialog__submit"
              type="button"
              data-testid="password-login"
              data-action="auth.login"
              :disabled="authBusy || !authAccount || !authPassword || !phase1B.serverUrl"
              @click="signInWithPassword"
            >
              {{ authBusy ? "Connecting…" : "Sign in" }}
            </button>
          </template>

          <template v-else>
            <label>
              <span>Email</span>
              <input
                v-model.trim="authEmail"
                type="email"
                autocomplete="email"
                placeholder="you@example.com"
                data-action="auth.sendCode"
              />
            </label>
            <div class="auth-code-row">
              <label>
                <span>Verification code</span>
                <input
                  v-model.trim="authCode"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  placeholder="6-digit code"
                  data-action="auth.login"
                />
              </label>
              <button
                type="button"
                :disabled="authBusy || !authEmail || !phase1B.serverUrl"
                data-action="auth.sendCode"
                @click="sendLoginCode"
              >Send code</button>
            </div>
            <button
              class="auth-dialog__submit"
              type="button"
              :disabled="authBusy || !authEmail || !authCode || !phase1B.serverUrl"
              data-action="auth.login"
              @click="signInWithEmailCode"
            >
              {{ authBusy ? "Connecting…" : "Sign in" }}
            </button>
          </template>

          <p v-if="!phase1B.serverUrl" class="auth-dialog__config">
            {{ phase1B.message || "未配置 Server 地址（VITE_TIMEMACHINE_SERVER_URL）。" }}
          </p>
          <p v-else-if="phase1B.message" class="auth-dialog__config">
            {{ phase1B.message }}
          </p>
        </section>
      </div>

      <div
        v-if="uploadDialogVisible"
        class="auth-backdrop"
        role="presentation"
        @pointerdown.self="dismissUploadWizard"
      >
        <section class="upload-dialog" role="dialog" aria-modal="true" aria-labelledby="upload-title">
          <button
            class="auth-dialog__close"
            type="button"
            aria-label="Close"
            :disabled="uploadBusy"
            data-action="upload.close"
            @click="closeUploadWizard"
          >×</button>
          <h2 id="upload-title">Upload point dataset</h2>
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
                :disabled="uploadBusy"
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
                data-action="upload.run"
              />
            </label>
            <label>
              <span>Description</span>
              <input
                v-model.trim="uploadDescription"
                type="text"
                maxlength="1024"
                data-action="upload.run"
              />
            </label>
            <label>
              <span>Plate model</span>
              <select v-model.number="uploadPlateModelId" data-action="upload.run">
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
                <select v-model="uploadMapping.longitudeColumn" data-action="upload.run">
                  <option value="">Not mapped</option>
                  <option v-for="header in uploadPreview?.headerList ?? []" :key="`lng-${header}`" :value="header">{{ header }}</option>
                </select>
              </label>
              <label>
                <span>Latitude<em aria-hidden="true">*</em></span>
                <select v-model="uploadMapping.latitudeColumn" data-action="upload.run">
                  <option value="">Not mapped</option>
                  <option v-for="header in uploadPreview?.headerList ?? []" :key="`lat-${header}`" :value="header">{{ header }}</option>
                </select>
              </label>
              <label>
                <span>Age start (Ma)</span>
                <select v-model="uploadMapping.ageStartColumn" data-action="upload.run">
                  <option value="">Permanent</option>
                  <option v-for="header in uploadPreview?.headerList ?? []" :key="`from-${header}`" :value="header">{{ header }}</option>
                </select>
              </label>
              <label>
                <span>Age end (Ma)</span>
                <select v-model="uploadMapping.ageEndColumn" data-action="upload.run">
                  <option value="">Permanent</option>
                  <option v-for="header in uploadPreview?.headerList ?? []" :key="`to-${header}`" :value="header">{{ header }}</option>
                </select>
              </label>
              <label>
                <span>Occurrence</span>
                <select v-model="uploadMapping.occurrenceColumn" data-action="upload.run">
                  <option value="">None</option>
                  <option v-for="header in uploadPreview?.headerList ?? []" :key="`occ-${header}`" :value="header">{{ header }}</option>
                </select>
              </label>
              <label>
                <span>Plate ID</span>
                <select v-model="uploadMapping.plateIdColumn" data-action="upload.run">
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
              <button
                type="button"
                :disabled="uploadBusy"
                data-action="ui.upload.back"
                @click="uploadStep = 'select'"
              >
                Back
              </button>
              <button
                class="auth-dialog__submit"
                type="button"
                :disabled="uploadBusy || ingestPlateModels.length === 0"
                data-action="upload.run"
                @click="startIngest()"
              >Start ingest</button>
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
              <button
                type="button"
                :disabled="!uploadBusy || uploadJobId <= 0"
                data-action="upload.cancel"
                @click="cancelIngest"
              >Cancel job</button>
              <button
                type="button"
                :disabled="uploadBusy"
                data-action="ui.upload.back"
                @click="uploadStep = 'map'"
              >
                Back
              </button>
            </div>
          </template>

          <p v-if="uploadError" class="upload-error" role="alert">{{ uploadError }}</p>
        </section>
      </div>
    </div>
  </div>
</template>
