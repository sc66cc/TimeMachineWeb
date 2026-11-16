/**
 * Stable action identifiers and parameter shapes.
 *
 * The UI and `window.timeMachineAgent` both dispatch through these ids, so the
 * list below is the single inventory of what the app can do. Add a new entry
 * here before wiring a button to it.
 */

export const AGENT_ACTIONS = {
  addPanelSetVisible: "ui.addPanel.setVisible",
  authDialogClose: "ui.authDialog.close",
  authDialogOpen: "ui.authDialog.open",
  authLogin: "auth.login",
  authLogout: "auth.logout",
  authModeSet: "ui.authMode.set",
  authSendCode: "auth.sendCode",
  accountMenuSetVisible: "ui.accountMenu.setVisible",
  accountMenuToggle: "ui.accountMenu.toggle",
  cameraReset: "camera.reset",
  cameraZoom: "camera.zoom",
  cameraPan: "camera.pan",
  catalogRefresh: "catalog.refresh",
  consoleClear: "ui.console.clear",
  consoleSelectOutput: "ui.console.selectOutput",
  consoleSetVisible: "ui.console.setVisible",
  datasetSelect: "dataset.select",
  exportPlaceholder: "export.run",
  featureSelect: "feature.select",
  featureClear: "feature.clear",
  layerAdd: "layer.add",
  layerRemove: "layer.remove",
  layerRetry: "layer.retry",
  layerSetStyle: "layer.setStyle",
  layerGroupCollapse: "layer.group.setCollapsed",
  layerGroupAdd: "layer.group.add",
  layerGroupMove: "layer.group.move",
  layerGroupRemove: "layer.group.remove",
  layerGroupOpacity: "layer.group.setOpacity",
  layerGroupVisibility: "layer.group.setVisibility",
  layerMoveToGroup: "layer.setGroup",
  layerOpacity: "layer.setOpacity",
  layerOrder: "layer.setOrder",
  layerSearchSet: "ui.layerSearch.set",
  layerStyleOpen: "ui.layerStyle.open",
  layerStyleClose: "ui.layerStyle.close",
  layerVisibility: "layer.setVisibility",
  majorCitiesSetVisible: "ui.majorCities.setVisible",
  moduleSelect: "ui.module.select",
  modelSelect: "model.select",
  placeSearch: "ui.placeSearch",
  pointsLoad: "points.load",
  pointsSelectDataset: "points.selectDataset",
  pointsSetSize: "points.setSize",
  pointsSetStyle: "points.setStyle",
  pointsUnload: "points.unload",
  projectOpen: "project.open",
  projectionSelect: "projection.select",
  projectSave: "project.save",
  projectSaveLocal: "project.saveLocal",
  projectExportOriginal: "project.exportOriginal",
  projectSetName: "project.setName",
  publishPlaceholder: "publish.run",
  rasterSelect: "raster.select",
  sidebarSelect: "ui.sidebar.select",
  sidebarSetVisible: "ui.sidebar.setVisible",
  timeSet: "time.set",
  timeSetPlaying: "time.setPlaying",
  timeSetSpeed: "time.setSpeed",
  toolbarToggle: "ui.toolbar.toggle",
  uiInfoOpen: "ui.info.open",
  uiMenuToggle: "ui.menu.toggle",
  uiNotificationsOpen: "ui.notifications.open",
  uiSettingsOpen: "ui.settings.open",
  uploadBack: "ui.upload.back",
  uploadCancel: "upload.cancel",
  uploadClose: "upload.close",
  uploadOpen: "upload.open",
  uploadRun: "upload.run",
  welcomeSetVisible: "ui.welcome.setVisible",
} as const;

export type AgentActionId = (typeof AGENT_ACTIONS)[keyof typeof AGENT_ACTIONS];

/** Human-readable titles, kept beside the ids so the two cannot drift. */
export const AGENT_ACTION_TITLES: Record<AgentActionId, string> = {
  [AGENT_ACTIONS.addPanelSetVisible]: "Open or close the add layer panel",
  [AGENT_ACTIONS.accountMenuSetVisible]: "Show or hide the account menu",
  [AGENT_ACTIONS.accountMenuToggle]: "Toggle the account menu or open the sign-in dialog",
  [AGENT_ACTIONS.authDialogClose]: "Close the sign-in dialog",
  [AGENT_ACTIONS.authDialogOpen]: "Open the sign-in dialog",
  [AGENT_ACTIONS.authLogin]: "Sign in",
  [AGENT_ACTIONS.authLogout]: "Sign out",
  [AGENT_ACTIONS.authModeSet]: "Switch the sign-in method",
  [AGENT_ACTIONS.authSendCode]: "Send an email verification code",
  [AGENT_ACTIONS.cameraReset]: "Reset the current projection to the home view",
  [AGENT_ACTIONS.cameraZoom]: "Zoom the flat map",
  [AGENT_ACTIONS.cameraPan]: "Pan the flat map",
  [AGENT_ACTIONS.catalogRefresh]: "Refresh the plate model catalog",
  [AGENT_ACTIONS.consoleClear]: "Clear the development console output",
  [AGENT_ACTIONS.consoleSelectOutput]: "Select the development console output",
  [AGENT_ACTIONS.consoleSetVisible]: "Open or close the development console",
  [AGENT_ACTIONS.datasetSelect]: "Select a versioned point dataset",
  [AGENT_ACTIONS.exportPlaceholder]: "Export the project",
  [AGENT_ACTIONS.featureSelect]: "Select a feature",
  [AGENT_ACTIONS.featureClear]: "Clear feature selection",
  [AGENT_ACTIONS.layerAdd]: "Add an independent layer instance",
  [AGENT_ACTIONS.layerRemove]: "Remove a layer instance",
  [AGENT_ACTIONS.layerRetry]: "Retry a failed layer instance",
  [AGENT_ACTIONS.layerSetStyle]: "Set ordinary point, line or polygon style",
  [AGENT_ACTIONS.layerGroupCollapse]: "Collapse or expand a layer group",
  [AGENT_ACTIONS.layerGroupAdd]: "Add a layer group",
  [AGENT_ACTIONS.layerGroupMove]: "Move a layer group",
  [AGENT_ACTIONS.layerGroupRemove]: "Remove an empty layer group",
  [AGENT_ACTIONS.layerGroupOpacity]: "Set a layer group opacity",
  [AGENT_ACTIONS.layerGroupVisibility]: "Show or hide a layer group",
  [AGENT_ACTIONS.layerMoveToGroup]: "Move a layer into another group",
  [AGENT_ACTIONS.layerOpacity]: "Set a layer opacity",
  [AGENT_ACTIONS.layerOrder]: "Reorder layers",
  [AGENT_ACTIONS.layerSearchSet]: "Filter the layer list",
  [AGENT_ACTIONS.layerStyleOpen]: "Open a layer's style panel",
  [AGENT_ACTIONS.layerStyleClose]: "Close the layer style panel",
  [AGENT_ACTIONS.layerVisibility]: "Show or hide a layer",
  [AGENT_ACTIONS.majorCitiesSetVisible]: "Show or hide major cities",
  [AGENT_ACTIONS.moduleSelect]: "Select a workspace module",
  [AGENT_ACTIONS.modelSelect]: "Select the plate model to load",
  [AGENT_ACTIONS.placeSearch]: "Search for a place on the globe",
  [AGENT_ACTIONS.pointsLoad]: "Load the selected point dataset",
  [AGENT_ACTIONS.pointsSelectDataset]: "Select the local benchmark point dataset",
  [AGENT_ACTIONS.pointsSetSize]: "Set the point size in pixels",
  [AGENT_ACTIONS.pointsSetStyle]: "Set the point style expression",
  [AGENT_ACTIONS.pointsUnload]: "Unload the point dataset",
  [AGENT_ACTIONS.projectOpen]: "Open a cloud project revision",
  [AGENT_ACTIONS.projectionSelect]: "Switch the map projection",
  [AGENT_ACTIONS.projectSave]: "Save the project to the cloud",
  [AGENT_ACTIONS.projectSaveLocal]: "Save the local project draft",
  [AGENT_ACTIONS.projectExportOriginal]: "Download the original project input",
  [AGENT_ACTIONS.projectSetName]: "Rename the project",
  [AGENT_ACTIONS.publishPlaceholder]: "Publish the project",
  [AGENT_ACTIONS.rasterSelect]: "Select the single raster layer source",
  [AGENT_ACTIONS.sidebarSelect]: "Switch the sidebar tab",
  [AGENT_ACTIONS.sidebarSetVisible]: "Show or hide the sidebar",
  [AGENT_ACTIONS.timeSet]: "Set the geological age",
  [AGENT_ACTIONS.timeSetPlaying]: "Play or pause the time animation",
  [AGENT_ACTIONS.timeSetSpeed]: "Set the playback speed",
  [AGENT_ACTIONS.toolbarToggle]: "Collapse or expand the module toolbar",
  [AGENT_ACTIONS.uiInfoOpen]: "Show the information panel",
  [AGENT_ACTIONS.uiMenuToggle]: "Open the main menu",
  [AGENT_ACTIONS.uiNotificationsOpen]: "Show notifications",
  [AGENT_ACTIONS.uiSettingsOpen]: "Open settings",
  [AGENT_ACTIONS.uploadBack]: "Go back one step in the upload wizard",
  [AGENT_ACTIONS.uploadCancel]: "Cancel the running ingest job",
  [AGENT_ACTIONS.uploadClose]: "Close the upload wizard",
  [AGENT_ACTIONS.uploadOpen]: "Open the upload wizard",
  [AGENT_ACTIONS.uploadRun]: "Run the dataset ingest",
  [AGENT_ACTIONS.welcomeSetVisible]: "Show or hide the welcome panel",
};

import { agentActions } from "./registry";
import { actionContractMetadata } from "./action-contracts";
import type { AgentActionDefinition, AgentActionParam } from "./types";

interface Declaration {
  description: string;
  id: AgentActionId;
  params: readonly AgentActionParam[];
}

const NUM = (name: string, description: string, required = true): AgentActionParam => ({
  description,
  name,
  required,
  type: "number",
});

const BOOL = (name: string, description: string): AgentActionParam => ({
  description,
  name,
  required: true,
  type: "boolean",
});

const STR = (
  name: string,
  description: string,
  required = true,
): AgentActionParam => ({ description, name, required, type: "string" });

const ARR = (
  name: string,
  description: string,
  required = true,
): AgentActionParam => ({ description, name, required, type: "array" });

const OBJ = (
  name: string,
  description: string,
  required = true,
): AgentActionParam => ({ description, name, required, type: "object" });

/**
 * Declares every action at import time so `listActions()` reports a stable
 * inventory before any UI has mounted. Handlers are attached later by the UI
 * through `agentActions.register`; until then an action is reported as
 * unsupported rather than silently missing.
 */
const DECLARATIONS: readonly Declaration[] = [
  { description: "Select an existing visible feature through the shared UI selection owner.", id: AGENT_ACTIONS.featureSelect, params: [OBJ("key", "Complete viewportId/layerId/featureId identity.")] },
  { description: "Clear the target viewport selection and inspector.", id: AGENT_ACTIONS.featureClear, params: [STR("viewportId", "Existing viewport identifier.")] },
  {
    description: "Sign in with a Unity account/password or an email verification code.",
    id: AGENT_ACTIONS.authLogin,
    params: [
      STR("mode", "'account' (default) or 'email-code'.", false),
      STR("account", "Unity account name (account mode).", false),
      STR("password", "Plain password; never stored or logged.", false),
      STR("email", "Email address (email-code mode).", false),
      STR("code", "Verification code (email-code mode).", false),
    ],
  },
  {
    description: "Send an email verification code.",
    id: AGENT_ACTIONS.authSendCode,
    params: [STR("email", "Email address.")],
  },
  { description: "Sign out and reload the public catalog.", id: AGENT_ACTIONS.authLogout, params: [] },
  {
    description:
      "Reload the shared plate model catalog (public pages plus the user's own).",
    id: AGENT_ACTIONS.catalogRefresh,
    params: [],
  },
  {
    description:
      "Select the plate model to load. Reloads the page, so wait for bootId to change.",
    id: AGENT_ACTIONS.modelSelect,
    params: [
      STR("source", "'shared' (default), 'v2' or 'local-demo'.", false),
      NUM("plateModelId", "Shared plate model ID (source 'shared').", false),
      NUM("versionId", "Versioned plate model ID (source 'v2').", false),
    ],
  },
  {
    description: "Select a versioned point dataset. Reloads the page.",
    id: AGENT_ACTIONS.datasetSelect,
    params: [NUM("datasetVersionId", "Versioned dataset ID.")],
  },
  {
    description:
      "Save the project to the cloud. Requires the TimeMachine V2 workspace endpoints.",
    id: AGENT_ACTIONS.projectSave,
    params: [],
  },
  {
    description: "Capture the current project configuration and save the local draft. Returns the revision and timestamp after storage accepts the write.",
    id: AGENT_ACTIONS.projectSaveLocal,
    params: [],
  },
  {
    description: "Start a local download of the exact original project input for compatibility review or recovery. Reports download initiation and byte length.",
    id: AGENT_ACTIONS.projectExportOriginal,
    params: [STR("source", "current (default) or review for a cloud document awaiting compatibility review.", false)],
  },
  {
    description:
      "Open a cloud project revision. Requires the TimeMachine V2 workspace endpoints.",
    id: AGENT_ACTIONS.projectOpen,
    params: [NUM("revisionId", "Revision ID.")],
  },
  {
    description:
      "Switch the map projection. Shares the UI select's handler. 'globe' keeps the 3D scene; 'rectangle' is the native 2D Plate Carree view and needs every points/raster/atlas layer turned off; 'mollweide' is a plate-only flat plane with the same incompatible-layer guard.",
    id: AGENT_ACTIONS.projectionSelect,
    params: [STR("projectionId", "'globe', 'rectangle' or 'mollweide'.")],
  },
  {
    description: "Set the geological age in Ma.",
    id: AGENT_ACTIONS.timeSet,
    params: [NUM("ageMa", "Age in Ma.")],
  },
  {
    description: "Start or pause the geological time animation.",
    id: AGENT_ACTIONS.timeSetPlaying,
    params: [BOOL("playing", "True to play, false to pause.")],
  },
  {
    description: "Set the playback speed in Ma per second.",
    id: AGENT_ACTIONS.timeSetSpeed,
    params: [NUM("speedMaPerSecond", "Speed in Ma per second.")],
  },
  {
    description: "Multiply flat view width (factor > 1 zooms out). Clamped result is reported; Globe returns 501.",
    id: AGENT_ACTIONS.cameraZoom,
    params: [NUM("factor", "Finite multiplier within [0.01, 100].")],
  },
  {
    description: "Drag the flat map in CSS pixels; positive X moves content right, positive Y down. Globe returns 501.",
    id: AGENT_ACTIONS.cameraPan,
    params: [NUM("deltaX", "Horizontal CSS pixels within [-100000, 100000]."), NUM("deltaY", "Vertical CSS pixels within [-100000, 100000].")],
  },
  {
    description: "Reset the current projection to the home view.",
    id: AGENT_ACTIONS.cameraReset,
    params: [],
  },
  {
    description: "Show or hide a layer.",
    id: AGENT_ACTIONS.layerVisibility,
    params: [NUM("layerId", "Layer id."), BOOL("active", "True to show.")],
  },
  {
    description: "Set a layer opacity between 0 and 1.",
    id: AGENT_ACTIONS.layerOpacity,
    params: [NUM("layerId", "Layer id."), NUM("alpha", "Opacity in [0, 1].")],
  },
  {
    description: "Show or hide a layer group.",
    id: AGENT_ACTIONS.layerGroupVisibility,
    params: [NUM("groupId", "Group id."), BOOL("active", "True to show.")],
  },
  { description: "Add an independent Point, Line or Polygon from its selected synthetic fixture, or Raster/Atlas from the existing local manifest. Vector source coordinates only; service-backed vector sources and reconstruction are not implemented by this binding.", id: AGENT_ACTIONS.layerAdd, params: [OBJ("layer", "Layer name, type, sourceRef, groupId, active, alpha and optional Raster rasterId.")] },
  { description: "Release a non-default Point, Line, Polygon, Raster or Atlas instance and confirm its removal frame before removing its project record. Default runtime layers cannot be removed by this operation.", id: AGENT_ACTIONS.layerRemove, params: [NUM("layerId", "Instance to remove.")] },
  { description: "Retry a failed supported Point, Line, Polygon, Raster or Atlas instance, preserving its project identity and settings. Includes default Raster/Atlas; excludes the GPU point and plate model paths. Confirms owned cleanup and the replacement or hidden frame.", id: AGENT_ACTIONS.layerRetry, params: [NUM("layerId", "Failed instance to retry.")] },
  { description: "Update an ordinary Point (singleColor/pointSize), Line (lineColor/lineWidth) or Polygon (fillColor/outlineColor/outlineWidth) instance. Fields cannot be mixed between types. GPU point expressions keep their existing points.setStyle action. This commits style state and requests rendering, without waiting for a frame.", id: AGENT_ACTIONS.layerSetStyle, params: [NUM("layerId", "Ordinary Point, Line or Polygon instance."), OBJ("style", "Nonempty patch with fields matching the layer type.")] },
  { description: "Add a project layer group with an optional parent.", id: AGENT_ACTIONS.layerGroupAdd, params: [OBJ("group", "Group name, active, alpha, collapsed and optional parentId.")] },
  { description: "Move a group into a parent, or omit parentId to move to the root.", id: AGENT_ACTIONS.layerGroupMove, params: [NUM("groupId", "Group to move."), NUM("parentId", "New parent group; omitted means root.", false)] },
  { description: "Remove an empty group. Groups containing layers or child groups must first be emptied.", id: AGENT_ACTIONS.layerGroupRemove, params: [NUM("groupId", "Group to remove.")] },
  {
    description: "Set a layer group opacity between 0 and 1.",
    id: AGENT_ACTIONS.layerGroupOpacity,
    params: [NUM("groupId", "Group id."), NUM("alpha", "Opacity in [0, 1].")],
  },
  {
    description: "Collapse or expand a layer group.",
    id: AGENT_ACTIONS.layerGroupCollapse,
    params: [NUM("groupId", "Group id."), BOOL("collapsed", "True to collapse.")],
  },
  {
    description:
      "Reorder layers by their full ordered id list. `groupIdByLayer` is optional and moves a layer between groups while reordering, exactly like a drag-and-drop in the sidebar.",
    id: AGENT_ACTIONS.layerOrder,
    params: [
      ARR("orderedIds", "Every layer id, in the new order."),
      OBJ(
        "groupIdByLayer",
        "Optional map of layer id to target group id (101 data, 102 reconstruction).",
        false,
      ),
    ],
  },
  {
    description: "Move a layer into another group without reordering.",
    id: AGENT_ACTIONS.layerMoveToGroup,
    params: [NUM("layerId", "Layer id."), NUM("groupId", "Target group id.")],
  },
  {
    description: "Load the selected point dataset.",
    id: AGENT_ACTIONS.pointsLoad,
    params: [],
  },
  {
    description: "Unload the point dataset.",
    id: AGENT_ACTIONS.pointsUnload,
    params: [],
  },
  {
    description: "Open the dataset upload wizard. Requires the V2 ingest endpoints.",
    id: AGENT_ACTIONS.uploadOpen,
    params: [],
  },
  { description: "Close the dataset upload wizard.", id: AGENT_ACTIONS.uploadClose, params: [] },
  {
    description:
      "Run the dataset ingest. The source file may be passed directly as a browser File/Blob, so no DOM interaction is required. Requires the V2 ingest endpoints.",
    id: AGENT_ACTIONS.uploadRun,
    params: [
      OBJ("file", "Browser File or Blob holding the CSV/TSV/TXT payload.", false),
      STR("name", "Dataset name.", false),
      STR("description", "Dataset description.", false),
      NUM("plateModelId", "Plate model the dataset binds to.", false),
      OBJ("mapping", "Column mapping override.", false),
    ],
  },
  {
    description: "Cancel the running ingest job. Requires the V2 ingest endpoints.",
    id: AGENT_ACTIONS.uploadCancel,
    params: [],
  },
  { description: "Switch the sidebar tab.", id: AGENT_ACTIONS.sidebarSelect, params: [STR("tab", "'layers' or 'plate-models'.")] },
  {
    description: "Show or hide the sidebar. The sidebar stays mounted; hiding it only removes it from view and from the tab order, and the map uses the freed width.",
    id: AGENT_ACTIONS.sidebarSetVisible,
    params: [BOOL("visible", "True to show the sidebar.")],
  },
  {
    description: "Open or close the collapsed add-layer panel, optionally selecting one of the six layer kinds.",
    id: AGENT_ACTIONS.addPanelSetVisible,
    params: [
      BOOL("visible", "True to show the add panel."),
      STR("kind", "Optional kind: 'group', 'point', 'line', 'polygon', 'raster' or 'atlas'.", false),
    ],
  },
  {
    description: "Show or hide the welcome panel. It is closed by default and never covers the map until it is opened.",
    id: AGENT_ACTIONS.welcomeSetVisible,
    params: [BOOL("visible", "True to show the welcome panel.")],
  },
  {
    description: "Show or hide the development console. Retained output survives closing it.",
    id: AGENT_ACTIONS.consoleSetVisible,
    params: [BOOL("visible", "True to show the console.")],
  },
  {
    description: "Clear the retained console output. A running job keeps running; use jobs cancel to request cancellation.",
    id: AGENT_ACTIONS.consoleClear,
    params: [],
  },
  {
    description: "Focus and select the retained console output for copying. Fails when the console is closed or has no output.",
    id: AGENT_ACTIONS.consoleSelectOutput,
    params: [],
  },
  {
    description: "Filter the sidebar layer list by a substring.",
    id: AGENT_ACTIONS.layerSearchSet,
    params: [STR("query", "Substring to match; empty clears the filter.")],
  },
  {
    description: "Open a layer's inline style panel and select it.",
    id: AGENT_ACTIONS.layerStyleOpen,
    params: [NUM("layerId", "Layer id to select.", false)],
  },
  {
    description: "Close the inline layer style panel.",
    id: AGENT_ACTIONS.layerStyleClose,
    params: [],
  },
  {
    description: "Show or hide the account menu in the top bar.",
    id: AGENT_ACTIONS.accountMenuSetVisible,
    params: [BOOL("visible", "True to show the menu.")],
  },
  {
    description:
      "Toggle the account menu, opening the sign-in dialog when signed out.",
    id: AGENT_ACTIONS.accountMenuToggle,
    params: [],
  },
  {
    description: "Switch the sign-in dialog between account/password and email code.",
    id: AGENT_ACTIONS.authModeSet,
    params: [STR("mode", "'account' or 'email-code'.")],
  },
  {
    description: "Select a workspace module from the toolbar.",
    id: AGENT_ACTIONS.moduleSelect,
    params: [STR("module", "One of the module labels shown in the toolbar.")],
  },
  {
    description: "Rename the project draft.",
    id: AGENT_ACTIONS.projectSetName,
    params: [STR("name", "New project name.")],
  },
  {
    description: "Select the local benchmark point dataset, optionally loading it.",
    id: AGENT_ACTIONS.pointsSelectDataset,
    params: [
      STR("datasetId", "Dataset id from the point-data manifest."),
      BOOL("load", "True to start loading immediately."),
    ],
  },
  {
    description: "Set the point size in pixels.",
    id: AGENT_ACTIONS.pointsSetSize,
    params: [NUM("pointSize", "Point size in pixels.")],
  },
  {
    description:
      "Set the point layer style expression (colorMode, sizeMode, pointSize, shape, singleColor, filter).",
    id: AGENT_ACTIONS.pointsSetStyle,
    params: [OBJ("style", "Partial point style expression.")],
  },
  {
    description: "Select a raster instance's source by id. Omit layerId for the original raster layer.",
    id: AGENT_ACTIONS.rasterSelect,
    params: [STR("rasterId", "Raster id from the single-raster manifest."), NUM("layerId", "Raster layer instance; defaults to the original raster layer.", false)],
  },
  {
    description: "Go back one step in the upload wizard.",
    id: AGENT_ACTIONS.uploadBack,
    params: [STR("step", "'select', 'map' or 'run'.", false)],
  },
  {
    description: "The main menu (☰) is not implemented; the button is a placeholder.",
    id: AGENT_ACTIONS.uiMenuToggle,
    params: [],
  },
  {
    description: "Settings (⚙) is not implemented; the button is a placeholder.",
    id: AGENT_ACTIONS.uiSettingsOpen,
    params: [],
  },
  {
    description: "Information (ⓘ) is not implemented; the button is a placeholder.",
    id: AGENT_ACTIONS.uiInfoOpen,
    params: [],
  },
  {
    description: "Notifications (♟) is not implemented; the button is a placeholder.",
    id: AGENT_ACTIONS.uiNotificationsOpen,
    params: [],
  },
  {
    description:
      "Place search is not implemented; the input is a placeholder with no globe lookup behind it.",
    id: AGENT_ACTIONS.placeSearch,
    params: [STR("query", "Place name to look up.")],
  },
  {
    description:
      "Major cities is not implemented; the checkbox is a placeholder with no dataset behind it.",
    id: AGENT_ACTIONS.majorCitiesSetVisible,
    params: [BOOL("visible", "True to show major cities.")],
  },
  { description: "Open the sign-in dialog.", id: AGENT_ACTIONS.authDialogOpen, params: [] },
  { description: "Close the sign-in dialog.", id: AGENT_ACTIONS.authDialogClose, params: [] },
  { description: "Collapse or expand the module toolbar.", id: AGENT_ACTIONS.toolbarToggle, params: [] },
  {
    description: "Publishing is not implemented; the button is a placeholder.",
    id: AGENT_ACTIONS.publishPlaceholder,
    params: [],
  },
  {
    description: "Export is not implemented; the button is a placeholder.",
    id: AGENT_ACTIONS.exportPlaceholder,
    params: [],
  },
];

/**
 * Controls that exist in the UI but have no implementation behind them. They are
 * declared as unsupported from the start, so `listActions()` and `execute()`
 * both say so instead of advertising a feature that does not exist.
 */
const PLACEHOLDER_ACTION_IDS: readonly AgentActionId[] = [
  AGENT_ACTIONS.exportPlaceholder,
  AGENT_ACTIONS.majorCitiesSetVisible,
  AGENT_ACTIONS.placeSearch,
  AGENT_ACTIONS.publishPlaceholder,
  AGENT_ACTIONS.uiInfoOpen,
  AGENT_ACTIONS.uiMenuToggle,
  AGENT_ACTIONS.uiNotificationsOpen,
  AGENT_ACTIONS.uiSettingsOpen,
];

/** Lookup by id, so a UI handler can be attached without repeating the shape. */
export const AGENT_DECLARATIONS: Readonly<
  Record<AgentActionId, AgentActionDefinition>
> = Object.fromEntries(
  DECLARATIONS.map((declaration) => [
    declaration.id,
    {
      description: declaration.description,
      id: declaration.id,
      params: declaration.params,
      status: PLACEHOLDER_ACTION_IDS.includes(declaration.id)
        ? "unsupported"
        : "ready",
      title: AGENT_ACTION_TITLES[declaration.id],
    },
  ]),
) as Readonly<Record<AgentActionId, AgentActionDefinition>>;

for (const definition of Object.values(AGENT_DECLARATIONS)) {
  agentActions.register(definition);
  agentActions.setContract(definition.id, actionContractMetadata(definition.id), async () => {
    const { actionContractDetails } = await import("./action-schemas");
    return actionContractDetails(definition);
  });
}

/**
 * Re-declares an action as unsupported and drops any handler attached to it,
 * so `listActions()` stays an honest description of what this build can do
 * (for example on a Server that only speaks V1).
 */
export function declareUnsupported(
  id: AgentActionId,
  reason: string,
): void {
  agentActions.register({
    ...AGENT_DECLARATIONS[id],
    description: reason,
    status: "unsupported",
  });
}
