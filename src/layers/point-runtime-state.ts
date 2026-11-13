import {
  DEFAULT_POINT_STYLE,
  normalizePointStyleExpression,
  POINT_SIZE_MAX_PIXELS,
  POINT_SIZE_MIN_PIXELS,
  type PointStyleExpression,
} from "@timemachine/point-runtime";

/**
 * The renderer side of a point layer edit. Implemented by `main.ts`, which owns
 * the Cesium viewer and the GPU point renderer.
 */
export interface PointRuntimeRenderer {
  setOpacity(alpha: number): void;
  setShow(show: boolean): void;
  setStyle(style: unknown): void;
}

/**
 * Validates a point size in pixels against the range the style expression
 * accepts, returning the value or `undefined` when it is not a finite number
 * inside that range.
 *
 * `ProjectSession.normalizePointStyleExpression` clamps out-of-range sizes, so
 * `points.setSize` has to refuse them here; clamping instead would answer
 * `ok` while storing a different size than the caller asked for.
 */
export function parsePointSizePixels(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= POINT_SIZE_MIN_PIXELS &&
    value <= POINT_SIZE_MAX_PIXELS
    ? value
    : undefined;
}

/**
 * Pushes the point layer's runtime state into the renderer.
 *
 * Visibility and opacity are the effective values from the project session, and
 * the style is the session's stored `pointStyle` (normalized, with the default
 * expression when a layer somehow carries none). Both the sidebar events and
 * the action facade reach the renderer through here, so a style edit made
 * through `points.setStyle` or `points.setSize` reaches the GPU exactly like a
 * style edit made in the layer panel.
 */
export function applyPointRuntimeState(
  renderer: PointRuntimeRenderer | null | undefined,
  style: PointStyleExpression | undefined,
  visible: boolean,
  opacity: number,
): void {
  if (!renderer) {
    return;
  }
  renderer.setStyle(
    normalizePointStyleExpression(style ?? DEFAULT_POINT_STYLE),
  );
  renderer.setShow(visible);
  renderer.setOpacity(opacity);
}
