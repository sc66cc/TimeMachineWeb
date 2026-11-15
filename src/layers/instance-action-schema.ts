import type { ApiSchema } from "../agent-actions/contracts";

export const layerInstanceInputSchema: ApiSchema = {
  type: "object", additionalProperties: false,
  required: ["name", "type", "sourceRef", "groupId", "active", "alpha"],
  properties: {
    name: { type: "string", minLength: 1 },
    type: { type: "integer", minimum: 0, maximum: 5, description: "ProjectLayerType. This binding implements Point (0), Line (1), Polygon (2), Raster (3) and Atlas (4) with matching sources. Other types return unsupported." },
    sourceRef: { type: "string", minLength: 1, description: "Vectors use explicit synthetic fixture:goal-points-v1, fixture:goal-lines-v1 or fixture:goal-polygons-v1. Raster uses local:single-raster-manifest; Atlas uses local:paleoatlas-manifest and the shared viewport age. Unimplemented references and mismatched layer types return unsupported; no service fallback." },
    rasterId: { type: "string", minLength: 1, description: "Optional for Raster only: a nonblank ID in the selected manifest, validated before creation. Omission uses the adapter's compatible default. Explicit use on any non-Raster layer is a validation error." },
    groupId: { type: "integer", minimum: 1 }, active: { type: "boolean" },
    alpha: { type: "number", minimum: 0, maximum: 1 },
  },
};
