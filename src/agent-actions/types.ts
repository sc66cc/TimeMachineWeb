/**
 * Contract for the frontend action facade exposed on `window.timeMachineAgent`.
 *
 * The facade exists so automated tests and agents drive the same handlers the
 * UI drives, instead of synthesizing DOM clicks. It is an in-page interface
 * only: it adds no HTTP endpoint, no remote service and no change to the
 * Server. Handlers that do talk to the Server go through the app's existing
 * clients under the current session's permissions.
 *
 * Two rules are structural rather than stylistic:
 *
 * 1. Nothing sensitive is ever returned. `execute` params are never logged or
 *    persisted, and every result passes through `redactSensitive`, so a Token,
 *    password or digest cannot leak through `listActions`, `getState` or a
 *    result payload.
 * 2. Actions that reload the page answer `reloadRequired` instead of pretending
 *    to have finished. `bootId` changes on every page load, so a caller can
 *    wait for the new document before reading state again.
 */

export const AGENT_FACADE_VERSION = "1.0.0";

export type AgentActionStatus = "ready" | "unsupported";

export type AgentActionErrorKind =
  | "auth"
  | "busy"
  | "internal"
  | "unsupported"
  | "validation";

export interface AgentActionError {
  code: number;
  kind: AgentActionErrorKind;
  message: string;
}

/**
 * Structured JSON types only. There is deliberately no "json" string type: a
 * caller that needs a list or a record passes the real value, so a fake array
 * encoded as a string can never be mistaken for one.
 */
export type AgentActionParamType =
  | "array"
  | "boolean"
  | "number"
  | "object"
  | "string";

export interface AgentActionParam {
  description: string;
  name: string;
  required?: boolean;
  type: AgentActionParamType;
}

export interface AgentActionDefinition {
  /** Stable identifier. Never rename; add a new action instead. */
  id: string;
  description: string;
  params: readonly AgentActionParam[];
  status: AgentActionStatus;
  title: string;
}

export interface AgentActionSuccess {
  actionId: string;
  /** Present only for actions that schedule `window.location.reload()`. */
  data?: Record<string, unknown>;
  ok: true;
  /** True when the page is about to reload; read state again after `bootId`
   *  changes rather than assuming the action completed. */
  reloadRequired?: boolean;
}

export interface AgentActionFailure {
  actionId: string;
  error: AgentActionError;
  ok: false;
}

export type AgentActionResult = AgentActionFailure | AgentActionSuccess;

/** What a handler returns. `reloadRequired` must be set by the handler. */
export interface AgentActionOutcome {
  data?: Record<string, unknown>;
  reloadRequired?: boolean;
}

export type AgentActionHandler = (
  params: Record<string, unknown>,
) => Promise<AgentActionOutcome> | AgentActionOutcome;

export interface AgentStateSnapshot {
  /** Changes on every page load; use it to detect a reload-triggered action. */
  bootId: string;
  [section: string]: unknown;
}

export interface TimeMachineAgentFacade {
  /** Facade contract version, not the app version. */
  version: string;
  execute(
    actionId: string,
    params?: Record<string, unknown>,
  ): Promise<AgentActionResult>;
  getState(): AgentStateSnapshot;
  listActions(): AgentActionDefinition[];
}

const SENSITIVE_KEY = /authorization|digest|password|secret|token/i;

/** Replacement for a value whose key looks sensitive. */
export const REDACTED = "[redacted]";

/** Replacement for structure that is deeper than the snapshot budget. */
export const TRUNCATED = "[truncated]";

/**
 * Snapshot budget. Deeper structure is replaced by `TRUNCATED` rather than
 * returned as-is: a deep object must never be able to carry a nested secret
 * past the guard by hiding below the depth limit.
 */
const MAX_SNAPSHOT_DEPTH = 4;

/**
 * Safe deep copy used for every value that leaves the facade: state sections,
 * successful results and error payloads.
 *
 * - a key that looks sensitive is replaced by `REDACTED`;
 * - a plain string is passed through the same labeller used for error
 *   messages, so `catalog.error` holding a network failure such as
 *   `token=...` cannot leak the credential the key name never revealed;
 * - anything deeper than `MAX_SNAPSHOT_DEPTH` is replaced by `TRUNCATED`;
 * - cycles and shared references are replaced by `TRUNCATED` instead of
 *   recursing forever.
 *
 * Handlers are expected not to return secrets in the first place; this is the
 * backstop that makes that enforceable.
 */
export function redactSensitive(
  value: unknown,
  depth = 0,
  seen: Set<object> = new Set(),
): unknown {
  if (typeof value === "string") {
    // Only labelled `key=value` shapes are touched, so ordinary text such as a
    // dataset name or a status message survives unchanged.
    return redactErrorMessage(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (depth >= MAX_SNAPSHOT_DEPTH || seen.has(value)) {
    return TRUNCATED;
  }
  seen.add(value);
  const copy = Array.isArray(value)
    ? value.map((item) => redactSensitive(item, depth + 1, seen))
    : Object.fromEntries(
        Object.entries(value).map(([key, nested]) => [
          key,
          SENSITIVE_KEY.test(key)
            ? REDACTED
            : redactSensitive(nested, depth + 1, seen),
        ]),
      );
  seen.delete(value);
  return copy;
}

/**
 * `key=value` / `key: value` shapes that carry a credential, e.g.
 * `token=abc`, `Authorization: Bearer abc`, `password: "abc"`.
 */
const SENSITIVE_LABELLED_VALUE =
  /\b(authorization|proxy-authorization|access[_-]?token|refresh[_-]?token|api[_-]?key|password|passwd|pwd|secret|token|digest)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|(?:bearer|basic|token)\s+[^\s,;)}\]]+|[^\s,;)}\]]+)/gi;

/**
 * Removes credentials from a free-form error string: labelled `key=value`
 * pairs plus the literal values of the sensitive parameters of the call that
 * failed, so a handler cannot echo a submitted password back through its
 * message.
 */
export function redactErrorMessage(
  message: string,
  params: Record<string, unknown> = {},
): string {
  let redacted = message.replace(
    SENSITIVE_LABELLED_VALUE,
    (_match, label: string, separator: string) =>
      `${label}${separator}${REDACTED}`,
  );
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== "string" || value.length === 0 || !SENSITIVE_KEY.test(key)) {
      continue;
    }
    redacted = redacted.split(value).join(REDACTED);
  }
  return redacted;
}
