import { describe, expect, it } from "vitest";
import { defaultNativeLineStyle, patchNativeLineStyle, readNativeLineStyle } from "../layers/native-line-style";

describe("native line style", () => {
  it("keeps line color/width separate from point fields and returns independent defaults", () => {
    expect(readNativeLineStyle(undefined)).toEqual({ lineColor: "#38bdf8", lineWidth: 2 });
    const first = defaultNativeLineStyle(); first.lineWidth = 5;
    expect(defaultNativeLineStyle().lineWidth).toBe(2);
    expect(readNativeLineStyle({ lineColor: "#AB12EF", lineWidth: 3.5 })).toEqual({ lineColor: "#ab12ef", lineWidth: 3.5 });
  });
  it.each([null, false, 0, "", {}, { lineColor: "red", lineWidth: 2 }, { lineColor: "#11223344", lineWidth: 2 },
    { lineColor: "#abcdef", lineWidth: 0 }, { lineColor: "#abcdef", lineWidth: 17 }, { lineColor: "#abcdef", lineWidth: Infinity },
    { lineColor: "#abcdef", lineWidth: 2, pointSize: 6 }])("rejects unsupported stored value %j", value => {
    expect(() => readNativeLineStyle(value)).toThrow();
  });
  it("strictly patches one field without clamping or losing the other", () => {
    const current = { lineColor: "#12abef", lineWidth: 4 };
    expect(patchNativeLineStyle(current, { lineWidth: 6 })).toEqual({ lineColor: "#12abef", lineWidth: 6 });
    expect(patchNativeLineStyle(undefined, { lineColor: "#FFFFFF" })).toEqual({ lineColor: "#ffffff", lineWidth: 2 });
    expect(current).toEqual({ lineColor: "#12abef", lineWidth: 4 });
    for (const patch of [{}, { lineWidth: 0 }, { pointSize: 3 }, { lineColor: "red" }, { lineWidth: 2, extra: true }]) {
      expect(() => patchNativeLineStyle(current, patch)).toThrow();
    }
    expect(() => patchNativeLineStyle({ lineColor: "#ffffff", lineWidth: 99 }, { lineColor: "#112233" })).toThrow();
  });
});
