import { AgentActionValidationError } from "../agent-actions/registry";

export interface NativeLineStyle { lineColor: string; lineWidth: number }

/** Current engineering display bounds; not a scientific sampling/precision tolerance. */
export const NATIVE_LINE_WIDTH_MIN = 1;
export const NATIVE_LINE_WIDTH_MAX = 16;
export function defaultNativeLineStyle(): NativeLineStyle { return { lineColor: "#38bdf8", lineWidth: 2 }; }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function color(value: unknown): string {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw new AgentActionValidationError("Line color must be a six-digit hex color.");
  return value.toLowerCase();
}
function width(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < NATIVE_LINE_WIDTH_MIN || value > NATIVE_LINE_WIDTH_MAX) {
    throw new AgentActionValidationError(`Line width must be within [${NATIVE_LINE_WIDTH_MIN}, ${NATIVE_LINE_WIDTH_MAX}] pixels.`);
  }
  return value;
}
export function readNativeLineStyle(value: unknown): NativeLineStyle {
  if (value === undefined) return defaultNativeLineStyle();
  if (!object(value) || Object.keys(value).some(key => key !== "lineColor" && key !== "lineWidth")) {
    throw new AgentActionValidationError("Line style must contain only lineColor and lineWidth.");
  }
  return { lineColor: color(value.lineColor), lineWidth: width(value.lineWidth) };
}
export function patchNativeLineStyle(current: unknown, patch: unknown): NativeLineStyle {
  if (!object(patch) || Object.keys(patch).length === 0 || Object.keys(patch).some(key => key !== "lineColor" && key !== "lineWidth")) {
    throw new AgentActionValidationError("Line style patch must contain only lineColor and/or lineWidth.");
  }
  const update: Partial<NativeLineStyle> = {};
  if (Object.hasOwn(patch, "lineColor")) update.lineColor = color(patch.lineColor);
  if (Object.hasOwn(patch, "lineWidth")) update.lineWidth = width(patch.lineWidth);
  return { ...readNativeLineStyle(current), ...update };
}
