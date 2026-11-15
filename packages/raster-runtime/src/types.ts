export interface PaleoAtlasFrame {
  timeMa: number;
  label: string;
  sourceId: string;
  sourceFile: string;
  sourceSha256: string;
  tileUrl: string;
  byteLength: number;
}

export interface PaleoAtlasManifest {
  schemaVersion: 1;
  id: string;
  label: string;
  attribution: string;
  frameSelection: "nearest";
  outOfRangePolicy: "hide";
  tiles: {
    crs: "EPSG:3857";
    tileMatrixSet: "WebMercatorQuad";
    tileSize: 256;
    format: "image/jpeg";
    minimumLevel: number;
    maximumLevel: number;
    bounds: [number, number, number, number];
  };
  frames: PaleoAtlasFrame[];
}

export type PaleoAtlasTimeResult = {
  generation: number;
  requestedAgeMa: number;
} & (
  | { status: "ready"; actualFrameAgeMa: number; sourceId: string }
  | { status: "hidden"; reason: "disabled" | "out-of-range" }
);

export type PaleoAtlasRuntimeState =
  | {
      status: "loading";
      requestedAgeMa: number;
      frame: PaleoAtlasFrame;
    }
  | {
      status: "ready";
      requestedAgeMa: number;
      frame: PaleoAtlasFrame;
    }
  | {
      status: "hidden";
      requestedAgeMa: number;
      reason: "disabled" | "out-of-range";
    }
  | {
      status: "error";
      requestedAgeMa: number;
      frame?: PaleoAtlasFrame;
      message: string;
    };

export interface SingleRasterLegendStop {
  offset: number;
  value: number;
  color: string;
}

export interface SingleRasterColorbar {
  label: string;
  sourceFile: string;
  sourceSha256: string;
  mode: "continuous" | "discrete";
  minimum: number;
  maximum: number;
  units: string;
  stops: SingleRasterLegendStop[];
}

export interface SingleRasterEntry {
  id: string;
  label: string;
  kind: string;
  sourceId: string;
  sourceFile: string;
  sourceSha256: string;
  tileUrl: string;
  byteLength: number;
  tiles: {
    format: "image/png";
    minimumLevel: number;
    maximumLevel: number;
    hasAlphaChannel: boolean;
    /** Explicit Martin sparse MBTiles protocol; absent means native errors. */
    emptyTilePolicy?: "transparent-204";
  };
  colorbar: SingleRasterColorbar | null;
}

export interface SingleRasterManifest {
  schemaVersion: 1;
  id: string;
  label: string;
  attribution: string;
  defaultRasterId: string;
  tileMatrixSet: {
    crs: "EPSG:3857";
    name: "WebMercatorQuad";
    tileSize: 256;
    bounds: [number, number, number, number];
  };
  rasters: SingleRasterEntry[];
}

export type SingleRasterSelectionResult = {
  generation: number;
  requestedRasterId: string;
} & (
  | { status: "ready"; rasterId: string; sourceId: string }
  | { status: "hidden"; reason: "disabled" }
);

export type SingleRasterRuntimeState =
  | {
      status: "loading";
      raster: SingleRasterEntry;
    }
  | {
      status: "ready";
      raster: SingleRasterEntry;
    }
  | {
      status: "hidden";
      raster: SingleRasterEntry | undefined;
    }
  | {
      status: "error";
      raster: SingleRasterEntry;
      message: string;
    };
