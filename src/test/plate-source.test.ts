import { describe, expect, it } from "vitest";

import {
  applyPlateModelSource,
  plateModelSourceFromRef,
  plateModelSourceRef,
  resolvePlateModelSource,
  type PlateModelSelectionLike,
} from "../plate-model/plate-source";

/**
 * Source resolution is the single place that decides which plate model a
 * selection means, so boot, save and cloud-project open cannot disagree.
 */

function selection(
  overrides: Partial<PlateModelSelectionLike> = {},
): PlateModelSelectionLike {
  return {
    plateModelId: 0,
    plateModelVersionId: 0,
    useLocalPlateModelDemo: false,
    ...overrides,
  };
}

describe("resolvePlateModelSource", () => {
  it("names a shared (V1) model", () => {
    expect(resolvePlateModelSource(selection({ plateModelId: 42 }))).toEqual({
      kind: "shared",
      plateModelId: 42,
    });
  });

  it("keeps a versioned (V2) selection instead of downgrading it to V1", () => {
    expect(
      resolvePlateModelSource(selection({ plateModelVersionId: 7 })),
    ).toEqual({ kind: "v2", versionId: 7 });
  });

  it("only reaches the local demo through an explicit opt-in", () => {
    expect(
      resolvePlateModelSource(selection({ useLocalPlateModelDemo: true })),
    ).toEqual({ kind: "local-demo" });
  });

  it("reports an unselected model as none rather than keeping a stale one", () => {
    expect(resolvePlateModelSource(selection())).toEqual({ kind: "none" });
  });

  it("prefers an explicit V1 id over a leftover V2 id", () => {
    expect(
      resolvePlateModelSource(
        selection({ plateModelId: 3, plateModelVersionId: 9 }),
      ),
    ).toEqual({ kind: "shared", plateModelId: 3 });
  });
});

describe("plateModelSourceRef", () => {
  it("round-trips every source", () => {
    for (const source of [
      { kind: "shared", plateModelId: 42 },
      { kind: "v2", versionId: 7 },
      { kind: "local-demo" },
      { kind: "none" },
    ] as const) {
      expect(plateModelSourceFromRef(plateModelSourceRef(source))).toEqual(
        source,
      );
    }
  });

  it("writes an empty ref for none, so a saved project claims no model", () => {
    expect(plateModelSourceRef({ kind: "none" })).toBe("");
  });

  it("treats an unrecognised ref as none", () => {
    expect(plateModelSourceFromRef(undefined)).toEqual({ kind: "none" });
    expect(plateModelSourceFromRef("local:paleomap-plate-model-x")).toEqual({
      kind: "none",
    });
  });
});

describe("applyPlateModelSource", () => {
  it("clears the other sources when a V1 model is restored", () => {
    expect(
      applyPlateModelSource(
        selection({ plateModelVersionId: 9, useLocalPlateModelDemo: true }),
        { kind: "shared", plateModelId: 42 },
      ),
    ).toEqual({
      plateModelId: 42,
      plateModelVersionId: 0,
      useLocalPlateModelDemo: false,
    });
  });

  it("clears the V1 id when a V2 version is restored", () => {
    expect(
      applyPlateModelSource(
        selection({ plateModelId: 42 }),
        { kind: "v2", versionId: 7 },
      ),
    ).toEqual({
      plateModelId: 0,
      plateModelVersionId: 7,
      useLocalPlateModelDemo: false,
    });
  });

  it("clears everything when the project has no source", () => {
    expect(
      applyPlateModelSource(
        selection({ plateModelId: 42, plateModelVersionId: 7 }),
        { kind: "none" },
      ),
    ).toEqual({
      plateModelId: 0,
      plateModelVersionId: 0,
      useLocalPlateModelDemo: false,
    });
  });
});
