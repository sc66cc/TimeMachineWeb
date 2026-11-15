import { describe, expect, it } from "vitest";
import { defaultNativePolygonStyle, patchNativePolygonStyle, readNativePolygonStyle } from "../layers/native-polygon-style";

describe("ordinary polygon style", () => {
  it("keeps fill and boundary values independent and returns fresh defaults", () => {
    expect(readNativePolygonStyle(undefined)).toEqual({ fillColor: "#38bdf8", outlineColor: "#ffffff", outlineWidth: 2 });
    const value = defaultNativePolygonStyle(); value.fillColor = "#000000";
    expect(defaultNativePolygonStyle().fillColor).toBe("#38bdf8");
    expect(readNativePolygonStyle({ fillColor: "#ABCDEF", outlineColor: "#FEDCBA", outlineWidth: 3.5 })).toEqual({ fillColor: "#abcdef", outlineColor: "#fedcba", outlineWidth: 3.5 });
  });
  it.each([null, false, 0, "", {}, { fillColor: "red", outlineColor: "#ffffff", outlineWidth: 2 },
    { fillColor: "#ffffff", outlineColor: "#ffffff00", outlineWidth: 2 }, { fillColor: "#ffffff", outlineColor: "#ffffff", outlineWidth: 0 },
    { fillColor: "#ffffff", outlineColor: "#ffffff", outlineWidth: 17 }, { fillColor: "#ffffff", outlineColor: "#ffffff", outlineWidth: Infinity },
    { fillColor: "#ffffff", outlineColor: "#ffffff", outlineWidth: 2, lineWidth: 3 }])("rejects malformed or unsupported value %j", value => {
    expect(() => readNativePolygonStyle(value)).toThrow();
  });
  it("patches only the chosen field and rejects invalid current state before normalization", () => {
    const current = { fillColor: "#12abef", outlineColor: "#ff5500", outlineWidth: 4 };
    expect(patchNativePolygonStyle(current, { outlineWidth: 6 })).toEqual({ ...current, outlineWidth: 6 });
    expect(patchNativePolygonStyle(undefined, { fillColor: "#FFFFFF" })).toEqual({ ...defaultNativePolygonStyle(), fillColor: "#ffffff" });
    for (const patch of [{}, { lineWidth: 3 }, { outlineColor: "red" }, { outlineWidth: 17 }, { fillColor: "#ffffff", pointSize: 3 }]) {
      expect(() => patchNativePolygonStyle(current, patch)).toThrow();
    }
    expect(() => patchNativePolygonStyle({ ...current, outlineWidth: 99 }, { fillColor: "#000000" })).toThrow();
    expect(current).toEqual({ fillColor: "#12abef", outlineColor: "#ff5500", outlineWidth: 4 });
  });
});
