export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Hamilton quaternion in GPlates-compatible component order.
 *
 * GPlates names the scalar component first internally. Keeping the fields
 * explicit avoids confusing it with Cesium's constructor order (x, y, z, w).
 */
export interface Quaternion {
  w: number;
  x: number;
  y: number;
  z: number;
}

export interface RotationSample {
  timeMa: number;
  poleLatitudeDeg: number;
  poleLongitudeDeg: number;
  angleDeg: number;
  quaternion: Quaternion;
  enabled: boolean;
  lineNumber: number;
  comment: string;
}

export interface RotationSequence {
  id: string;
  fixedPlateId: number;
  movingPlateId: number;
  samples: RotationSample[];
  sourceOrder: number;
  youngestTimeMa: number;
  oldestTimeMa: number;
}

export interface RotationParseDiagnostic {
  lineNumber: number;
  severity: "warning" | "error";
  message: string;
}

export interface RotationParseResult {
  sequences: RotationSequence[];
  diagnostics: RotationParseDiagnostic[];
  parsedLineCount: number;
  disabledSampleCount: number;
}

/** Coordinate order used by the application: longitude first, latitude second. */
export type LonLat = readonly [longitudeDeg: number, latitudeDeg: number];

export interface PlatePolygon {
  exterior: LonLat[];
  holes: LonLat[][];
}

export interface PlateFeature {
  id: string;
  plateId: number;
  name: string;
  description: string;
  validFromMa: number;
  validToMa: number;
  polygons: PlatePolygon[];
  sourceIndex: number;
}

export interface GpmlParseResult {
  features: PlateFeature[];
  polygonCount: number;
  unsupportedGeometryCount: number;
  warnings: string[];
}
