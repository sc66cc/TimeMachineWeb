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
import {
  basicContractDetails, validateApiInput,
  type ApiContractMetadata, type ApiContractDetails, type ApiSummary,
  type ApiDescriptor, type CatalogFilter, type ExecuteOptions, type ApiResult,
  type FrontendApiV2, type AppEvent, type EventFilter, type ApiTerminalResult, type WaitOptions, type ApiSchema,
} from "./contracts";
import { StateEvents, EVENT_TYPES, EVENT_LIMITS } from "./events";
import { OperationJobs } from "./jobs";
import { OperationInterruptedError, type OperationContext } from "./operation";
import { DiagnosticsLogger, type LogFilter } from "../diagnostics/logger";
import { AUXILIARY_IDS, auxiliarySummary, describeAuxiliary } from "./auxiliary-catalog";
import packageMetadata from "../../package.json";

const SNAPSHOT_QUERIES = new Map<string, string | undefined>([
  ["scene.snapshot", undefined], ["project.snapshot", "project"], ["ui.snapshot", "ui"],
]);

// Only summaries belong to startup. Provenance and planned schemas load on describe.
const RESERVED_CATALOG: Readonly<Record<string, Pick<ApiSummary, "title" | "kind" | "scope" | "effect" | "requirements">>> = {
  "service.TimeMachinePlatform.GetCapabilities": {
    title: "Describe the platform capability service", kind: "service", scope: "existing", effect: "read", requirements: ["configured-service"],
  },
  "service.UserPlateModel.Display": {
    title: "Describe the public plate model catalog service", kind: "service", scope: "existing", effect: "read", requirements: ["configured-service"],
  },
  "service.UserPlateModel.DisplayMine": {
    title: "Describe the account plate model catalog service", kind: "service", scope: "existing", effect: "read", requirements: ["configured-service", "authenticated-account"],
  },
  "service.UserPlateModel.GetDetail": {
    title: "Describe the plate model detail service", kind: "service", scope: "existing", effect: "read", requirements: ["configured-service", "resource-access-permission"],
  },
  "feature.pick": { title: "Pick a feature in a viewport", kind: "command", scope: "p0-p3", effect: "ui-local", requirements: ["P2-05-selection-adapter"] },
  "feature.select": { title: "Select a feature by its stable identity", kind: "command", scope: "p0-p3", effect: "ui-local", requirements: ["P2-05-selection-adapter"] },
  "feature.clear": { title: "Clear feature selection", kind: "command", scope: "p0-p3", effect: "ui-local", requirements: ["P2-05-selection-adapter"] },
  "selection.snapshot": { title: "Read feature selection", kind: "query", scope: "p0-p3", effect: "read", requirements: ["P2-05-selection-adapter"] },
  "feature.attributes": { title: "Read source feature attributes", kind: "query", scope: "p0-p3", effect: "read", requirements: ["P2-05-selection-adapter"] },
  "feature.queryBox": { title: "Query visible features in a screen rectangle", kind: "query", scope: "p0-p3", effect: "read", requirements: ["P2-05-selection-adapter"] },
  "model.bind": { title: "Bind a model to a viewport or layer", kind: "command", scope: "p0-p3", effect: "remote-write", requirements: ["P3-01-model-binding"] },
  "model.setAnchor": { title: "Set a model binding's anchor plate", kind: "command", scope: "p0-p3", effect: "remote-write", requirements: ["P3-01-model-binding"] },
  "viewport.create": { title: "Create a viewport", kind: "command", scope: "p0-p3", effect: "remote-write", requirements: ["P3-07-viewports"] },
  "viewport.close": { title: "Close a viewport and release its resources", kind: "command", scope: "p0-p3", effect: "remote-write", requirements: ["P3-07-viewports"] },
  "viewport.activate": { title: "Activate an existing viewport", kind: "command", scope: "p0-p3", effect: "ui-local", requirements: ["P3-07-viewports"] },
  "viewport.layout": { title: "Set the viewport layout", kind: "command", scope: "p0-p3", effect: "remote-write", requirements: ["P3-07-viewports"] },
  "camera.sync": { title: "Configure camera synchronization between viewports", kind: "command", scope: "p0-p3", effect: "remote-write", requirements: ["P3-07-viewports"] },
  "raster.sample": { title: "Read an original raster value", kind: "query", scope: "p0-p3", effect: "read", requirements: ["P3-06-original-value-source"] },
  "viewports.snapshot": { title: "Read viewport bindings and committed states", kind: "query", scope: "p0-p3", effect: "read", requirements: ["P3-07-viewports"] },
};

function reservedSummary(id: string): ApiSummary | undefined {
  if (!Object.hasOwn(RESERVED_CATALOG, id)) return;
  const entry = RESERVED_CATALOG[id]!;
  return {
    ...structuredClone(entry), id, version: "2.0.0", schemaRef: `reserved:${id}:v2`,
    availability: "not-implemented", completion: "unverified",
    ...(entry.effect === "remote-write" ? {
      completionNote: "Planned configuration may be persisted to an authenticated cloud project; effect is conservative. This reserved entry performs no operation or write.",
    } : {}),
    reason: entry.kind === "service"
      ? "Service metadata only; the existing internal client does not expose a v2 service invocation."
      : "Reserved by the migration plan; this operation is not implemented in this build.",
  };
}

function eventDetails(id: AppEvent["type"]): ApiContractDetails {
  const properties: Record<string, ApiSchema> = {
    type: { type: "string", enum: [id] }, bootId: { type: "string" },
    sequence: { type: "integer", minimum: 1, description: "Delivery order within this boot; filtered events may leave gaps." },
    revision: { type: "integer", minimum: 0, description: "Captured state revision; operation completion uses its committed revision, not delivery time." },
    droppedCount: { type: "integer", minimum: 0, description: "Cumulative queue or merged-section overflow count. Requery state/jobs when it increases." },
  };
  const required = Object.keys(properties);
  if (id === "state.changed") {
    properties.sections = { type: "array", description: "At most 64 section names, each at most 64 characters.", items: { type: "string" } };
    required.push("sections");
  } else {
    for (const key of ["traceId", "actionId", "jobId"]) properties[key] = { type: "string", description: "Operation identifier, bounded to 128 characters; no user input or result body." };
    required.push("traceId", "actionId");
    if (id === "job.changed") {
      properties.phase = { type: "string", enum: ["accepted", "terminal"] };
      properties.status = { type: "string", enum: ["running", "completed", "failed", "unknown", "cancelled", "superseded"] };
      required.push("jobId", "phase", "status");
    }
  }
  return {
    inputSchema: { type: "object", additionalProperties: false, properties: {
      types: { type: "array", description: "At most 3 event types; an empty list matches nothing.", items: { type: "string", enum: EVENT_TYPES } },
      sections: { type: "array", description: "At most 64 names of at most 64 characters. Matches state.changed only; excludes job/frame events.", items: { type: "string" } },
    } },
    outputSchema: { type: "object", properties, required, additionalProperties: false }, examples: [],
  };
}

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
  if (error instanceof OperationInterruptedError) return "busy";
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
class AgentActionRegistry {
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
  readonly stateEvents = new StateEvents(this.bootId);
  readonly jobs = new OperationJobs(this.bootId);
  readonly diagnostics = new DiagnosticsLogger({ bootId: this.bootId, appVersion: packageMetadata.version });
  private revision = 0;
  private readonly stateFingerprints = new Map<string, string>();
  private traceSequence = 0;
  private readonly contracts = new Map<string, {
    metadata: ApiContractMetadata;
    load?: () => Promise<ApiContractDetails>;
    details?: Promise<ApiContractDetails>;
  }>();

  /** Contract metadata only. Both versions still use the single handler map. */
  setContract(id: string, metadata: ApiContractMetadata, load?: () => Promise<ApiContractDetails>): void {
    this.contracts.set(id, { metadata: structuredClone(metadata), load });
  }

  listCatalog(filter: CatalogFilter = {}): ApiSummary[] {
    return [...new Set([...this.definitions.keys(), ...SNAPSHOT_QUERIES.keys(), ...EVENT_TYPES, ...AUXILIARY_IDS, ...Object.keys(RESERVED_CATALOG)])].map(id => this.summary(id)!).filter(item =>
      (!filter.idPrefix || item.id.startsWith(filter.idPrefix)) &&
      (!filter.kind || item.kind === filter.kind) &&
      (!filter.scope || item.scope === filter.scope) &&
      (!filter.availability || item.availability === filter.availability),
    ).sort((a, b) => a.id.localeCompare(b.id));
  }

  private summary(id: string): ApiSummary | undefined {
    const auxiliary = auxiliarySummary(id, this.stateEvents.isClosed);
    if (auxiliary) return auxiliary;
    if ((EVENT_TYPES as readonly string[]).includes(id)) return {
      id, title: "Observe application changes", version: "2.0.0", schemaRef: `event:${id}:v2`, kind: "event",
      scope: "p0-p3", effect: "read", completion: id === "frame.committed" ? "frame-committed" : "state-committed", requirements: [],
      availability: this.stateEvents.isClosed ? "unavailable" : "ready",
      ...(this.stateEvents.isClosed ? { reason: "This document's event stream is closed." } : {}),
    };
    if (SNAPSHOT_QUERIES.has(id)) {
      const section = SNAPSHOT_QUERIES.get(id);
      const available = section === undefined || this.sections.has(section);
      return {
        id, title: "Read authoritative application state",
        version: "2.0.0", schemaRef: `state:${id}:v2`, kind: "query",
        scope: "p0-p3", effect: "read", completion: "state-committed", requirements: section ? [`state-section:${section}`] : [],
        availability: available ? "ready" : "unavailable",
        ...(available ? {} : { reason: "This state provider is not attached yet." }),
      };
    }
    const definition = this.definitions.get(id);
    if (!definition) return reservedSummary(id);
    const metadata = this.contracts.get(id)?.metadata ?? {
      kind: "command", scope: "existing", effect: "project-local",
      completion: "unverified", requirements: [],
    } satisfies ApiContractMetadata;
    let availability: ApiSummary["availability"] = "ready";
    let reason: string | undefined;
    if (metadata.scope === "excluded") {
      availability = "out-of-scope";
      reason = "This operation is outside the migration scope.";
    } else if (definition.status === "unsupported" || !this.handlers.has(id)) {
      availability = "not-implemented";
      reason = definition.status === "unsupported" ? definition.description : "No handler is attached in this build.";
    } else if (metadata.scope === "future") {
      availability = "out-of-scope";
      reason = "This operation belongs to a later migration phase.";
    } else {
      try { reason = this.availabilityReason(id); }
      catch (error) { reason = `Capability check failed: ${messageOf(error)}`; }
      if (reason !== undefined) availability = "unavailable";
      else if (metadata.completion === "unverified" || metadata.completion === "page-reload") {
        availability = "not-implemented";
        reason = "The v2 completion contract is not implemented yet; the legacy action remains available through v1.";
      }
    }
    return {
      ...structuredClone(metadata), id, title: redactErrorMessage(definition.title),
      version: "2.0.0", schemaRef: `action:${id}:v2`, availability,
      ...(reason === undefined ? {} : { reason: redactErrorMessage(reason) }),
    };
  }

  async describe(id: string): Promise<ApiDescriptor | undefined> {
    const auxiliary = describeAuxiliary(id, this.stateEvents.isClosed);
    if (auxiliary) return auxiliary;
    if ((EVENT_TYPES as readonly string[]).includes(id)) return {
      ...this.summary(id)!,
      description: `${id === "state.changed" ? "Coalesced state invalidation without a fabricated trace; subscribe before querying and compare revision."
        : id === "job.changed" ? "Actual v2 job acceptance and one owner-confirmed terminal outcome; cancellation requests and wait timeouts are not terminal events."
          : "Successful operations whose startup contract proves frame commit. V1/UI and inline operations omit jobId; unverified operations emit no frame."} ` +
        `Advisory notifications: ${EVENT_LIMITS.subscribers} subscribers, ${EVENT_LIMITS.queuedOperations} queued operation events; overflow drops oldest events and increments droppedCount. State merges at most ${EVENT_LIMITS.sections} sections; excess invalidations also increment droppedCount. ` +
        "No replay or guaranteed terminal delivery after overflow/close. Use jobs.get/wait and authoritative queries; unsubscribe when finished.",
      ...eventDetails(id as AppEvent["type"]),
    };
    if (SNAPSHOT_QUERIES.has(id)) return {
      ...this.summary(id)!, description: "Returns a safe copy with bootId and revision; requested and committed state stay separate.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", additionalProperties: true }, examples: [],
    };
    if (!this.definitions.has(id)) {
      const summary = reservedSummary(id);
      if (!summary) return;
      const { reservedContractDetails } = await import("./reserved-catalog");
      // Registration may arrive while the detail chunk loads; it owns this ID.
      if (this.definitions.has(id)) return this.describe(id);
      return { ...summary, ...structuredClone(reservedContractDetails(id)) };
    }
    const contract = this.contracts.get(id);
    let details: ApiContractDetails;
    if (contract?.load) {
      // Single-flight, retryable after failure; never hand cached objects out.
      contract.details ??= Promise.resolve().then(contract.load).then(value => structuredClone(value)).catch(error => {
        contract.details = undefined;
        throw error;
      });
      details = await contract.details;
    } else details = basicContractDetails(this.definitions.get(id)!);
    return {
      ...this.summary(id)!, description: redactErrorMessage(this.definitions.get(id)!.description),
      ...structuredClone(details), examples: redactSensitive(details.examples) as unknown[],
    };
  }

  async executeV2(id: string, input: unknown = {}, options: ExecuteOptions = {}): Promise<ApiResult> {
    const traceId = `${this.bootId}:action-${++this.traceSequence}`;
    const completion = this.contracts.get(id)?.metadata.completion;
    const startedAt = this.startAction(id, traceId);
    const result = await this.executeV2Command(id, input, options, traceId, startedAt, completion);
    // A timed-out waiter is not the operation's terminal outcome. Jobs record
    // their own one terminal result when the real owner settles.
    if (!result.jobId) this.finishAction(id, traceId, startedAt, result, completion);
    return result;
  }

  private async executeV2Command(id: string, input: unknown, options: ExecuteOptions, traceId: string, startedAt: number, completion: ApiContractMetadata["completion"] | undefined): Promise<ApiResult> {
    const fail = (kind: string, message: string, status: Extract<ApiTerminalResult, { ok: false }>["status"] = "failed"): ApiTerminalResult => ({
      ok: false, status, traceId,
      error: { kind, code: kind.toUpperCase().replaceAll("-", "_"), message: redactErrorMessage(message), retryable: false },
    });
    try {
      const summary = this.summary(id);
      if (!summary) return fail("validation", "Unknown action. Call catalog.list() for available ids.");
      if (!this.definitions.has(id) && Object.hasOwn(RESERVED_CATALOG, id)) return fail("not-implemented", summary.reason!);
      if (summary.invocation?.channel === "direct") return fail("validation", "Use the direct facade method described by catalog invocation metadata.");
      if (summary.kind !== "command") return fail("validation", "Use query or events.subscribe for this operation.");
      if (summary.availability !== "ready") return fail(
        summary.availability === "not-implemented" ? "not-implemented" : "unsupported", summary.reason ?? "Unavailable.",
      );
      if (!options || typeof options !== "object" || Array.isArray(options) ||
          Object.keys(options).some(key => key !== "completion" && key !== "timeoutMs") ||
          (options.completion !== undefined && !["committed", "accepted"].includes(options.completion)) ||
          (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2_147_483_647))) {
        return fail("validation", "Invalid execution options.");
      }
      if (summary.execution !== "job" && (options.completion === "accepted" || options.timeoutMs !== undefined)) {
        return fail("not-implemented", "This inline operation does not expose an asynchronous job or bounded wait.");
      }
      let capturedInput: Record<string, unknown>;
      try { capturedInput = structuredClone(input) as Record<string, unknown>; }
      catch { return fail("validation", "Input must contain serializable data."); }
      const descriptor = await this.describe(id);
      const invalid = validateApiInput(descriptor!.inputSchema, capturedInput);
      if (invalid) return fail("validation", invalid);
      // Loading a schema can await a chunk: recheck before the side effect.
      const current = this.summary(id)!;
      if (current.kind !== "command") return fail("validation", "The operation changed invocation route while its contract was loading. Use its documented route.");
      if (current.availability !== "ready") return fail(
        current.availability === "not-implemented" ? "not-implemented" : "unsupported", current.reason ?? "Unavailable.",
      );
      const run = async (context: OperationContext): Promise<ApiTerminalResult> => {
        try {
          const result = await this.invokeRegisteredHandler(id, capturedInput, context, true);
          if (!result.ok) return fail(result.error.kind, result.error.message);
          if (result.reloadRequired) return fail("internal", "Handler requested a reload contrary to its v2 completion contract.", "unknown");
          this.notifyStateChanged();
          return { ok: true, status: "completed", traceId, revision: this.revision, data: result.data };
        } catch (error) {
          const safeMessage = redactErrorMessage(messageOf(error), capturedInput);
          if (error instanceof OperationInterruptedError) return fail(error.reason, safeMessage, error.reason);
          return fail("internal", safeMessage);
        }
      };
      if (current.execution !== "job") return run(Object.freeze({ traceId }));
      const accepted = this.jobs.start(id, traceId, current.cancellationSupported === true, run,
        result => {
          this.stateEvents.publishJob(result.ok ? result.revision ?? this.revision : this.revision,
            { traceId, actionId: id, jobId: result.jobId! }, "terminal", result.status);
          this.finishAction(id, traceId, startedAt, result, completion);
        });
      if (!accepted.ok || accepted.status !== "accepted") return accepted;
      this.stateEvents.publishJob(this.revision, { traceId, actionId: id, jobId: accepted.jobId }, "accepted", "running");
      this.diagnostics.record({ level: "info", category: "action", event: "job.accepted", outcome: "accepted" },
        { traceId, actionId: id, jobId: accepted.jobId });
      return options.completion === "accepted" ? accepted : this.jobs.wait(accepted.jobId, { timeoutMs: options.timeoutMs });
    } catch (error) {
      return fail("internal", messageOf(error));
    }
  }

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
  ): () => void {
    if (section.length > 64 || ["bootId", "revision", "__proto__", "constructor", "prototype"].includes(section)) {
      throw new Error("Invalid state section name.");
    }
    if (!this.sections.has(section) && this.sections.size >= 64) throw new Error("State provider limit reached.");
    this.sections.set(section, provider);
    this.notifyStateChanged(section);
    return () => {
      if (this.sections.get(section) !== provider) return;
      this.sections.delete(section);
      this.notifyStateChanged(section);
    };
  }

  /** Call at the existing mutation boundary, including native UI/camera events. */
  notifyStateChanged(_section?: string): void {
    this.getState();
  }

  disposeStateObservers(): void {
    this.stateEvents.close();
    this.jobs.close();
  }

  async query(id: string, input: unknown = {}): Promise<ApiResult> {
    const traceId = `${this.bootId}:query-${++this.traceSequence}`;
    const fail = (kind: string, message: string): ApiResult => ({ ok: false, status: "failed", traceId,
      error: { kind, code: kind.toUpperCase().replaceAll("-", "_"), message: redactErrorMessage(message), retryable: false } });
    if (AUXILIARY_IDS.includes(id)) return fail("validation", "Use the direct facade method described by catalog invocation metadata.");
    if (!this.definitions.has(id) && Object.hasOwn(RESERVED_CATALOG, id)) return fail("not-implemented", reservedSummary(id)!.reason!);
    if (!SNAPSHOT_QUERIES.has(id)) return this.queryRegistered(id, input, traceId);
    const invalid = validateApiInput({ type: "object", properties: {}, additionalProperties: false }, input);
    if (invalid) return fail("validation", invalid);
    const section = SNAPSHOT_QUERIES.get(id);
    if (section !== undefined && !this.sections.has(section)) return fail("unsupported", "This state provider is not attached yet.");
    const { snapshot, errors } = this.readState();
    this.observeState(snapshot);
    if (section !== undefined && errors.has(section)) return fail("internal", "The requested state provider failed; inspect scene.snapshot for its safe error summary.");
    return {
      ok: true, status: "completed", traceId, revision: this.revision,
      data: section === undefined ? { ...snapshot, revision: this.revision }
        : { ...snapshot[section] as Record<string, unknown>, bootId: this.bootId, revision: this.revision },
    };
  }

  private async queryRegistered(id: string, input: unknown, traceId: string): Promise<ApiResult> {
    const startedAt = performance.now();
    const logId = this.definitions.has(id) ? id : "unknown-query";
    this.diagnostics.record({ level: "info", category: "action", event: "query.started", outcome: "started" }, { traceId, actionId: logId });
    let capturedInput: Record<string, unknown> = {};
    const fail = (kind: string, message: string, status: Extract<ApiTerminalResult, { ok: false }>["status"] = "failed"): ApiTerminalResult => ({
      ok: false, status, traceId,
      error: { kind, code: kind.toUpperCase().replaceAll("-", "_"), message: redactErrorMessage(message, capturedInput), retryable: false },
    });
    const check = (): ApiTerminalResult | undefined => {
      const summary = this.summary(id);
      if (!summary) return fail("validation", "Unknown query. Call catalog.list({kind: 'query'}).");
      if (summary.kind !== "query") return fail("validation", "This operation is not a query. Use its documented invocation route.");
      if (summary.availability !== "ready") return fail(summary.availability === "not-implemented" ? "not-implemented" : "unsupported", summary.reason ?? "Unavailable.");
      if (summary.effect !== "read") return fail("validation", "A registered query must declare a read-only effect.");
    };
    const run = async (): Promise<ApiTerminalResult> => {
      const unavailable = check();
      if (unavailable) return unavailable;
      const definition = this.definitions.get(id);
      const handler = this.handlers.get(id);
      const contract = this.contracts.get(id);
      let cloned: unknown;
      try { cloned = structuredClone(input); }
      catch { return fail("validation", "Input must contain serializable data."); }
      if (typeof cloned !== "object" || cloned === null || Array.isArray(cloned)) return fail("validation", "Query input must be a JSON object.");
      capturedInput = cloned as Record<string, unknown>;
      const descriptor = await this.describe(id);
      const invalid = validateApiInput(descriptor!.inputSchema, capturedInput);
      if (invalid) return fail("validation", invalid);
      // Never apply an old schema to a replacement handler or a changed contract.
      const changedAvailability = check();
      if (changedAvailability) return changedAvailability;
      if (definition !== this.definitions.get(id) || handler !== this.handlers.get(id) || contract !== this.contracts.get(id)) {
        return fail("superseded", "The registered query changed while its contract was loading. Retry against the current contract.", "superseded");
      }
      const result = await this.invokeRegisteredHandler(id, capturedInput, Object.freeze({ traceId }), true, "query");
      if (!result.ok) return fail(result.error.kind, result.error.message);
      if (result.reloadRequired) return fail("internal", "A read-only query handler cannot request a page reload.");
      return { ok: true, status: "completed", traceId, revision: this.revision, data: result.data };
    };
    let result: ApiTerminalResult;
    try { result = await run(); }
    catch (error) {
      result = error instanceof OperationInterruptedError
        ? fail(error.reason, messageOf(error), error.reason)
        : fail(kindOf(error), messageOf(error));
    }
    // No bodies, action-completion observation, jobs or frame events for reads.
    this.diagnostics.record({
      level: result.ok ? "info" : "warn", category: "action", event: `query.${result.status}`, outcome: result.status,
      durationMs: performance.now() - startedAt, ...(!result.ok ? { errorCode: result.error.code } : {}),
    }, { traceId, actionId: logId, revision: this.revision });
    return result;
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
    const { snapshot } = this.readState();
    this.observeState(snapshot);
    return snapshot;
  }

  private readState(): { snapshot: AgentStateSnapshot; errors: Set<string> } {
    const snapshot: AgentStateSnapshot = { bootId: this.bootId };
    const errors = new Set<string>();
    for (const [section, provider] of this.sections) {
      try {
        // JSON-only state: no provider callbacks, class instances or mutable
        // application references escape. Serialization failures stay local.
        snapshot[section] = JSON.parse(JSON.stringify(redactSensitive(provider())));
      } catch (error) {
        snapshot[section] = { error: redactErrorMessage(messageOf(error)) };
        errors.add(section);
      }
    }
    return { snapshot, errors };
  }

  private observeState(snapshot: AgentStateSnapshot): void {
    const changed: string[] = [];
    for (const [section, state] of Object.entries(snapshot)) {
      if (section === "bootId") continue;
      const fingerprint = JSON.stringify(state);
      if (this.stateFingerprints.get(section) === fingerprint) continue;
      this.stateFingerprints.set(section, fingerprint);
      changed.push(section);
    }
    for (const section of this.stateFingerprints.keys()) {
      if (Object.hasOwn(snapshot, section)) continue;
      this.stateFingerprints.delete(section);
      changed.push(section);
    }
    if (changed.length) this.stateEvents.publish(++this.revision, changed);
  }

  async execute(
    actionId: string,
    params: Record<string, unknown> = {},
  ): Promise<AgentActionResult> {
    const traceId = `${this.bootId}:action-${++this.traceSequence}`;
    const completion = this.contracts.get(actionId)?.metadata.completion;
    const startedAt = this.startAction(actionId, traceId);
    let result: AgentActionResult;
    try { result = await this.invokeRegisteredHandler(actionId, params, Object.freeze({ traceId })); }
    catch (error) { result = failure(actionId, "internal", messageOf(error), params); }
    this.finishAction(actionId, traceId, startedAt, result, completion);
    return result;
  }

  private startAction(id: string, traceId: string): number {
    const startedAt = performance.now();
    this.diagnostics.record({ level: "info", category: "action", event: "action.started", outcome: "started" },
      { traceId, actionId: this.definitions.has(id) ? id : "unknown-action" });
    return startedAt;
  }

  private finishAction(id: string, traceId: string, startedAt: number, result: AgentActionResult | ApiResult, completion: ApiContractMetadata["completion"] | undefined): void {
    const accepted = result.ok && "reloadRequired" in result && result.reloadRequired;
    if (completion === "frame-committed" && result.ok && !accepted &&
        (!("status" in result) || result.status === "completed")) {
      this.stateEvents.publishFrame("revision" in result ? result.revision ?? this.revision : this.revision,
        { traceId, actionId: id, ...("jobId" in result && result.jobId ? { jobId: result.jobId } : {}) });
    }
    const legacyUnverified = result.ok && "actionId" in result &&
      completion !== "state-committed" && completion !== "frame-committed";
    const unknown = !result.ok && "status" in result && result.status === "unknown";
    const interrupted = !result.ok && "status" in result && ["cancelled", "superseded"].includes(result.status) ? result.status : undefined;
    const outcome = interrupted ?? (accepted ? "accepted" : legacyUnverified || unknown ? "unknown" : result.ok ? "completed" : "failed");
    const event = interrupted ? `action.${interrupted}` : accepted ? "action.accepted" : legacyUnverified ? "action.returned" : unknown ? "action.unknown" : result.ok ? "action.completed" : "action.failed";
    // Do not copy params, result bodies or input-bearing error messages into
    // diagnostics. The safe code and operation identity locate the failure.
    this.diagnostics.record({
      level: result.ok ? "info" : "warn", category: "action",
      event, outcome,
      durationMs: performance.now() - startedAt,
      ...(!result.ok ? { errorCode: String(result.error.code) } : {}),
    }, { traceId, actionId: this.definitions.has(id) ? id : "unknown-action", revision: this.revision,
      ...("jobId" in result ? { jobId: result.jobId } : {}) });
  }

  private async invokeRegisteredHandler(actionId: string, params: Record<string, unknown>, context?: OperationContext, propagateInterruption = false, operationKind: "command" | "query" = "command"): Promise<AgentActionResult> {
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
      if (context?.signal?.aborted) throw new OperationInterruptedError("cancelled");
      const outcome = (await handler(params, context)) as AgentActionOutcome;
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
      if (propagateInterruption && error instanceof OperationInterruptedError) throw error;
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
    } finally {
      if (operationKind === "command") this.notifyStateChanged();
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
 * Publishes the unchanged v1 surface and an explicit, frozen v2 extension. The registry itself (and its
 * `register`/`registerStateSection` registerers and internal maps) stays
 * unreachable from the page, so a caller cannot rewrite the app's actions or
 * plant a state provider.
 */
export function installAgentActions(target: Window = window): void {
  const v2: FrontendApiV2 = Object.freeze({
    version: "2.0.0",
    catalog: Object.freeze({
      list: (filter?: CatalogFilter) => agentActions.listCatalog(filter),
      describe: (id: string) => agentActions.describe(id).catch(error => {
        throw new Error(redactErrorMessage(messageOf(error)));
      }),
    }),
    execute: (id: string, input?: unknown, options?: ExecuteOptions) => agentActions.executeV2(id, input, options),
    query: (id: string, input?: unknown) => agentActions.query(id, input),
    jobs: Object.freeze({
      get: (id: string) => agentActions.jobs.get(id),
      wait: (id: string, options?: WaitOptions) => agentActions.jobs.wait(id, options),
      cancel: (id: string) => agentActions.jobs.cancel(id),
    }),
    events: Object.freeze({
      subscribe: (filter: EventFilter, listener: (event: AppEvent) => void) => agentActions.stateEvents.subscribe(filter, listener),
    }),
    logs: Object.freeze({
      query: (filter?: LogFilter) => agentActions.diagnostics.query(filter),
      export: (filter?: LogFilter) => new Blob([agentActions.diagnostics.export(filter)], { type: "application/x-ndjson" }),
      clear: () => agentActions.diagnostics.clear(),
    }),
  });
  const facade: TimeMachineAgentFacade = Object.freeze({
    version: agentActions.version,
    v2,
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
