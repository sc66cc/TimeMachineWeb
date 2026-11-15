import type { ApiContractDetails, ApiSchema } from "./contracts";

type ReservedDetails = ApiContractDetails & { description: string };

const plan = "docs/superpowers/plans/2026-11-14-p0-p3-goal/03-p2-p3-implementation.md, P2-05";
const selectionKey: ApiSchema = {
  type: "object", additionalProperties: false, required: ["viewportId", "layerId", "featureId"], properties: {
    viewportId: { type: "string", minLength: 1 }, layerId: { type: "integer", minimum: 1 },
    featureId: { type: "string", minLength: 1, description: "Stable source feature identity, not a transient array index." },
  },
};

// References document the existing wire types; they do not duplicate generated DTOs
// or import transports into the frontend catalog. None is an executable API schema.
const services: Record<string, { adapter: string; source: string; protocol: string; input: string; output: string; note: string }> = {
  "service.TimeMachinePlatform.GetCapabilities": {
    adapter: "TimeMachinePlatformRuntime.loadCapabilities", source: "packages/platform-runtime/src/index.ts",
    protocol: "TimeMachinePlatformInvoker.GetCapabilities through the existing RPC client",
    input: "Existing client sends TimeMachineClientType.Web and clientVersion; there is no v2 service input contract.",
    output: "Generated TimeMachineCapabilitiesRO; the adapter derives CapabilitySnapshot. This is a type reference, not a v2 output schema.",
    note: "Bootstrap already uses this internal adapter. No current server availability is inferred from its presence.",
  },
  "service.UserPlateModel.Display": {
    adapter: "SharedPlateModelClient.display", source: "src/plate-model/shared-plate-client.ts",
    protocol: "UserPlateModel.Display binary multipart _stream and response frame decoding",
    input: "Existing adapter accepts SharedPlateDisplayQuery (name, accessRangeMask, pageIndex, pageSize) and local request options; no v2 service input contract.",
    output: "Decoded PageRO<PlateModelSimpleRO>; a source type reference, not a v2 output schema.",
    note: "Public paginated catalog; an account is not required. Application catalog.refresh remains the existing state-aware entry.",
  },
  "service.UserPlateModel.DisplayMine": {
    adapter: "SharedPlateModelClient.displayMine", source: "src/plate-model/shared-plate-client.ts",
    protocol: "UserPlateModel.DisplayMine binary multipart empty _stream and response frame decoding",
    input: "Existing adapter takes local request options and uses the current account; no v2 service input contract.",
    output: "Decoded PlateModelSimpleRO[]; a source type reference, not a v2 output schema.",
    note: "Requires an authenticated account. Application catalog.refresh remains the existing state-aware entry.",
  },
  "service.UserPlateModel.GetDetail": {
    adapter: "SharedPlateModelClient.getDetail", source: "src/plate-model/shared-plate-client.ts",
    protocol: "UserPlateModel.GetDetail binary multipart _stream with Vi int64 identity and response frame decoding",
    input: "Existing adapter takes model id and local request options; no v2 service input contract.",
    output: "Decoded PlateModelRO; a source type reference, not a v2 output schema. Raw model payloads are not exposed by this catalog.",
    note: "Access remains subject to the existing service and resource permissions; no generic URL or RPC executor is provided.",
  },
};

// P3 fixes these identities and semantics, not every executable payload shape.
const p3: Record<string, { task: string; description: string; input: string; output: string }> = {
  "model.bind": {
    task: "P3-01 and section 3.1",
    description: "A viewport binding owns its modelRef/version and anchorPlateId. A layer defaults to inherit and may explicitly use a fixed complete binding; fixed overrides the viewport without silently replacing an unavailable model. Targeting viewportId changes the viewport, targeting layerId changes the layer policy; conflicting dual targets must be rejected. Reuse the existing reconstruction core, not a second model state store.",
    input: "Planned target: viewportId or layerId, modelRef/version, anchorPlateId and inherit/fixed policy where applicable. Exact nesting, conditional fields and validation remain unfrozen; this reserved input is not executable.",
    output: "Planned requested/committed binding and per-layer effectiveBinding with inherit/fixed provenance. The result schema remains unfrozen; a requested model is not a committed frame.",
  },
  "model.setAnchor": {
    task: "P3-01 and section 3.1",
    description: "Change the anchorPlateId of the explicitly targeted viewport or layer binding. Preserve inherit/fixed precedence and model/version identity. Do not silently alter both levels or another unlinked viewport. Reconstruct from original geometry through RotationModel.getRotationMap(ageMa, anchorPlateId).",
    input: "Planned viewportId or layerId target and anchorPlateId, with binding policy for layer overrides. Conflicting targets are invalid; the exact payload and valid anchor constraints must be finalized with the model adapter.",
    output: "Planned requested/committed anchor and effective binding provenance. No frame or successful model change is returned by this reserved entry.",
  },
  "viewport.create": {
    task: "P3-07",
    description: "Create an independently owned viewport, up to four total, initialized from current configuration and then independently bound. Each has an ID, projectionId, modelRef/version, anchorPlateId, camera and generation/committed state. Share immutable source data only; do not share native scene objects. Failure creating a fourth viewport must preserve the first three.",
    input: "Planned viewport configuration; exact fields, defaults and layout interaction remain unfrozen. The createViewport(config) method in the plan is not an executable facade schema.",
    output: "Planned new viewportId and actual creation/frame state, using existing v2 jobs where needed. Result payload and completion boundary must be finalized by P3-07; no viewport is created here.",
  },
  "viewport.close": {
    task: "P3-07 and section 3.3",
    description: "Close one viewport and release its listeners, tasks, native scene and exclusive resources while retaining sources used by other viewports. Closing a participant in an active linked operation records cancellation rather than silently removing it from the frozen participant set.",
    input: "Planned target viewport identity; exact field names and last-viewport policy remain unfrozen.",
    output: "Planned closed viewport identity and observable release result. No successful cleanup or memory release is fabricated by this reserved entry.",
  },
  "viewport.activate": {
    task: "P3-07",
    description: "Select the active existing viewport through the same state as the UI. Legacy camera calls default to the active viewport; explicit v2 targeting must remain independent. Activation is not proof that a model, projection or frame has changed.",
    input: "Planned target viewport identity; exact activation payload and unknown-target validation await the viewport implementation.",
    output: "Planned actual active viewport identity. The result schema remains unfrozen; no UI state changes here.",
  },
  "viewport.layout": {
    task: "P3-07 and section 3.3",
    description: "Support 1/2/4 viewport layouts, preserving independent bindings and selection. Linked operations freeze viewport/instance/generation participants; each viewport commits atomically, and partial success is reported as viewports-partially-committed after remaining participants settle. There is no cross-viewport rollback or false unified successful age.",
    input: "Planned layout and viewport configuration; layout encoding, sizes and create/close interaction remain unfrozen. Do not infer a stable numeric or string layout enum from this description.",
    output: "Planned actual viewport layout and bounded per-viewport committed state, at most four results. Reuse existing v2 result/job/event semantics; no alternate transaction protocol is introduced here.",
  },
  "camera.sync": {
    task: "P3-07",
    description: "Configure linked or independent cameras. Synchronize geographic center/region and scale through public native camera operations, not raw position vectors across different projections. Carry source viewport/revision or equivalent loop prevention so A-to-B cannot feed back indefinitely. Unlinked viewports remain unchanged; this does not implement currently missing Globe pan/zoom support.",
    input: "Planned synchronization participants and enabled/binding policy; exact field names and payload shape remain unfrozen.",
    output: "Planned actual synchronization configuration and observable final camera state. Configuration acceptance is not proof of future camera movement or frame completion.",
  },
  "raster.sample": {
    task: "P3-06",
    description: "Read-only sampling requires the existing authenticated data service or accessible original numeric values. Never infer scientific values from rendered RGBA. Use the source's fixed nearest/interpolation rule; convert target-viewport screen coordinates to geographic coordinates before sampling, and do not inverse-rotate a temporal Atlas twice. Source, selection, age or frame changes cancel or obsolete the result; delayed data must not appear as a new-frame success. No raster editing operation is exposed.",
    input: "The plan names viewportId, layerId, longitudeDeg, latitudeDeg and optional band. Coordinates are geographic degrees, not canvas pixels. Band encoding and the full executable validation schema remain unfrozen; this reserved query performs no service call.",
    output: "Planned SampleResult distinguishes value / nodata / outside / unavailable / error, with layerId, sourceRef, sourceVersion, band, unit, geographic coordinates, sampling method and actualFrameAgeMa where applicable. NoData is not zero. Exact discriminated payload shape remains unfrozen; missing original-value capability is unavailable, not a synthetic value.",
  },
  "viewports.snapshot": {
    task: "P3-07 and sections 3.1/3.3",
    description: "Read safe authoritative state for up to four viewports: identity, projection, model/version, anchor, camera, generation, requested/committed values and per-layer effectiveBinding provenance. Include linked versus independent time behavior; independent-time viewports are excluded from linked time participants. Each viewport reports its actual committed age, including partial-failure cases. No Viewer, Scene, credentials or signed URLs are exposed.",
    input: "Snapshot targeting/filter shape remains unfrozen; do not assume either an empty-only input or a specific viewportId filter is already supported.",
    output: "Planned bounded safe viewport state using existing bootId/revision and per-instance generations. Exact schema awaits the viewport owner; this reserved query does not return a fabricated single-view or empty snapshot.",
  },
};

/** Called only by catalog.describe after a dynamic import; no service or runtime imports. */
export function reservedContractDetails(id: string): ReservedDetails {
  if (Object.hasOwn(p3, id)) {
    const item = p3[id]!;
    return {
      description: `Planned contract from docs/superpowers/plans/2026-11-14-p0-p3-goal/03-p2-p3-implementation.md, ${item.task}; metadata only, not implemented or executable. ${item.description}`,
      inputSchema: { description: item.input }, outputSchema: { description: item.output }, examples: [],
    };
  }
  if (Object.hasOwn(services, id)) {
    const service = services[id]!;
    return {
      description: `Service metadata only. Existing adapter: ${service.adapter}; source: ${service.source}; protocol: ${service.protocol}. ${service.note} Generated contract provenance: packages/generated-api. Adapter existence does not make this ID callable through v2.`,
      inputSchema: { description: service.input }, outputSchema: { description: service.output }, examples: [],
    };
  }
  const description = `Planned contract from ${plan}; metadata only, with no handler attached. `;
  const outputSchema = { description: "The executable result contract must be finalized with the P2-05 implementation; no successful result is returned by this reserved entry." };
  switch (id) {
    case "feature.pick": return {
      description: description + "Pick from the committed target viewport using canvas CSS pixels, origin at top left; the adapter handles DPR. Geographic coordinates require a separate schema. Existing plate/GPU pick callbacks are not yet a unified feature API.",
      inputSchema: { description: "Target viewportId and canvas screen position in CSS pixels; the final input shape is reserved for P2-05." }, outputSchema, examples: [],
    };
    case "feature.select": return {
      description: description + "Select a stable viewport/layer/source feature identity, preserving the selection source. No Cesium object is exposed.",
      inputSchema: selectionKey, outputSchema, examples: [],
    };
    case "feature.clear": return {
      description: description + "Clear feature selection through the same selection owner used by the UI. Viewport targeting and result shape await that implementation.",
      inputSchema: { description: "P2-05 must finalize viewport targeting before this reserved command is executable." }, outputSchema, examples: [],
    };
    case "selection.snapshot": return {
      description: description + "Read authoritative feature selection with its viewport/layer identity and selection source. This is distinct from the resource selection section currently returned by scene.snapshot.",
      inputSchema: { description: "P2-05 must finalize selection query targeting." }, outputSchema, examples: [],
    };
    case "feature.attributes": return {
      description: description + "Read source attributes for a stable selection key, with bounded paging where needed; it is not a table editing command.",
      inputSchema: selectionKey, outputSchema, examples: [],
    };
    case "feature.queryBox": return {
      description: description + "Read only visible, pickable Point/Line/Polygon/PlateModel portions intersecting a committed viewport rectangle in CSS pixels. Clip to the canvas; an empty clipped rectangle yields no items. Exclude hidden, occluded backside and raster pixels. Default limit 100, maximum 500; sort by layerId/featureId, deduplicate seam copies and report truncation. Unknown viewport/layer or stale generation is an error, never an old-view success.",
      inputSchema: { type: "object", additionalProperties: false, required: ["viewportId", "rectangle"], properties: {
        viewportId: { type: "string", minLength: 1 },
        rectangle: { type: "object", additionalProperties: false, required: ["x", "y", "width", "height"], properties: {
          x: { type: "number" }, y: { type: "number" }, width: { type: "number", exclusiveMinimum: 0 }, height: { type: "number", exclusiveMinimum: 0 },
        } },
        layerIds: { type: "array", items: { type: "integer", minimum: 1 } },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Defaults to 100." },
      } },
      outputSchema: { type: "object", additionalProperties: false, required: ["viewportId", "revision", "items", "truncated"], properties: {
        viewportId: { type: "string", minLength: 1 }, revision: { type: "integer", minimum: 0 },
        items: { type: "array", items: selectionKey }, truncated: { type: "boolean" },
      } }, examples: [],
    };
    default: throw new Error("Unknown reserved contract.");
  }
}
