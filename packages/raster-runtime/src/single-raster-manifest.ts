import type {
  SingleRasterColorbar,
  SingleRasterEntry,
  SingleRasterLegendStop,
  SingleRasterManifest,
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireString(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`SingleRaster manifest field "${key}" must be a string.`);
  }
  return value;
}

function requireNumber(
  record: Record<string, unknown>,
  key: string,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`SingleRaster manifest field "${key}" must be a number.`);
  }
  return value;
}

function parseStop(value: unknown): SingleRasterLegendStop {
  if (!isRecord(value)) {
    throw new Error("SingleRaster legend stop must be an object.");
  }
  const offset = requireNumber(value, "offset");
  if (offset < 0 || offset > 1) {
    throw new Error("SingleRaster legend stop offset must be between 0 and 1.");
  }
  return {
    offset,
    value: requireNumber(value, "value"),
    color: requireString(value, "color"),
  };
}

function parseColorbar(value: unknown): SingleRasterColorbar | null {
  if (value === null) {
    return null;
  }
  if (!isRecord(value) || !Array.isArray(value.stops)) {
    throw new Error("SingleRaster colorbar metadata is invalid.");
  }
  if (value.mode !== "continuous" && value.mode !== "discrete") {
    throw new Error("SingleRaster colorbar mode is invalid.");
  }
  const stops = value.stops.map(parseStop);
  if (stops.length < 2) {
    throw new Error("SingleRaster colorbar requires at least two stops.");
  }
  return {
    label: requireString(value, "label"),
    sourceFile: requireString(value, "sourceFile"),
    sourceSha256: requireString(value, "sourceSha256"),
    mode: value.mode,
    minimum: requireNumber(value, "minimum"),
    maximum: requireNumber(value, "maximum"),
    units: typeof value.units === "string" ? value.units : "",
    stops,
  };
}

function parseEntry(value: unknown): SingleRasterEntry {
  if (!isRecord(value) || !isRecord(value.tiles)) {
    throw new Error("SingleRaster entry is invalid.");
  }
  if (value.tiles.format !== "image/png") {
    throw new Error("SingleRaster MVP requires PNG tiles.");
  }
  const minimumLevel = requireNumber(value.tiles, "minimumLevel");
  const maximumLevel = requireNumber(value.tiles, "maximumLevel");
  if (minimumLevel < 0 || maximumLevel < minimumLevel) {
    throw new Error("SingleRaster tile level range is invalid.");
  }
  const emptyTilePolicy = value.tiles.emptyTilePolicy;
  if (emptyTilePolicy !== undefined && emptyTilePolicy !== "transparent-204") {
    throw new Error("SingleRaster empty tile policy is unsupported.");
  }
  return {
    id: requireString(value, "id"),
    label: requireString(value, "label"),
    kind: requireString(value, "kind"),
    sourceId: requireString(value, "sourceId"),
    sourceFile: requireString(value, "sourceFile"),
    sourceSha256: requireString(value, "sourceSha256"),
    tileUrl: requireString(value, "tileUrl"),
    byteLength: requireNumber(value, "byteLength"),
    tiles: {
      format: "image/png",
      minimumLevel,
      maximumLevel,
      hasAlphaChannel: value.tiles.hasAlphaChannel === true,
      ...(emptyTilePolicy === undefined ? {} : { emptyTilePolicy }),
    },
    colorbar: parseColorbar(value.colorbar),
  };
}

export function parseSingleRasterManifest(
  value: unknown,
): SingleRasterManifest {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Unsupported SingleRaster manifest.");
  }
  if (!isRecord(value.tileMatrixSet) || !Array.isArray(value.rasters)) {
    throw new Error("SingleRaster manifest is incomplete.");
  }
  const bounds = value.tileMatrixSet.bounds;
  if (
    !Array.isArray(bounds) ||
    bounds.length !== 4 ||
    !bounds.every(
      (coordinate) =>
        typeof coordinate === "number" && Number.isFinite(coordinate),
    )
  ) {
    throw new Error("SingleRaster tile bounds must contain four numbers.");
  }
  const rasters = value.rasters.map(parseEntry);
  const ids = new Set(rasters.map((entry) => entry.id));
  const defaultRasterId = requireString(value, "defaultRasterId");
  if (rasters.length === 0 || ids.size !== rasters.length) {
    throw new Error("SingleRaster entries must contain unique IDs.");
  }
  if (!ids.has(defaultRasterId)) {
    throw new Error("SingleRaster default raster does not exist.");
  }
  return {
    schemaVersion: 1,
    id: requireString(value, "id"),
    label: requireString(value, "label"),
    attribution: requireString(value, "attribution"),
    defaultRasterId,
    tileMatrixSet: {
      crs: "EPSG:3857",
      name: "WebMercatorQuad",
      tileSize: 256,
      bounds: bounds as [number, number, number, number],
    },
    rasters,
  };
}
