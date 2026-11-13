import { AgentActionUnsupportedError } from "../agent-actions/registry";

/**
 * The one wording for "this Server speaks V1 only". Both the runtime guard and
 * the live availability predicate use it, so a caller sees the same message
 * whether the action failed or was never available.
 */
export function v2WorkspaceUnavailableReason(
  capability: "cloud projects" | "dataset ingest",
): string {
  return `This Server does not implement the TimeMachine V2 workspace endpoints, so ${capability} are unavailable.`;
}

/**
 * V2-only features must be reported as unsupported rather than attempted, so a
 * Server that only speaks V1 never produces a confusing internal error. Both
 * the UI handlers and the action handlers call this one function.
 */
export function requireV2Workspace(
  available: boolean,
  capability: "cloud projects" | "dataset ingest",
): void {
  if (!available) {
    throw new AgentActionUnsupportedError(
      v2WorkspaceUnavailableReason(capability),
    );
  }
}
