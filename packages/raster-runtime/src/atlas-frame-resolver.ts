import type {
  PaleoAtlasFrame,
  PaleoAtlasManifest,
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireNumber(
  record: Record<string, unknown>,
  key: string,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`PaleoAtlas manifest field "${key}" must be a number.`);
  }
  return value;
}

function requireString(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`PaleoAtlas manifest field "${key}" must be a string.`);
  }
  return value;
}

function parseFrame(value: unknown): PaleoAtlasFrame {
  if (!isRecord(value)) {
    throw new Error("Every PaleoAtlas frame must be an object.");
  }
  return {
    timeMa: requireNumber(value, "timeMa"),
    label: requireString(value, "label"),
    sourceId: requireString(value, "sourceId"),
    sourceFile: requireString(value, "sourceFile"),
    sourceSha256: requireString(value, "sourceSha256"),
    tileUrl: requireString(value, "tileUrl"),
    byteLength: requireNumber(value, "byteLength"),
  };
}

export function parsePaleoAtlasManifest(
  value: unknown,
): PaleoAtlasManifest {
  if (!isRecord(value)) {
    throw new Error("PaleoAtlas manifest must be an object.");
  }
  if (value.schemaVersion !== 1) {
    throw new Error("Unsupported PaleoAtlas manifest schema version.");
  }
  if (value.frameSelection !== "nearest") {
    throw new Error("PaleoAtlas MVP only supports nearest-frame selection.");
  }
  if (value.outOfRangePolicy !== "hide") {
    throw new Error("PaleoAtlas MVP requires the hide out-of-range policy.");
  }
  if (!Array.isArray(value.frames) || value.frames.length === 0) {
    throw new Error("PaleoAtlas manifest does not contain any frames.");
  }
  if (!isRecord(value.tiles)) {
    throw new Error("PaleoAtlas manifest tiles metadata is missing.");
  }

  const bounds = value.tiles.bounds;
  if (
    !Array.isArray(bounds) ||
    bounds.length !== 4 ||
    !bounds.every(
      (coordinate) =>
        typeof coordinate === "number" && Number.isFinite(coordinate),
    )
  ) {
    throw new Error("PaleoAtlas tile bounds must contain four numbers.");
  }

  const frames = value.frames.map(parseFrame).sort((a, b) => a.timeMa - b.timeMa);
  const ages = new Set<number>();
  const sourceIds = new Set<string>();
  for (const frame of frames) {
    if (ages.has(frame.timeMa) || sourceIds.has(frame.sourceId)) {
      throw new Error("PaleoAtlas frame ages and source IDs must be unique.");
    }
    ages.add(frame.timeMa);
    sourceIds.add(frame.sourceId);
  }

  const minimumLevel = requireNumber(value.tiles, "minimumLevel");
  const maximumLevel = requireNumber(value.tiles, "maximumLevel");
  if (minimumLevel < 0 || maximumLevel < minimumLevel) {
    throw new Error("PaleoAtlas tile level range is invalid.");
  }

  return {
    schemaVersion: 1,
    id: requireString(value, "id"),
    label: requireString(value, "label"),
    attribution: requireString(value, "attribution"),
    frameSelection: "nearest",
    outOfRangePolicy: "hide",
    tiles: {
      crs: "EPSG:3857",
      tileMatrixSet: "WebMercatorQuad",
      tileSize: 256,
      format: "image/jpeg",
      minimumLevel,
      maximumLevel,
      bounds: bounds as [number, number, number, number],
    },
    frames,
  };
}

export class AtlasFrameResolver {
  readonly minimumAgeMa: number;
  readonly maximumAgeMa: number;

  constructor(readonly manifest: PaleoAtlasManifest) {
    const first = manifest.frames[0];
    const last = manifest.frames.at(-1);
    if (!first || !last) {
      throw new Error("PaleoAtlas manifest does not contain any frames.");
    }
    this.minimumAgeMa = first.timeMa;
    this.maximumAgeMa = last.timeMa;
  }

  resolve(ageMa: number): PaleoAtlasFrame | undefined {
    if (
      !Number.isFinite(ageMa) ||
      ageMa < this.minimumAgeMa ||
      ageMa > this.maximumAgeMa
    ) {
      return undefined;
    }

    let closest = this.manifest.frames[0];
    if (!closest) {
      return undefined;
    }
    let closestDistance = Math.abs(ageMa - closest.timeMa);
    for (const frame of this.manifest.frames.slice(1)) {
      const distance = Math.abs(ageMa - frame.timeMa);
      if (distance < closestDistance) {
        closest = frame;
        closestDistance = distance;
      }
    }
    return closest;
  }

  adjacent(frame: PaleoAtlasFrame): PaleoAtlasFrame[] {
    const index = this.manifest.frames.findIndex(
      (candidate) => candidate.sourceId === frame.sourceId,
    );
    if (index < 0) {
      return [];
    }
    return [
      this.manifest.frames[index - 1],
      this.manifest.frames[index + 1],
    ].filter((candidate): candidate is PaleoAtlasFrame => candidate !== undefined);
  }
}
