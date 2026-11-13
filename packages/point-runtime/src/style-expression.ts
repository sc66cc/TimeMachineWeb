export type PointColorMode = "plate" | "single" | "occurrence";
export type PointShape = "circle" | "square";
export type PointSizeMode = "fixed" | "occurrence";

export interface PointStyleExpression {
  colorMode: PointColorMode;
  filter: {
    maximumOccurrence: number;
    minimumOccurrence: number;
    plateId: number | null;
  };
  occurrenceSizeScale: number;
  pointSize: number;
  schemaVersion: 1;
  shape: PointShape;
  singleColor: string;
  sizeMode: PointSizeMode;
}

export const DEFAULT_POINT_STYLE: Readonly<PointStyleExpression> = {
  colorMode: "plate",
  filter: {
    maximumOccurrence: 65_535,
    minimumOccurrence: 0,
    plateId: null,
  },
  occurrenceSizeScale: 1,
  pointSize: 2.2,
  schemaVersion: 1,
  shape: "circle",
  singleColor: "#f29d38",
  sizeMode: "occurrence",
};

/**
 * The point size range in pixels the style expression accepts. Exported so the
 * `points.setSize` action can reject out-of-range values instead of letting
 * them be clamped silently.
 */
export const POINT_SIZE_MIN_PIXELS = 0.5;
export const POINT_SIZE_MAX_PIXELS = 8;

function finiteNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

export function normalizePointStyleExpression(
  value: unknown,
): PointStyleExpression {
  const source =
    typeof value === "object" && value !== null
      ? (value as Partial<PointStyleExpression>)
      : {};
  const filter: Partial<PointStyleExpression["filter"]> =
    typeof source.filter === "object" && source.filter !== null
      ? source.filter
      : {};
  const minimumOccurrence = finiteNumber(
    filter.minimumOccurrence,
    DEFAULT_POINT_STYLE.filter.minimumOccurrence,
    0,
    65_535,
  );
  const maximumOccurrence = Math.max(
    minimumOccurrence,
    finiteNumber(
      filter.maximumOccurrence,
      DEFAULT_POINT_STYLE.filter.maximumOccurrence,
      0,
      65_535,
    ),
  );
  const plateIdValue = filter.plateId;
  const plateId =
    plateIdValue === null
      ? null
      : typeof plateIdValue === "number" &&
          Number.isInteger(plateIdValue) &&
          plateIdValue >= 0 &&
          plateIdValue <= 65_535
        ? plateIdValue
        : null;

  return {
    colorMode:
      source.colorMode === "single" || source.colorMode === "occurrence"
        ? source.colorMode
        : "plate",
    filter: {
      maximumOccurrence,
      minimumOccurrence,
      plateId,
    },
    occurrenceSizeScale: finiteNumber(
      source.occurrenceSizeScale,
      DEFAULT_POINT_STYLE.occurrenceSizeScale,
      0,
      4,
    ),
    pointSize: finiteNumber(
      source.pointSize,
      DEFAULT_POINT_STYLE.pointSize,
      POINT_SIZE_MIN_PIXELS,
      POINT_SIZE_MAX_PIXELS,
    ),
    schemaVersion: 1,
    shape: source.shape === "square" ? "square" : "circle",
    singleColor: isHexColor(source.singleColor)
      ? source.singleColor.toLowerCase()
      : DEFAULT_POINT_STYLE.singleColor,
    sizeMode: source.sizeMode === "fixed" ? "fixed" : "occurrence",
  };
}
