import { AgentActionValidationError } from "../agent-actions/registry";

export interface NativePolygonStyle { fillColor: string; outlineColor: string; outlineWidth: number }
/** Engineering display bounds shared with ordinary line boundaries, not scientific tolerances. */
export const NATIVE_POLYGON_OUTLINE_WIDTH_MIN = 1;
export const NATIVE_POLYGON_OUTLINE_WIDTH_MAX = 16;
export function defaultNativePolygonStyle(): NativePolygonStyle { return { fillColor: "#38bdf8", outlineColor: "#ffffff", outlineWidth: 2 }; }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function color(value: unknown): string {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw new AgentActionValidationError("Polygon fill and outline colors must be six-digit hex colors.");
  return value.toLowerCase();
}
function width(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < NATIVE_POLYGON_OUTLINE_WIDTH_MIN || value > NATIVE_POLYGON_OUTLINE_WIDTH_MAX) {
    throw new AgentActionValidationError(`Polygon outline width must be within [${NATIVE_POLYGON_OUTLINE_WIDTH_MIN}, ${NATIVE_POLYGON_OUTLINE_WIDTH_MAX}] pixels.`);
  }
  return value;
}
function keysValid(value: Record<string, unknown>): boolean {
  return Object.keys(value).every(key => key === "fillColor" || key === "outlineColor" || key === "outlineWidth");
}
export function readNativePolygonStyle(value: unknown): NativePolygonStyle {
  if (value === undefined) return defaultNativePolygonStyle();
  if (!object(value) || !keysValid(value)) throw new AgentActionValidationError("Polygon style must contain only fillColor, outlineColor and outlineWidth.");
  return { fillColor: color(value.fillColor), outlineColor: color(value.outlineColor), outlineWidth: width(value.outlineWidth) };
}
export function patchNativePolygonStyle(current: unknown, patch: unknown): NativePolygonStyle {
  if (!object(patch) || Object.keys(patch).length === 0 || !keysValid(patch)) {
    throw new AgentActionValidationError("Polygon style patch must contain fillColor, outlineColor and/or outlineWidth only.");
  }
  const update: Partial<NativePolygonStyle> = {};
  if (Object.hasOwn(patch, "fillColor")) update.fillColor = color(patch.fillColor);
  if (Object.hasOwn(patch, "outlineColor")) update.outlineColor = color(patch.outlineColor);
  if (Object.hasOwn(patch, "outlineWidth")) update.outlineWidth = width(patch.outlineWidth);
  return { ...readNativePolygonStyle(current), ...update };
}
