import type { ApiSchema } from "../agent-actions/contracts";

export const layerGroupInputSchema: ApiSchema = {
  type: "object", additionalProperties: false,
  required: ["name", "active", "alpha", "collapsed"],
  properties: {
    name: { type: "string", minLength: 1 }, active: { type: "boolean" },
    alpha: { type: "number", minimum: 0, maximum: 1 }, collapsed: { type: "boolean" },
    parentId: { type: "integer", minimum: 1 },
  },
};
