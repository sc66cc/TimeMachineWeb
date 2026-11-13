import {
  ArcType,
  Cartesian3,
  Cartographic,
  Ellipsoid,
  Geometry,
  Math as CesiumMath,
  PerInstanceColorAppearance,
  PolygonGeometry,
  PolygonHierarchy,
} from "cesium";

import type {
  LonLat,
  PlatePolygon,
} from "@timemachine/reconstruction-core";

export const EARTH_RADIUS_METRES = 6_371_000;
export const PLATE_SURFACE_OFFSET_METRES = 12_000;
export const OUTLINE_SURFACE_OFFSET_METRES = 18_000;

export const SPHERICAL_EARTH = new Ellipsoid(
  EARTH_RADIUS_METRES,
  EARTH_RADIUS_METRES,
  EARTH_RADIUS_METRES,
);
export const PLATE_ELLIPSOID = new Ellipsoid(
  EARTH_RADIUS_METRES + PLATE_SURFACE_OFFSET_METRES,
  EARTH_RADIUS_METRES + PLATE_SURFACE_OFFSET_METRES,
  EARTH_RADIUS_METRES + PLATE_SURFACE_OFFSET_METRES,
);
export const OUTLINE_ELLIPSOID = new Ellipsoid(
  EARTH_RADIUS_METRES + OUTLINE_SURFACE_OFFSET_METRES,
  EARTH_RADIUS_METRES + OUTLINE_SURFACE_OFFSET_METRES,
  EARTH_RADIUS_METRES + OUTLINE_SURFACE_OFFSET_METRES,
);

export interface TriangulatedPolygon {
  geometry: Geometry;
  triangleCount: number;
  vertexCount: number;
}

export function lonLatToCartesian(
  coordinate: LonLat,
  ellipsoid = PLATE_ELLIPSOID,
): Cartesian3 {
  return ellipsoid.cartographicToCartesian(
    Cartographic.fromDegrees(coordinate[0], coordinate[1]),
  );
}

function createHierarchy(polygon: PlatePolygon): PolygonHierarchy {
  return new PolygonHierarchy(
    polygon.exterior.map((coordinate) =>
      lonLatToCartesian(coordinate, PLATE_ELLIPSOID),
    ),
    polygon.holes.map(
      (hole) =>
        new PolygonHierarchy(
          hole.map((coordinate) =>
            lonLatToCartesian(coordinate, PLATE_ELLIPSOID),
          ),
        ),
    ),
  );
}

/**
 * Cesium's PolygonGeometry performs ellipsoid-aware geodesic subdivision and
 * triangle tessellation. Calling createGeometry here makes the triangle mesh
 * explicit and lets the UI report its actual triangle count.
 */
export function triangulatePlatePolygon(
  polygon: PlatePolygon,
): TriangulatedPolygon {
  const descriptor = new PolygonGeometry({
    polygonHierarchy: createHierarchy(polygon),
    ellipsoid: PLATE_ELLIPSOID,
    arcType: ArcType.GEODESIC,
    granularity: CesiumMath.toRadians(1),
    vertexFormat: PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
  });
  const geometry = PolygonGeometry.createGeometry(descriptor);
  if (!geometry) {
    throw new Error("Cesium could not triangulate this spherical polygon.");
  }

  const positionValues = geometry.attributes.position?.values;
  return {
    geometry,
    triangleCount: geometry.indices ? geometry.indices.length / 3 : 0,
    vertexCount: positionValues ? positionValues.length / 3 : 0,
  };
}
