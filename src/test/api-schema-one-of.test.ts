import { describe, expect, it } from "vitest";
import { validateApiInput, type ApiSchema } from "../agent-actions/contracts";

describe("mutually exclusive API schemas", () => {
  const schema = { oneOf: [
    { type: "object", properties: { color: { type: "string" } }, required: ["color"], additionalProperties: false },
    { type: "object", properties: { width: { type: "number", minimum: 1 } }, required: ["width"], additionalProperties: false },
  ] } as ApiSchema;
  it("requires exactly one matching shape without echoing invalid input", () => {
    expect(validateApiInput(schema, { color: "#ffffff" })).toBeUndefined();
    expect(validateApiInput(schema, { width: 2 })).toBeUndefined();
    for (const value of [{}, { width: 0 }, { color: "secret", width: 2 }, null]) {
      const error = validateApiInput(schema, value);
      expect(error).toBeDefined(); expect(error).not.toContain("secret");
    }
    expect(validateApiInput({ oneOf: [{ type: "number" }, { type: "integer" }] } as ApiSchema, 2)).toBeDefined();
  });
  it("also applies constraints on the containing schema", () => {
    expect(validateApiInput({ type: "number", minimum: 3, oneOf: [{ type: "integer" }, { type: "string" }] } as ApiSchema, 2)).toBeDefined();
  });
});
