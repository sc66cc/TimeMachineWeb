import { basicContractDetails, type ApiSchema, type ApiContractDetails } from "./contracts";
import type { AgentActionDefinition } from "./types";
import { POINT_SIZE_MIN_PIXELS, POINT_SIZE_MAX_PIXELS } from "@timemachine/point-runtime";
import { layerGroupInputSchema } from "../layers/group-action-schema";
import { layerInstanceInputSchema } from "../layers/instance-action-schema";
import { NATIVE_LINE_WIDTH_MIN, NATIVE_LINE_WIDTH_MAX } from "../layers/native-line-style";
import { NATIVE_POLYGON_OUTLINE_WIDTH_MIN, NATIVE_POLYGON_OUTLINE_WIDTH_MAX } from "../layers/native-polygon-style";

const number: ApiSchema = { type: "number" };
const positiveId: ApiSchema = { type: "integer", minimum: 1 };
const enumString = (...values: string[]): ApiSchema => ({ type: "string", enum: values });
const exactObject = (properties: Record<string, ApiSchema>, description?: string): ApiSchema => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false,
  ...(description ? { description } : {}),
});
const pointStyle: ApiSchema = {
  type: "object", additionalProperties: false, properties: {
    colorMode: enumString("plate", "occurrence", "single"),
    sizeMode: enumString("fixed", "occurrence"),
    pointSize: { type: "number", minimum: POINT_SIZE_MIN_PIXELS, maximum: POINT_SIZE_MAX_PIXELS },
    occurrenceSizeScale: { type: "number", minimum: 0, maximum: 4 },
    schemaVersion: { type: "integer", enum: [1] },
    shape: enumString("circle", "square"),
    singleColor: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
    filter: { type: "object", additionalProperties: false, properties: {
      plateId: { type: ["integer", "null"], minimum: 0, maximum: 65535 },
      minimumOccurrence: { type: "number", minimum: 0, maximum: 65535 },
      maximumOccurrence: { type: "number", minimum: 0, maximum: 65535 },
    } },
  },
};

/** Extend the existing parameter declarations, rather than duplicate their ids. */
export function actionContractDetails(definition: AgentActionDefinition): ApiContractDetails {
  const result = basicContractDetails(definition);
  const properties = result.inputSchema.properties!;
  for (const key of ["layerId", "groupId", "parentId", "plateModelId", "versionId", "datasetVersionId", "revisionId"]) {
    if (properties[key]) properties[key] = { ...properties[key], ...positiveId };
  }
  if (properties.alpha) properties.alpha = { ...properties.alpha, minimum: 0, maximum: 1 };
  switch (definition.id) {
    case "project.saveLocal":
      result.outputSchema = exactObject({ savedAt: { type: "string" }, revision: { type: "integer", minimum: 0 } });
      break;
    case "project.exportOriginal":
      properties.source = enumString("current", "review");
      result.outputSchema = exactObject({ downloadStarted: { type: "boolean", enum: [true] }, bytes: { type: "integer", minimum: 0 } });
      break;
    case "layer.setStyle": {
      const nativeStyle: ApiSchema = { type: "object", additionalProperties: false, properties: {
        singleColor: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
        pointSize: { type: "number", minimum: POINT_SIZE_MIN_PIXELS, maximum: POINT_SIZE_MAX_PIXELS },
      } };
      const lineStyle: ApiSchema = { type: "object", additionalProperties: false, properties: {
        lineColor: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
        lineWidth: { type: "number", minimum: NATIVE_LINE_WIDTH_MIN, maximum: NATIVE_LINE_WIDTH_MAX },
      } };
      const polygonStyle: ApiSchema = { type: "object", additionalProperties: false, properties: {
        fillColor: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
        outlineColor: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
        outlineWidth: { type: "number", minimum: NATIVE_POLYGON_OUTLINE_WIDTH_MIN, maximum: NATIVE_POLYGON_OUTLINE_WIDTH_MAX },
      } };
      properties.style = { oneOf: [nativeStyle, lineStyle, polygonStyle], description: "Nonempty patch for the target type: Point singleColor/pointSize; Line lineColor/lineWidth; Polygon fillColor/outlineColor/outlineWidth. Types cannot be mixed. Stored styles are validated before applying the patch." };
      result.outputSchema = exactObject({ layerId: positiveId, style: { oneOf: [
        { ...nativeStyle, required: ["singleColor", "pointSize"] }, { ...lineStyle, required: ["lineColor", "lineWidth"] },
        { ...polygonStyle, required: ["fillColor", "outlineColor", "outlineWidth"] },
      ] } });
      result.examples = [{ input: { layerId: 103, style: { singleColor: "#12abef", pointSize: 4 } }, output: { layerId: 103, style: { singleColor: "#12abef", pointSize: 4 } } }];
      break;
    }
    case "layer.add":
      properties.layer = layerInstanceInputSchema;
      result.outputSchema = exactObject({ layerId: positiveId, sourceRef: { type: "string" }, frameConfirmed: { type: "boolean", enum: [true] } });
      result.examples = [{ input: { layer: { name: "Sample points", type: 0, sourceRef: "fixture:goal-points-v1", groupId: 101, active: true, alpha: 1 } }, output: { layerId: 103, sourceRef: "fixture:goal-points-v1", frameConfirmed: true } }];
      break;
    case "layer.remove":
      result.outputSchema = exactObject({ layerId: positiveId, removed: { type: "boolean", enum: [true] }, frameConfirmed: { type: "boolean", enum: [true] } });
      result.examples = [{ input: { layerId: 103 }, output: { layerId: 103, removed: true, frameConfirmed: true } }];
      break;
    case "layer.retry":
      result.outputSchema = exactObject({ layerId: positiveId, sourceRef: { type: "string" }, frameConfirmed: { type: "boolean", enum: [true] } });
      result.examples = [{ input: { layerId: 103 }, output: { layerId: 103, sourceRef: "fixture:goal-points-v1", frameConfirmed: true } }];
      break;
    case "layer.group.setVisibility":
      result.outputSchema = exactObject({ groupId: positiveId, active: { type: "boolean" }, effective: { type: "boolean", description: "Visibility after all ancestor groups are applied." } });
      break;
    case "layer.group.setOpacity":
      result.outputSchema = exactObject({ groupId: positiveId, alpha: { type: "number", minimum: 0, maximum: 1 }, effective: { type: "number", minimum: 0, maximum: 1, description: "Product of this group's alpha and all ancestor group alphas." } });
      break;
    case "layer.group.add": case "layer.group.move": {
      if (definition.id === "layer.group.add") properties.group = layerGroupInputSchema;
      result.outputSchema = exactObject({ groupId: positiveId, group: {
        ...layerGroupInputSchema,
        required: [...layerGroupInputSchema.required!, "id"],
        properties: { ...layerGroupInputSchema.properties, id: positiveId },
      } });
      result.examples = definition.id === "layer.group.add"
        ? [{ input: { group: { name: "Observations", active: true, alpha: 1, collapsed: false } }, output: { groupId: 103, group: { id: 103, name: "Observations", active: true, alpha: 1, collapsed: false } } }]
        : [
          { input: { groupId: 103, parentId: 101 }, output: { groupId: 103, group: { id: 103, name: "Observations", active: true, alpha: 1, collapsed: false, parentId: 101 } } },
          { input: { groupId: 103 }, output: { groupId: 103, group: { id: 103, name: "Observations", active: true, alpha: 1, collapsed: false } } },
        ];
      break;
    }
    case "layer.group.remove":
      result.outputSchema = exactObject({ groupId: positiveId, removed: { type: "boolean", enum: [true] } });
      result.examples = [{ input: { groupId: 103 }, output: { groupId: 103, removed: true } }];
      break;
    case "time.set": properties.ageMa = { ...number, minimum: 0 }; break;
    case "time.setSpeed": properties.speedMaPerSecond = { ...number, exclusiveMinimum: 0 }; break;
    case "camera.zoom": properties.factor = { ...number, minimum: 0.01, maximum: 100 }; break;
    case "camera.pan":
      properties.deltaX = properties.deltaY = { ...number, minimum: -100000, maximum: 100000 };
      break;
    case "projection.select": properties.projectionId = enumString("globe", "rectangle", "mollweide"); break;
    case "auth.login": case "ui.authMode.set": properties.mode = enumString("account", "email-code"); break;
    case "model.select": properties.source = enumString("shared", "v2", "local-demo"); break;
    case "ui.sidebar.select": properties.tab = enumString("layers", "plate-models"); break;
    case "ui.upload.back": properties.step = enumString("select", "map", "run"); break;
    case "layer.setOrder":
      properties.orderedIds = { type: "array", items: positiveId };
      properties.groupIdByLayer = { type: "object", additionalProperties: positiveId };
      break;
    case "points.setStyle": properties.style = pointStyle; break;
    case "points.setSize": properties.pointSize = { ...number, minimum: POINT_SIZE_MIN_PIXELS, maximum: POINT_SIZE_MAX_PIXELS }; break;
    case "points.load": case "points.selectDataset":
      result.outputSchema = {
        type: "object", additionalProperties: false,
        required: ["datasetId", "loaded", "selectedDatasetId", "frameConfirmed"],
        properties: {
          datasetId: { type: "string" }, loaded: { type: "boolean" },
          selectedDatasetId: { type: "string" }, loadedDatasetId: { type: "string" },
          frameConfirmed: { type: "boolean", description: "True only when this request loaded a candidate and confirmed its native visible or hidden frame; selection-only requests return false." },
        },
      };
      break;
    case "project.setName": properties.name = { type: "string", minLength: 1 }; break;
    case "raster.select":
      properties.layerId = { type: "integer", minimum: 1, description: "Raster instance; omit for the original layer." };
      result.outputSchema = {
        type: "object", additionalProperties: false, required: ["rasterId", "selection"], properties: {
          layerId: { type: "integer", minimum: 1 },
          rasterId: { type: "string", description: "Requested raster ID; a hidden selection does not commit this source." },
          selection: {
            type: "object", additionalProperties: false, required: ["generation", "requestedRasterId", "status"],
            description: "ready includes rasterId and sourceId after the target source renders. hidden includes reason=disabled and no displayed-source fields.",
            properties: {
              generation: { type: "integer", minimum: 0 }, requestedRasterId: { type: "string" },
              status: enumString("ready", "hidden"), rasterId: { type: "string" }, sourceId: { type: "string" },
              reason: enumString("disabled"),
            },
          },
        },
      };
      break;
  }
  // These schemas describe result.data from the existing handlers. Examples
  // use synthetic inputs; state-dependent outputs name their starting state.
  switch (definition.id) {
    case "time.set":
      result.outputSchema = exactObject({
        ageMa: { type: "number", minimum: 0, description: "Requested age in Ma." },
        committedAgeMa: { type: "number", minimum: 0, description: "Actual committed timeline age after the shared frame operation completes." },
      });
      result.examples = [{ precondition: "Age 50 Ma is within the current timeline range and required runtime layers can commit.",
        input: { ageMa: 50 }, output: { ageMa: 50, committedAgeMa: 50 } }];
      break;
    case "time.setPlaying":
      result.outputSchema = exactObject({ playing: { type: "boolean" } }, "Actual playback flag; this does not wait for future animation frames.");
      result.examples = [{ input: { playing: false }, output: { playing: false } }];
      break;
    case "time.setSpeed":
      result.outputSchema = exactObject({
        speedMaPerSecond: { type: "number", enum: [10, 25, 50], description: "Effective discrete playback preset in Ma per second." },
        requestedSpeedMaPerSecond: { type: "number", exclusiveMinimum: 0 },
      });
      result.examples = [{ input: { speedMaPerSecond: 12 }, output: { speedMaPerSecond: 10, requestedSpeedMaPerSecond: 12 } }];
      break;
    case "camera.reset": {
      const vector: ApiSchema = { type: "array", items: number, minItems: 3,
        description: "Exactly three finite scene-world components, in x/y/z order. The shared schema subset validates element types and the minimum length." };
      result.outputSchema = exactObject({
        projectionId: enumString("globe", "rectangle", "mollweide"),
        camera: exactObject({ position: vector, direction: vector, up: vector }),
      }, "Camera vectors read after the reset completion frame; coordinates are scene-world values for the returned projection, not longitude/latitude.");
      // The existing catalog example redaction bounds truncate arrays nested
      // under output.camera. Keep an input example rather than a false payload.
      result.examples = [{ precondition: "A projection is committed and its camera runtime is ready.", input: {},
        resultDescription: "After completion, data contains projectionId and camera.position/direction/up as three-component vectors, described by outputSchema." }];
      break;
    }
    case "camera.zoom":
      result.outputSchema = exactObject({
        mode: enumString("rectangle", "mollweide"),
        factor: { type: "number", exclusiveMinimum: 0, description: "Actual new view width divided by the prior width; may differ from the requested factor after clamping." },
        width: { type: "number", exclusiveMinimum: 0, description: "Resulting flat view width in scene metres." },
      }, "Actual flat-camera result after clamping. Globe has no successful pan/zoom result.");
      result.examples = [{ precondition: "Rectangle is already at its minimum view width of 1000 metres.",
        input: { factor: 0.5 }, output: { mode: "rectangle", factor: 1, width: 1000 } }];
      break;
    case "camera.pan":
      result.outputSchema = exactObject({
        mode: enumString("rectangle", "mollweide"),
        deltaX: { type: "number", minimum: -100000, maximum: 100000, description: "Requested horizontal drag in CSS pixels." },
        deltaY: { type: "number", minimum: -100000, maximum: 100000, description: "Requested vertical drag in CSS pixels." },
        width: { type: "number", exclusiveMinimum: 0, description: "Actual flat view width after the pan, in scene metres." },
      });
      result.examples = [{ precondition: "Mollweide is active with a view width of 1000 metres.",
        input: { deltaX: 12, deltaY: 8 }, output: { mode: "mollweide", deltaX: 12, deltaY: 8, width: 1000 } }];
      break;
    case "projection.select":
      result.outputSchema = exactObject({
        projectionId: enumString("globe", "rectangle", "mollweide"),
        revision: { type: "integer", minimum: 0, description: "Projection controller revision, distinct from the v2 result envelope's application-state revision." },
      });
      result.examples = [{ precondition: "Globe is already committed at projection revision 0 and the controller is ready.",
        input: { projectionId: "globe" }, output: { projectionId: "globe", revision: 0 } }];
      break;
    case "layer.setVisibility":
      result.outputSchema = exactObject({ layerId: positiveId, active: { type: "boolean" },
        effective: { type: "boolean", description: "Actual visibility after this layer and all ancestor groups are applied." } });
      result.examples = [{ precondition: "Layer 2 exists inside a hidden ancestor group.",
        input: { layerId: 2, active: true }, output: { layerId: 2, active: true, effective: false } }];
      break;
    case "layer.setOpacity":
      result.outputSchema = exactObject({ layerId: positiveId, alpha: { type: "number", minimum: 0, maximum: 1 },
        effective: { type: "number", minimum: 0, maximum: 1, description: "Layer alpha multiplied by every ancestor group's alpha." } });
      result.examples = [{ precondition: "Layer 2 exists and its ancestor group opacity product is 0.5.",
        input: { layerId: 2, alpha: 0.8 }, output: { layerId: 2, alpha: 0.8, effective: 0.4 } }];
      break;
    case "layer.group.setCollapsed":
      result.outputSchema = exactObject({ groupId: positiveId, collapsed: { type: "boolean" } });
      result.examples = [{ precondition: "Group 101 exists.", input: { groupId: 101, collapsed: true }, output: { groupId: 101, collapsed: true } }];
      break;
    case "layer.setGroup":
      result.outputSchema = exactObject({ layerId: positiveId, groupId: positiveId });
      result.examples = [{ precondition: "Layer 2 and target group 101 exist and the current projection permits the move.",
        input: { layerId: 2, groupId: 101 }, output: { layerId: 2, groupId: 101 } }];
      break;
    case "layer.setOrder":
      result.outputSchema = exactObject({
        orderedIds: { type: "array", items: positiveId, description: "Every current layer ID in its actual resulting order." },
        groupIdByLayer: { type: "object", additionalProperties: positiveId,
          description: "Complete resulting layer-to-group map, including unchanged assignments; keys are decimal layer IDs from orderedIds." },
      });
      result.examples = [{ precondition: "The default four layers exist in groups 101 (layers 1, 2, 3) and 102 (layer 4).",
        input: { orderedIds: [1, 2, 3, 4] }, output: { orderedIds: [1, 2, 3, 4], groupIdByLayer: { "1": 101, "2": 101, "3": 101, "4": 102 } } }];
      break;
    case "ui.sidebar.select":
      result.outputSchema = exactObject({ tab: enumString("layers", "plate-models") });
      result.examples = [{ input: { tab: "plate-models" }, output: { tab: "plate-models" } }];
      break;
    case "ui.authDialog.open": case "ui.authDialog.close":
      result.outputSchema = exactObject({}, "Empty result data; read ui.snapshot for the dialog state.");
      result.examples = [{ input: {}, output: {} }];
      break;
    case "ui.authMode.set":
      result.outputSchema = exactObject({ mode: enumString("account", "email-code") });
      result.examples = [{ input: { mode: "email-code" }, output: { mode: "email-code" } }];
      break;
    case "ui.toolbar.toggle":
      result.outputSchema = exactObject({ collapsed: { type: "boolean" } });
      result.examples = [{ precondition: "The toolbar is expanded.", input: {}, output: { collapsed: true } }];
      break;
    case "ui.accountMenu.toggle":
      result.outputSchema = exactObject({ accountMenuOpen: { type: "boolean" }, authDialogOpen: { type: "boolean" } });
      result.examples = [{ precondition: "No account is signed in.", input: {}, output: { accountMenuOpen: false, authDialogOpen: true } }];
      break;
    case "ui.accountMenu.setVisible":
      result.outputSchema = exactObject({ open: { type: "boolean" } }, "Actual menu state; requesting visible while signed out keeps the menu closed.");
      result.examples = [{ precondition: "No account is signed in.", input: { visible: true }, output: { open: false } }];
      break;
    case "ui.layerSearch.set":
      result.outputSchema = exactObject({ query: { type: "string" } });
      result.examples = [{ input: { query: "raster" }, output: { query: "raster" } }];
      break;
    case "ui.layerStyle.open":
      result.outputSchema = exactObject({ layerId: { type: ["integer", "null"], minimum: 1 } });
      result.examples = [{ precondition: "Layer 3 exists in the current layer list.", input: { layerId: 3 }, output: { layerId: 3 } }];
      break;
    case "ui.layerStyle.close":
      result.outputSchema = exactObject({ layerId: { type: "null" } });
      result.examples = [{ input: {}, output: { layerId: null } }];
      break;
    case "ui.module.select":
      result.outputSchema = exactObject({ module: enumString("Layer", "Atlas", "Database", "Multi Globe", "Project Market", "Area Tool") },
        "Selected toolbar label only. This does not load data or confirm that the named module's business features are implemented.");
      result.examples = [{ input: { module: "Atlas" }, output: { module: "Atlas" } }];
      break;
    case "ui.upload.back":
      result.outputSchema = exactObject({ step: enumString("select", "map", "run") });
      result.examples = [{ precondition: "Signed in with ingest capability, upload wizard open, and no ingest job running.",
        input: { step: "select" }, output: { step: "select" } }];
      break;
  }
  return result;
}
