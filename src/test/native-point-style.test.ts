import { describe, expect, it } from "vitest";
import type { PointStyleExpression } from "@timemachine/point-runtime";
import { AgentActionUnsupportedError, AgentActionValidationError } from "../agent-actions/registry";
import { defaultNativePointStyle, patchNativePointStyle, readNativePointStyle } from "../layers/native-point-style";

describe("ordinary point style contract", () => {
  it("keeps undefined at native white/6px and returns fresh canonical values", () => {
    expect(readNativePointStyle(undefined)).toEqual({ singleColor: "#ffffff", pointSize: 6 });
    const first = defaultNativePointStyle();
    expect(first).toEqual({ schemaVersion: 1, colorMode: "single", singleColor: "#ffffff", sizeMode: "fixed", pointSize: 6,
      shape: "circle", occurrenceSizeScale: 1, filter: { plateId: null, minimumOccurrence: 0, maximumOccurrence: 65535 } });
    first.filter.plateId = 2;
    expect(defaultNativePointStyle().filter.plateId).toBeNull();
  });

  it("patches only color/size, validates without clamping and does not mutate the current style", () => {
    const current = defaultNativePointStyle();
    const result = patchNativePointStyle(current, { singleColor: "#12ABef", pointSize: 8 });
    expect(readNativePointStyle(result)).toEqual({ singleColor: "#12abef", pointSize: 8 });
    expect(current).toEqual(defaultNativePointStyle());
    expect(readNativePointStyle(patchNativePointStyle(result, { pointSize: 0.5 }))).toEqual({ singleColor: "#12abef", pointSize: 0.5 });
  });

  it.each([null, [], {}, { pointSize: 0.49 }, { pointSize: 8.01 }, { pointSize: NaN }, { pointSize: "4" },
    { singleColor: "red" }, { singleColor: "#11223344" }, { singleColor: 1 }, { singleColor: "#ffffff", alpha: 0.5 },
    { shape: "square" }, { filter: { plateId: 1 } }, { colorMode: "plate" }])("rejects unsupported or invalid patch %j before normalization", patch => {
    const current = defaultNativePointStyle();
    expect(() => patchNativePointStyle(current, patch)).toThrow(AgentActionValidationError);
    expect(current).toEqual(defaultNativePointStyle());
  });

  it.each([
    { colorMode: "plate" }, { colorMode: "occurrence" }, { sizeMode: "occurrence" }, { shape: "square" }, { occurrenceSizeScale: 2 },
    { filter: { plateId: 1, minimumOccurrence: 0, maximumOccurrence: 65535 } },
    { filter: { plateId: null, minimumOccurrence: 1, maximumOccurrence: 65535 } },
    { filter: { plateId: null, minimumOccurrence: 0, maximumOccurrence: 30 } },
  ])("refuses an explicitly unsupported stored expression %j", change => {
    const style = { ...defaultNativePointStyle(), ...change } as PointStyleExpression;
    expect(() => readNativePointStyle(style)).toThrow(AgentActionUnsupportedError);
    expect(() => patchNativePointStyle(style, { pointSize: 4 })).toThrow(AgentActionUnsupportedError);
  });

  it.each([{ pointSize: 9 }, { pointSize: Infinity }, { singleColor: "#wrong" }, { filter: null }, { unexpected: true }])("does not silently normalize malformed stored values %j", change => {
    expect(() => readNativePointStyle({ ...defaultNativePointStyle(), ...change } as unknown as PointStyleExpression)).toThrow(AgentActionValidationError);
  });
});
