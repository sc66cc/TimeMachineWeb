import { AgentActionValidationError } from "../agent-actions/registry";
import { REDACTED, TRUNCATED, redactErrorMessage, redactSensitive } from "../agent-actions/types";

/** Engineering output limits, not scientific/data validity thresholds. Lengths are UTF-16 code units. */
export const FEATURE_ATTRIBUTE_LIMITS = Object.freeze({
  topLevelFields: 32, fieldNameLength: 128, depth: 4,
  arrayLength: 32, visitedNodes: 512, stringLength: 2048,
});

export type FeatureAttributeValue =
  | null | boolean | number | string
  | FeatureAttributeValue[] | { [key: string]: FeatureAttributeValue };

export interface FeatureAttributeSummary {
  attributes: Record<string, FeatureAttributeValue> | null;
  truncated: boolean;
  missingFields: string[];
}

interface Budget {
  remaining: number;
  truncated: boolean;
  ancestors: Set<object>;
}

function validateFields(options: { fields?: string[] } | undefined): string[] | undefined {
  if (options === undefined) return undefined;
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new AgentActionValidationError("Attribute options must be an object.");
  }
  if (Reflect.ownKeys(options).some((key) => key !== "fields")) {
    throw new AgentActionValidationError("Only fields is supported in attribute options.");
  }
  const descriptor = Object.getOwnPropertyDescriptor(options, "fields");
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) {
    throw new AgentActionValidationError("Attribute fields must be a data value.");
  }
  const fields: unknown = descriptor.value;
  if (fields === undefined) return undefined;
  if (!Array.isArray(fields) || fields.length > FEATURE_ATTRIBUTE_LIMITS.topLevelFields) {
    throw new AgentActionValidationError("Attribute fields must contain at most 32 names.");
  }
  const selected: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < fields.length; index += 1) {
    const item = Object.getOwnPropertyDescriptor(fields, String(index));
    const field: unknown = item && "value" in item ? item.value : undefined;
    if (typeof field !== "string" || field.length > FEATURE_ATTRIBUTE_LIMITS.fieldNameLength
      || field.trim().length === 0 || seen.has(field)) {
      throw new AgentActionValidationError("Attribute fields must be unique nonempty names of at most 128 characters.");
    }
    if (safeText(field) !== field) {
      throw new AgentActionValidationError("Attribute field names must not contain URLs or credential text.");
    }
    selected.push(field);
    seen.add(field);
  }
  return selected;
}

// Apply existing labelled-secret rules only after bounding text. URL/auth patterns
// match the local logger's safe text policy; no raw attribute enters that logger.
function safeText(value: string): string {
  const bounded = value.slice(0, FEATURE_ATTRIBUTE_LIMITS.stringLength);
  // A cut JWT may no longer have three complete segments. Remove its remaining
  // prefix at the cut boundary rather than returning header/payload fragments.
  const prefixSafe = value.length > bounded.length
    ? bounded.replace(/\beyJ[a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]*){0,2}$/, REDACTED)
    : bounded;
  const stripped = prefixSafe
    .replace(/\b(?:https?|wss?|file|ftp):\/\/[^\s<>"']+/gi, REDACTED)
    .replace(/\b(?:data|blob):[^\s<>"']+/gi, REDACTED)
    .replace(/(?:\/|\.{1,2}\/)[^\s"'<>?]*\?[^\s"'<>]+/g, REDACTED)
    .replace(/\?[a-zA-Z0-9_.%~-]+=[^\s"'<>]+/g, REDACTED)
    .replace(/["'](?:authorization|proxy-authorization|access[_-]?token|refresh[_-]?token|api[_-]?key|password|passwd|pwd|secret|token|digest)["']\s*:\s*(?:"(?:\\[\s\S]|[^"\\])*(?:\\?$|")|'(?:\\[\s\S]|[^'\\])*(?:\\?$|'))/gi, REDACTED)
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;)}\]"']+/gi, REDACTED)
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, REDACTED);
  return redactErrorMessage(stripped).slice(0, FEATURE_ATTRIBUTE_LIMITS.stringLength);
}

function sensitiveKey(key: string): boolean {
  // The existing helper only sees a bounded, locally created object, never source data.
  const probe = redactSensitive({ [key]: null }) as Record<string, unknown>;
  return probe[key] === REDACTED || /^(?:api[_-]?key|passwd|pwd)$/i.test(key);
}

function unavailable(budget: Budget, marker: string): string {
  budget.truncated = true;
  return marker;
}

function valueSummary(value: unknown, depth: number, budget: Budget): FeatureAttributeValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const safe = safeText(value);
    if (safe !== value) budget.truncated = true;
    return safe;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : Number.isNaN(value) ? "[NaN]" : value > 0 ? "[Infinity]" : "[-Infinity]";
  }
  if (typeof value !== "object") return unavailable(budget, `[unsupported:${typeof value}]`);
  if (budget.ancestors.has(value)) return unavailable(budget, "[circular]");
  if (depth >= FEATURE_ATTRIBUTE_LIMITS.depth) return unavailable(budget, TRUNCATED);
  const array = Array.isArray(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!array && prototype !== Object.prototype && prototype !== null) {
    return unavailable(budget, "[unsupported:object]");
  }
  budget.ancestors.add(value);
  try {
    if (!array) return objectSummary(value, depth, budget);
    const output: FeatureAttributeValue[] = [];
    const length = Math.min(value.length, FEATURE_ATTRIBUTE_LIMITS.arrayLength);
    if (length < value.length) budget.truncated = true;
    for (let index = 0; index < length; index += 1) {
      if (budget.remaining === 0) {
        budget.truncated = true;
        break;
      }
      budget.remaining -= 1;
      output.push(descriptorSummary(Object.getOwnPropertyDescriptor(value, String(index)), undefined, depth + 1, budget));
    }
    return output;
  } finally {
    budget.ancestors.delete(value);
  }
}

function descriptorSummary(
  descriptor: PropertyDescriptor | undefined, key: string | undefined, depth: number, budget: Budget,
): FeatureAttributeValue {
  if (key !== undefined && sensitiveKey(key)) return unavailable(budget, REDACTED);
  if (descriptor && !("value" in descriptor)) return unavailable(budget, "[unavailable:accessor]");
  return valueSummary(descriptor?.value, depth, budget);
}

function safeKey(key: string, budget: Budget): boolean {
  if (key.length <= FEATURE_ATTRIBUTE_LIMITS.fieldNameLength && safeText(key) === key) return true;
  budget.truncated = true;
  return false;
}

function objectSummary(value: object, depth: number, budget: Budget): Record<string, FeatureAttributeValue> {
  const output = Object.create(null) as Record<string, FeatureAttributeValue>;
  let count = 0;
  // for-in yields own enumerable keys before inherited keys. Stop at the first
  // inherited item; do not materialize a full key/value list or traverse prototypes.
  for (const key in value) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) break;
    if ((depth === 0 && count === FEATURE_ATTRIBUTE_LIMITS.topLevelFields) || budget.remaining === 0) {
      budget.truncated = true;
      break;
    }
    budget.remaining -= 1;
    if (!safeKey(key, budget)) continue;
    output[key] = descriptorSummary(descriptor, key, depth + 1, budget);
    count += 1;
  }
  return output;
}

/**
 * Project one feature's attributes without cloning its source row/dataset.
 * Only own data properties are read; getters/toJSON are never invoked. Accessors,
 * cycles and unsupported values use explicit markers. Nonfinite numbers use
 * [NaN]/[Infinity]/[-Infinity], preserving their distinction through JSON.
 *
 * `truncated` includes redaction/omission/unavailable values, but not absent or
 * unselected fields. `missingFields` contains only requested absent own keys.
 * Native/class instances are not traversed. Input must be ordinary data, not a
 * Proxy: JavaScript property introspection cannot avoid arbitrary Proxy traps.
 */
export function summarizeFeatureAttributes(
  attributes: Record<string, unknown> | null,
  options?: { fields?: string[] },
): FeatureAttributeSummary {
  const fields = validateFields(options);
  if (attributes === null) return { attributes: null, truncated: false, missingFields: fields ?? [] };
  if (typeof attributes !== "object" || Array.isArray(attributes)) {
    throw new AgentActionValidationError("Feature attributes must be an object or null.");
  }
  const budget: Budget = { remaining: FEATURE_ATTRIBUTE_LIMITS.visitedNodes - 1, truncated: false, ancestors: new Set([attributes]) };
  if (fields === undefined) {
    return { attributes: objectSummary(attributes, 0, budget), truncated: budget.truncated, missingFields: [] };
  }
  const output = Object.create(null) as Record<string, FeatureAttributeValue>;
  const missingFields: string[] = [];
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(attributes, field);
    if (!descriptor) {
      missingFields.push(field);
    } else if (budget.remaining === 0) {
      budget.truncated = true;
    } else {
      budget.remaining -= 1;
      if (safeKey(field, budget)) output[field] = descriptorSummary(descriptor, field, 1, budget);
    }
  }
  return { attributes: output, truncated: budget.truncated, missingFields };
}
