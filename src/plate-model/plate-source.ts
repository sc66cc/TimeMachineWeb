/**
 * The one place that decides which plate model a selection refers to.
 *
 * Three explicit sources and no implicit fallback between them. Both the boot
 * path in `main.ts` and the persistence path (project save / cloud project
 * open) resolve through these helpers, so a stored project and a fresh boot
 * can never disagree about where a plate model came from.
 */

/** Structural subset of `ResourceSelection` this module needs. */
export interface PlateModelSelectionLike {
  plateModelId: number;
  plateModelVersionId: number;
  useLocalPlateModelDemo: boolean;
}

export type PlateModelSource =
  | { kind: "local-demo" }
  | { kind: "none" }
  | { kind: "shared"; plateModelId: number }
  | { kind: "v2"; versionId: number };

/**
 * Resolves the stored selection into an explicit source.
 *
 * The local demo is only reachable through an explicit opt-in, and a versioned
 * (V2) selection is never silently downgraded to the shared (V1) catalog.
 */
export function resolvePlateModelSource(
  selection: PlateModelSelectionLike,
): PlateModelSource {
  if (selection.plateModelId > 0) {
    return { kind: "shared", plateModelId: selection.plateModelId };
  }
  if (selection.plateModelVersionId > 0) {
    return { kind: "v2", versionId: selection.plateModelVersionId };
  }
  if (selection.useLocalPlateModelDemo) {
    return { kind: "local-demo" };
  }
  return { kind: "none" };
}

/**
 * The `sourceRef` a project stores for the plate model layer. An unselected
 * model stores the empty string rather than the built-in default, so saving a
 * project never claims the local demo was used.
 */
export function plateModelSourceRef(source: PlateModelSource): string {
  switch (source.kind) {
    case "shared":
      return `resource:plate-model:${source.plateModelId}`;
    case "v2":
      return `resource:plate-model-version:${source.versionId}`;
    case "local-demo":
      return "local:paleomap-plate-model";
    default:
      return "";
  }
}

/** Inverse of `plateModelSourceRef`; anything unrecognised means "none". */
export function plateModelSourceFromRef(
  sourceRef: string | undefined,
): PlateModelSource {
  const value = sourceRef ?? "";
  const sharedMatch = /^resource:plate-model:(\d+)$/.exec(value);
  if (sharedMatch) {
    return { kind: "shared", plateModelId: Number(sharedMatch[1]) };
  }
  const versionMatch = /^resource:plate-model-version:(\d+)$/.exec(value);
  if (versionMatch) {
    return { kind: "v2", versionId: Number(versionMatch[1]) };
  }
  if (value === "local:paleomap-plate-model") {
    return { kind: "local-demo" };
  }
  return { kind: "none" };
}

/**
 * Rewrites a selection so it names exactly one source, clearing the others.
 * Used when opening a cloud project so a V1 selection cannot survive next to a
 * V2 one, and so a V1 id is never written into the versioned field.
 */
export function applyPlateModelSource<T extends PlateModelSelectionLike>(
  selection: T,
  source: PlateModelSource,
): T {
  return {
    ...selection,
    plateModelId: source.kind === "shared" ? source.plateModelId : 0,
    plateModelVersionId: source.kind === "v2" ? source.versionId : 0,
    useLocalPlateModelDemo: source.kind === "local-demo",
  };
}
