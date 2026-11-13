export interface PointFixtureFormat {
  magic: "WGP1";
  version: number;
  headerBytes: number;
  recordStrideBytes: number;
}

export interface PointDatasetManifestEntry {
  id: string;
  label: string;
  url: string;
  fileName: string;
  pointCount: number;
  uniqueSourcePointCount: number;
  generation:
    | "stratified_sample"
    | "full_valid_source"
    | "deterministic_repeat";
  byteLength: number;
  sha256: string;
  recordStrideBytes: number;
  activeCountsByIntegerMa: number[];
  writeElapsedSeconds: number;
}

export interface PointFixtureManifest {
  format: PointFixtureFormat;
  generatedAt: string;
  validityPolicy: "permanent_0_1100_ma" | "source_intervals";
  unassignedPointPolicy: "anchor_plate_0_for_benchmark" | "hidden";
  basePointCount: number;
  maxPlateId: number;
  quality: {
    sourceRowCount: number;
    acceptedRowCount: number;
    rejectedRowCount: number;
    rejectedByReason: Record<string, number>;
  };
  plateAssignment: {
    engine: string;
    engineVersion: string;
    reconstructionTimeMa: number;
    assignedCount: number;
    unassignedCount: number;
    uniqueAssignedPlateCount: number;
    elapsedSeconds: number;
    cacheReused: boolean;
  };
  datasets: PointDatasetManifestEntry[];
}

export interface PointBinaryHeader {
  magic: "WGP1";
  version: number;
  headerBytes: number;
  recordStrideBytes: number;
  pointCount: number;
  sourcePointCount: number;
  maxPlateId: number;
  maxTimeDeciMa: number;
}

export interface PointLoadTimings {
  cacheHit: boolean;
  fetchMs: number;
  decodeMs: number;
  totalMs: number;
}

export interface LoadedPointDataset {
  datasetId: string;
  header: PointBinaryHeader;
  buffer: ArrayBuffer;
  timings: PointLoadTimings;
}

export interface PointRecord {
  occurrenceCount: number;
  plateId: number;
  rowId: number;
  unitPosition: readonly [number, number, number];
  validFromMa: number;
  validToMa: number;
}
