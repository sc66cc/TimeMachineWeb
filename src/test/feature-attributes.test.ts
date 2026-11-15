import { describe, expect, it, vi } from "vitest";
import { AgentActionValidationError } from "../agent-actions/registry";
import {
  FEATURE_ATTRIBUTE_LIMITS,
  summarizeFeatureAttributes,
} from "../layers/feature-attributes";

describe("bounded feature attribute projection", () => {
  it("preserves null and reports only requested missing fields", () => {
    expect(summarizeFeatureAttributes(null)).toEqual({ attributes: null, truncated: false, missingFields: [] });
    expect(summarizeFeatureAttributes(null, { fields: ["name"] })).toEqual({
      attributes: null, truncated: false, missingFields: ["name"],
    });
  });

  it("copies selected own values without touching unselected attributes or prototypes", () => {
    const getter = vi.fn(() => { throw new Error("must not read"); });
    const input = Object.create({ inherited: 9 }) as Record<string, unknown>;
    input.name = "Sample";
    input.count = 0;
    Object.defineProperty(input, "unused", { enumerable: true, get: getter });
    Object.defineProperty(input, "privateName", { value: "own", enumerable: false });
    expect(summarizeFeatureAttributes(input, { fields: ["count", "name", "inherited", "privateName"] })).toEqual({
      attributes: { count: 0, name: "Sample", privateName: "own" },
      truncated: false,
      missingFields: ["inherited"],
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it("returns an independent JSON-safe result and does not mutate the source", () => {
    const input = { nested: { label: "original" }, list: [true, null, 3] };
    const result = summarizeFeatureAttributes(input);
    expect(result).toEqual({ attributes: input, truncated: false, missingFields: [] });
    const output = result.attributes?.nested as Record<string, unknown>;
    output.label = "changed";
    expect(input.nested.label).toBe("original");
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("exports fixed engineering output budgets", () => {
    expect(FEATURE_ATTRIBUTE_LIMITS).toEqual({
      topLevelFields: 32, fieldNameLength: 128, depth: 4,
      arrayLength: 32, visitedNodes: 512, stringLength: 2048,
    });
    expect(Object.isFrozen(FEATURE_ATTRIBUTE_LIMITS)).toBe(true);
  });

  it("caps default fields, but explicit projection omission is not truncation", () => {
    const input = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`f${index}`, index]));
    const result = summarizeFeatureAttributes(input);
    expect(Object.keys(result.attributes ?? {})).toHaveLength(32);
    expect(result.truncated).toBe(true);
    expect(summarizeFeatureAttributes(input, { fields: ["f99"] })).toEqual({
      attributes: { f99: 99 }, truncated: false, missingFields: [],
    });
    expect(summarizeFeatureAttributes(input, { fields: [] })).toEqual({
      attributes: {}, truncated: false, missingFields: [],
    });
  });

  it.each([
    null, [], { extra: true }, { fields: null }, { fields: "name" },
    { fields: [1] }, { fields: [""] }, { fields: ["   "] },
    { fields: ["name", "name"] }, { fields: ["x".repeat(129)] },
    { fields: Array.from({ length: 33 }, (_, index) => `f${index}`) },
  ])("rejects malformed options before looking at attributes: %j", (options) => {
    const read = vi.fn(() => 1);
    const input = Object.defineProperty({}, "name", { get: read });
    expect(() => summarizeFeatureAttributes(input, options as never)).toThrow(AgentActionValidationError);
    expect(read).not.toHaveBeenCalled();
  });

  it("does not execute accessors in options or the fields array", () => {
    const read = vi.fn(() => ["name"]);
    const options = Object.defineProperty({}, "fields", { get: read });
    expect(() => summarizeFeatureAttributes({}, options)).toThrow(AgentActionValidationError);
    const fields = ["name"];
    Object.defineProperty(fields, "0", { get: read });
    expect(() => summarizeFeatureAttributes({}, { fields })).toThrow(AgentActionValidationError);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([null, {}])("rejects unsafe requested names instead of echoing them via missingFields: %j", (input) => {
    for (const field of ["https://example.invalid/private?key=fixture", "Bearer fixture", "password=fixture"]) {
      expect(() => summarizeFeatureAttributes(input, { fields: [field] })).toThrow(AgentActionValidationError);
      try {
        summarizeFeatureAttributes(input, { fields: [field] });
      } catch (error) {
        expect(String(error)).not.toContain("fixture");
      }
    }
  });

  it("keeps present getters distinct from absent fields and redacts secret getters", () => {
    const read = vi.fn(() => { throw new Error("getter executed"); });
    const input = Object.defineProperties({}, {
      label: { enumerable: true, get: read },
      accessToken: { enumerable: true, get: read },
    });
    expect(summarizeFeatureAttributes(input, { fields: ["label", "accessToken", "missing"] })).toEqual({
      attributes: { label: "[unavailable:accessor]", accessToken: "[redacted]" },
      truncated: true, missingFields: ["missing"],
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("redacts secret fields and URLs, bearer, basic, labelled and JWT-like strings", () => {
    const result = summarizeFeatureAttributes({
      token: { inaccessible: true }, api_key: "fixture", passwd: "fixture",
      nested: { password: "fixture" },
      url: "https://example.invalid/private?key=fixture",
      relative: "/tiles?key=fixture", query: "?key=fixture",
      bearer: "Bearer fixture", basic: "Basic fixture",
      labelled: "Authorization: Bearer fixture; name=sample",
      jwt: "eyJfixture.fixture.fixture",
    });
    expect(result.attributes).toMatchObject({
      token: "[redacted]", api_key: "[redacted]", passwd: "[redacted]",
      nested: { password: "[redacted]" }, url: "[redacted]",
      relative: "[redacted]", query: "[redacted]", bearer: "[redacted]", basic: "[redacted]",
      labelled: "Authorization: [redacted]; name=sample", jwt: "[redacted]",
    });
    expect(JSON.stringify(result)).not.toContain("fixture");
    expect(result.truncated).toBe(true);
  });

  it("bounds strings both before redaction and after expanding replacements", () => {
    const result = summarizeFeatureAttributes({ long: "x".repeat(1_000_000), expands: "token=x ".repeat(1000) });
    expect(result.attributes?.long).toHaveLength(2048);
    expect(result.attributes?.expands).toHaveLength(2048);
    expect(result.truncated).toBe(true);
  });

  it("redacts JWT-like prefixes even when the text limit cuts off later segments", () => {
    const result = summarizeFeatureAttributes({
      payload: "eyJfixture." + "x".repeat(3000) + ".signature",
      header: "eyJ" + "x".repeat(3000) + ".payload.signature",
    });
    expect(result.attributes).toEqual({ payload: "[redacted]", header: "[redacted]" });
    expect(result.truncated).toBe(true);
  });

  it("redacts quoted sensitive labels in JSON-like attribute text", () => {
    const result = summarizeFeatureAttributes({
      note: '{"password":"fixture", "label":"ordinary"}',
      cut: '{"password":"' + "fixture".repeat(1000),
    });
    expect(result.attributes?.note).not.toContain("fixture");
    expect(result.attributes?.note).toContain("ordinary");
    expect(result.attributes?.cut).not.toContain("fixture");
    expect(result.truncated).toBe(true);
  });

  it("does not return oversized or unsafe property names", () => {
    const result = summarizeFeatureAttributes({
      ["x".repeat(1_000_000)]: "large name", good: 1,
      nested: { ["y".repeat(129)]: 2, safe: 3 },
      "https://example.invalid/private": 4,
    });
    expect(result).toEqual({ attributes: { good: 1, nested: { safe: 3 } }, truncated: true, missingFields: [] });
  });

  it("marks cycles but copies repeated non-cyclic references", () => {
    const shared = { name: "same" };
    const input: Record<string, unknown> = { first: shared, second: shared };
    input.self = input;
    expect(summarizeFeatureAttributes(input)).toEqual({
      attributes: { first: shared, second: shared, self: "[circular]" }, truncated: true, missingFields: [],
    });
  });

  it("bounds container depth at four without reading deeper values", () => {
    const read = vi.fn(() => "not read");
    const deep = Object.defineProperty({}, "hidden", { enumerable: true, get: read });
    expect(summarizeFeatureAttributes({ a: { b: { c: { d: deep, value: 4 } } } })).toEqual({
      attributes: { a: { b: { c: { d: "[truncated]", value: 4 } } } }, truncated: true, missingFields: [],
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("caps arrays, does not read later accessors, and represents sparse holes", () => {
    const read = vi.fn(() => "not read");
    const list: unknown[] = Array.from({ length: 100_000 }, (_, index) => index);
    Object.defineProperty(list, 32, { get: read });
    const sparse = new Array<unknown>(2);
    sparse[1] = undefined;
    const result = summarizeFeatureAttributes({ list, sparse });
    expect(result.attributes?.list).toEqual(Array.from({ length: 32 }, (_, index) => index));
    expect(result.attributes?.sparse).toEqual(["[unsupported:undefined]", "[unsupported:undefined]"]);
    expect(result.truncated).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });

  it("bounds total output nodes and never walks later array branches", () => {
    const reads = vi.fn();
    const row = Array.from({ length: 32 }, (_, index) => index);
    const matrix = Array.from({ length: 32 }, () => row);
    Object.defineProperty(matrix, 20, { get: reads });
    const result = summarizeFeatureAttributes({ matrix });
    const count = (value: unknown): number => value !== null && typeof value === "object"
      ? 1 + Object.values(value).reduce<number>((sum, item) => sum + count(item), 0) : 1;
    expect(count(result.attributes)).toBeLessThanOrEqual(512);
    expect(result.truncated).toBe(true);
    expect(reads).not.toHaveBeenCalled();
  });

  it("does not call budget-excluded selected fields missing", () => {
    const row = Array.from({ length: 32 }, (_, index) => index);
    const input = { matrix: Array.from({ length: 32 }, () => row), present: "known" };
    const result = summarizeFeatureAttributes(input, { fields: ["matrix", "present", "absent"] });
    expect(result.attributes).not.toHaveProperty("present");
    expect(result.missingFields).toEqual(["absent"]);
    expect(result.truncated).toBe(true);
  });

  it("does not truncate exact field/array/string boundaries", () => {
    const input = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`f${index}`, index]));
    expect(summarizeFeatureAttributes(input).truncated).toBe(false);
    expect(summarizeFeatureAttributes({ list: Array.from({ length: 32 }, () => 1), text: "x".repeat(2048) }).truncated).toBe(false);
  });

  it("preserves nonfinite distinctions in JSON without calling them truncation", () => {
    const result = summarizeFeatureAttributes({ nan: NaN, positive: Infinity, negative: -Infinity, zero: 0 });
    expect(result).toEqual({
      attributes: { nan: "[NaN]", positive: "[Infinity]", negative: "[-Infinity]", zero: 0 },
      truncated: false, missingFields: [],
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("represents unsupported values without invoking toJSON or Symbol.toStringTag", () => {
    const read = vi.fn(() => { throw new Error("must not run"); });
    const date = new Date(0);
    Object.defineProperty(date, "toJSON", { value: read });
    Object.defineProperty(date, Symbol.toStringTag, { get: read });
    const result = summarizeFeatureAttributes({
      absent: undefined, fn: read, symbol: Symbol("fixture"), bigint: 3n, date,
    });
    expect(result.attributes).toEqual({
      absent: "[unsupported:undefined]", fn: "[unsupported:function]",
      symbol: "[unsupported:symbol]", bigint: "[unsupported:bigint]", date: "[unsupported:object]",
    });
    expect(result.truncated).toBe(true);
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  it("handles own __proto__ and constructor as data without prototype pollution", () => {
    const input = JSON.parse('{"__proto__":{"polluted":true},"constructor":"own"}') as Record<string, unknown>;
    const result = summarizeFeatureAttributes(input);
    expect(Object.getOwnPropertyDescriptor(result.attributes, "__proto__")?.value).toEqual({ polluted: true });
    expect(result.attributes?.constructor).toBe("own");
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
});
