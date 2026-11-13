import {
  parsePlatesRotationFile,
  type GpmlParseResult,
  type LonLat,
  type PlateFeature,
  type PlatePolygon,
  type RotationParseResult,
} from "@timemachine/reconstruction-core";

import type {
  PlateGeoTO,
  PlateModelTO,
  PlateRotationTO,
} from "@timemachine/generated-api";

/**
 * Converts a shared `PlateModelTO` payload into the two parse results the
 * renderer already consumes, so `main.ts` can swap its file-based loader for
 * the cloud model without touching the rendering path.
 *
 * `PlateGeoTO.Polygon.PosList` already stores longitude/latitude in degrees,
 * which is exactly the application's `LonLat` order, so coordinates are copied
 * verbatim. `ValidTime` is copied verbatim too: a `0..0` range means the feature
 * is only valid at 0 Ma (it is not rewritten into an unbounded range), and 9999
 * stays 9999.
 */

export interface SharedPlateModelRuntimeData {
  gpmlParseResult: GpmlParseResult;
  rotationParseResult: RotationParseResult;
}

export function convertPlateGeoList(
  geoList: readonly PlateGeoTO[],
): GpmlParseResult {
  const features: PlateFeature[] = [];
  let polygonCount = 0;
  let unsupportedGeometryCount = 0;
  const warnings: string[] = [];

  for (const [sourceIndex, geo] of geoList.entries()) {
    const identity =
      geo.FeatureID || geo.FeatureName || `feature-${sourceIndex}`;
    const polygons: PlatePolygon[] = [];
    for (const polygon of geo.Polygon) {
      const exterior: LonLat[] = polygon.PosList.map((point) => [
        point.Longitude,
        point.Latitude,
      ]);
      // The PlateModel contract has no interior rings, so holes stay empty.
      polygons.push({ exterior, holes: [] });
      polygonCount += 1;
    }
    if (polygons.length === 0) {
      unsupportedGeometryCount += 1;
      warnings.push(
        `${identity}: no polygon geometry; the feature cannot be drawn.`,
      );
    }

    features.push({
      id: identity,
      plateId: geo.PlateID,
      name: geo.FeatureName || `Plate ${geo.PlateID}`,
      description: "",
      validFromMa: geo.ValidTime.Begin,
      validToMa: geo.ValidTime.End,
      polygons,
      sourceIndex,
    });
  }

  return {
    features,
    polygonCount,
    unsupportedGeometryCount,
    warnings,
  };
}

/**
 * Reuses `parsePlatesRotationFile` on the synthesized PLATES text so the 999
 * disabled-sample rule and the crossover sequence segmentation behave exactly
 * as they do for an uploaded `.rot` file. `RotationList` order is preserved,
 * because that order is what drives the segmentation.
 */
export function convertPlateRotationList(
  rotationList: readonly PlateRotationTO[],
): RotationParseResult {
  const lines = rotationList.map((rotation) => {
    const fields = [
      String(rotation.ID),
      String(rotation.Age),
      String(rotation.PoleLatitude),
      String(rotation.PoleLongitude),
      String(rotation.PoleAngle),
      String(rotation.ParentID),
    ].join(" ");
    // The PLATES format is line based, so a comment cannot contain a newline.
    const comment = rotation.Comment.replace(/[\r\n]+/g, " ").trim();
    return comment ? `${fields} ! ${comment}` : fields;
  });
  return parsePlatesRotationFile(lines.join("\n"));
}

export function convertPlateModelContent(
  content: PlateModelTO,
): SharedPlateModelRuntimeData {
  return {
    gpmlParseResult: convertPlateGeoList(content.GeoList),
    rotationParseResult: convertPlateRotationList(content.RotationList),
  };
}
