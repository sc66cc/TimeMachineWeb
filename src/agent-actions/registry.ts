import {
  AGENT_FACADE_VERSION,
  redactErrorMessage,
  redactSensitive,
  type AgentActionDefinition,
  type AgentActionError,
  type AgentActionErrorKind,
  type AgentActionHandler,
  type AgentActionResult,
  type AgentActionOutcome,
  type AgentStateSnapshot,
  type TimeMachineAgentFacade,
} from "./types";

const ERROR_CODES: Record<AgentActionErrorKind, number> = {
  auth: 401,
  busy: 409,
  internal: 500,
  unsupported: 501,
  validation: 400,
};

function failure(
  actionId: string,
  kind: AgentActionErrorKind,
  message: string,
  params: Record<string, unknown> = {},
): AgentActionResult {
  const error: AgentActionError = {
    code: ERROR_CODES[kind],
    kind,
    message: redactErrorMessage(message, params),
  };
  return { actionId, error, ok: false };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Base class for the failures a handler raises on purpose. `kind` selects the
 * reported error code, so an auth problem is never filed as an internal error
 * and a rejected parameter is never filed as a missing feature.
 */
export class AgentActionFailureError extends Error {
  readonly kind: AgentActionErrorKind;

  constructor(kind: AgentActionErrorKind, message: string) {
    super(message);
    this.name = "AgentActionFailureError";
    this.kind = kind;
  }
}

/** Thrown by a handler to report an authentication/authorization problem. */
export class AgentActionAuthError extends AgentActionFailureError {
  constructor(message: string) {
    super("auth", message);
    this.name = "AgentActionAuthError";
  }
}

/** Thrown by a handler for a parameter value it refuses to act on. */
export class AgentActionValidationError extends AgentActionFailureError {
  constructor(message: string) {
    super("validation", message);
    this.name = "AgentActionValidationError";
  }
}

/** Thrown by a handler for a feature this build cannot provide. */
export class AgentActionUnsupportedError extends AgentActionFailureError {
  constructor(message: string) {
    super("unsupported", message);
    this.name = "AgentActionUnsupportedError";
  }
}

/** Thrown by a handler while another run of the same action is in flight. */
export class AgentActionBusyError extends AgentActionFailureError {
  constructor(message: string) {
    super("busy", message);
    this.name = "AgentActionBusyError";
  }
}

function kindOf(error: unknown): AgentActionErrorKind {
  return error instanceof AgentActionFailureError ? error.kind : "internal";
}

/**
 * In-page registry behind `window.timeMachineAgent`.
 *
 * UI code registers a handler once and both the button and the facade call it,
 * so validation, authorization and async completion are defined in exactly one
 * place. There is deliberately no reflection over `window` and no synthetic
 * click: an action that has no handler is reported as unsupported rather than
 * approximated.
 */
class AgentActionRegistry implements TimeMachineAgentFacade {
  readonly version = AGENT_FACADE_VERSION;

  private readonly definitions = new Map<string, AgentActionDefinition>();
  private readonly handlers = new Map<string, AgentActionHandler>();
  private readonly sections = new Map<
    string,
    () => Record<string, unknown>
  >();
  /** Live "not right now" reasons, evaluated on every read. */
  private readonly availability = new Map<string, () => string | undefined>();
  private readonly bootId = `boot-${Math.random().toString(36).slice(2, 10)}`;

  register(definition: AgentActionDefinition, handler?: AgentActionHandler): void {
    this.definitions.set(definition.id, definition);
    if (handler) {
      this.handlers.set(definition.id, handler);
    } else {
      this.handlers.delete(definition.id);
    }
  }

  /**
   * Attaches a live availability reason to an action that keeps its handler.
   *
   * `listActions()` and `execute()` evaluate the predicate on every call, so a
   * capability discovered after registration (the V2 workspace handshake
   * resolving to `true`, or a Server that turns out to be V1-only) is reported
   * honestly without un-registering and re-registering the real handler.
   */
  setAvailability(id: string, reason: () => string | undefined): void {
    this.availability.set(id, reason);
  }

  private availabilityReason(id: string): string | undefined {
    const reason = this.availability.get(id);
    return reason ? reason() : undefined;
  }

  /** Declares an action with no implementation, so it is reported honestly. */
  registerUnsupported(id: string, title: string, reason: string): void {
    this.register({
      description: reason,
      id,
      params: [],
      status: "unsupported",
      title,
    });
  }

  /**
   * `listActions()` reports an action as unsupported while it has no handler,
   * so the inventory is always an honest description of this build.
   */

  registerStateSection(
    section: string,
    provider: () => Record<string, unknown>,
  ): void {
    this.sections.set(section, provider);
  }

  listActions(): AgentActionDefinition[] {
    return [...this.definitions.values()]
      .map((definition) => ({
        ...definition,
        // Deep copy: the caller must never receive the registered objects.
        params: definition.params.map((param) => ({ ...param })),
        status:
          this.handlers.has(definition.id) &&
          this.availabilityReason(definition.id) === undefined
            ? definition.status
            : "unsupported",
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  getState(): AgentStateSnapshot {
    const snapshot: AgentStateSnapshot = { bootId: this.bootId };
    for (const [section, provider] of this.sections) {
      try {
        // redactSensitive is also the deep copy, so a provider's internal
        // objects are never handed to the caller.
        snapshot[section] = redactSensitive(provider());
      } catch (error) {
        snapshot[section] = { error: redactErrorMessage(messageOf(error)) };
      }
    }
    return snapshot;
  }

  async execute(
    actionId: string,
    params: Record<string, unknown> = {},
  ): Promise<AgentActionResult> {
    const definition = this.definitions.get(actionId);
    if (!definition) {
      return failure(
        actionId,
        "validation",
        `Unknown action "${actionId}". Call listActions() for the available ids.`,
      );
    }
    if (definition.status === "unsupported") {
      return failure(
        actionId,
        "unsupported",
        definition.description || `Action "${actionId}" is not supported yet.`,
      );
    }
    const handler = this.handlers.get(actionId);
    if (!handler) {
      return failure(
        actionId,
        "unsupported",
        `Action "${actionId}" is declared but has no handler in this build.`,
      );
    }
    // Evaluated live: a capability that is unavailable right now fails as
    // unsupported, and becomes usable the moment it appears.
    const unavailable = this.availabilityReason(actionId);
    if (unavailable) {
      return failure(actionId, "unsupported", unavailable);
    }

    const validated = this.validate(definition, params);
    if (validated) {
      return failure(actionId, "validation", validated, params);
    }

    try {
      const outcome = (await handler(params)) as AgentActionOutcome;
      if (typeof outcome !== "object" || outcome === null) {
        return failure(
          actionId,
          "internal",
          `Action "${actionId}" handler returned no outcome.`,
        );
      }
      return {
        actionId,
        data: redactSensitive(outcome.data ?? {}) as Record<string, unknown>,
        ok: true,
        reloadRequired: outcome.reloadRequired === true,
      };
    } catch (error) {
      // Auth failures are surfaced as such so a caller can re-authenticate
      // instead of retrying a request that will keep failing.
      const kind = kindOf(error);
      return {
        actionId,
        error: {
          code: ERROR_CODES[kind],
          kind,
          message: redactErrorMessage(messageOf(error), params),
        },
        ok: false,
      };
    }
  }

  private validate(
    definition: AgentActionDefinition,
    params: Record<string, unknown>,
  ): string | undefined {
    if (typeof params !== "object" || params === null) {
      return `Action "${definition.id}" expects a JSON object of parameters.`;
    }
    for (const param of definition.params) {
      const value = params[param.name];
      if (value === undefined || value === null) {
        if (param.required) {
          return `Action "${definition.id}" requires "${param.name}" (${param.type}).`;
        }
        continue;
      }
      switch (param.type) {
        case "array":
          if (!Array.isArray(value)) {
            return `Action "${definition.id}" parameter "${param.name}" must be an array.`;
          }
          break;
        case "object":
          if (typeof value !== "object" || Array.isArray(value)) {
            return `Action "${definition.id}" parameter "${param.name}" must be an object.`;
          }
          break;
        default:
          // eslint-disable-next-line valid-typeof
          if (typeof value !== param.type) {
            return `Action "${definition.id}" parameter "${param.name}" must be a ${param.type}.`;
          }
      }
      if (
        param.type === "number" &&
        !Number.isFinite(value as number)
      ) {
        return `Action "${definition.id}" parameter "${param.name}" must be a finite number.`;
      }
    }
    return undefined;
  }
}

export const agentActions = new AgentActionRegistry();

/**
 * Publishes exactly the four facade methods. The registry itself (and its
 * `register`/`registerStateSection` registerers and internal maps) stays
 * unreachable from the page, so a caller cannot rewrite the app's actions or
 * plant a state provider.
 */
export function installAgentActions(target: Window = window): void {
  const facade: TimeMachineAgentFacade = Object.freeze({
    version: agentActions.version,
    execute: (
      actionId: string,
      params?: Record<string, unknown>,
    ): Promise<AgentActionResult> => agentActions.execute(actionId, params),
    getState: (): AgentStateSnapshot => agentActions.getState(),
    listActions: (): AgentActionDefinition[] => agentActions.listActions(),
  });
  Object.defineProperty(target, "timeMachineAgent", {
    configurable: true,
    enumerable: true,
    value: facade,
    writable: false,
  });
}
