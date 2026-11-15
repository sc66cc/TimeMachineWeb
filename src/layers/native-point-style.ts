import { POINT_SIZE_MAX_PIXELS, POINT_SIZE_MIN_PIXELS, type PointStyleExpression } from "@timemachine/point-runtime";
import { AgentActionUnsupportedError, AgentActionValidationError } from "../agent-actions/registry";

export interface NativePointStyle { singleColor: string; pointSize: number }

export function defaultNativePointStyle(): PointStyleExpression {
  return { schemaVersion: 1, colorMode: "single", singleColor: "#ffffff", sizeMode: "fixed", pointSize: 6,
    shape: "circle", occurrenceSizeScale: 1, filter: { plateId: null, minimumOccurrence: 0, maximumOccurrence: 65535 } };
}

const styleFields = new Set(Object.keys(defaultNativePointStyle()));
const filterFields = new Set(["plateId", "minimumOccurrence", "maximumOccurrence"]);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function color(value: unknown): string {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw new AgentActionValidationError("Point color must be a six-digit hex color.");
  return value.toLowerCase();
}

function size(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < POINT_SIZE_MIN_PIXELS || value > POINT_SIZE_MAX_PIXELS) {
    throw new AgentActionValidationError(`Point size must be within [${POINT_SIZE_MIN_PIXELS}, ${POINT_SIZE_MAX_PIXELS}] pixels.`);
  }
  return value;
}

/** Existing GPU expressions are preserved in storage; unsupported native modes fail explicitly. */
export function readNativePointStyle(style: PointStyleExpression | undefined): NativePointStyle {
  if (style === undefined) return { singleColor: "#ffffff", pointSize: 6 };
  if (!object(style) || Object.keys(style).some(key => !styleFields.has(key)) || !object(style.filter) ||
      Object.keys(style.filter).some(key => !filterFields.has(key))) {
    throw new AgentActionValidationError("Point style must be a supported expression object.");
  }
  const singleColor = color(style.singleColor), pointSize = size(style.pointSize);
  if (style.schemaVersion !== 1 || style.colorMode !== "single" || style.sizeMode !== "fixed" || style.shape !== "circle" ||
      style.occurrenceSizeScale !== 1 || style.filter.plateId !== null || style.filter.minimumOccurrence !== 0 || style.filter.maximumOccurrence !== 65535) {
    throw new AgentActionUnsupportedError("Ordinary points support single color, fixed size and circles only; thematic styles and filters are not implemented.");
  }
  return { singleColor, pointSize };
}

/** Strict patch validation precedes defaults or normalization; no unsupported field is discarded. */
export function patchNativePointStyle(current: PointStyleExpression | undefined, patch: unknown): PointStyleExpression {
  if (!object(patch) || Object.keys(patch).length === 0 || Object.keys(patch).some(key => key !== "singleColor" && key !== "pointSize")) {
    throw new AgentActionValidationError("Point style patch must contain only singleColor and/or pointSize.");
  }
  const update: Partial<NativePointStyle> = {};
  if (Object.hasOwn(patch, "singleColor")) update.singleColor = color(patch.singleColor);
  if (Object.hasOwn(patch, "pointSize")) update.pointSize = size(patch.pointSize);
  return { ...defaultNativePointStyle(), ...readNativePointStyle(current), ...update };
}
