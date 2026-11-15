import { describe, expect, it, beforeEach, afterEach } from "vitest";

import {
  AgentActionAuthError,
  AgentActionBusyError,
  AgentActionUnsupportedError,
  AgentActionValidationError,
  agentActions,
  installAgentActions,
  redactErrorMessage,
  redactSensitive,
  AGENT_DECLARATIONS,
  AGENT_ACTIONS,
} from "../agent-actions";

/**
 * Security contract of the facade. Everything here is synthetic: no real
 * account, password, token or Server is involved.
 */

const SYNTHETIC_SECRET = "fixture-secret";

describe("redactSensitive", () => {
  it("replaces a value whose key looks sensitive", () => {
    expect(
      redactSensitive({ token: SYNTHETIC_SECRET, password: "p", digest: "d" }),
    ).toEqual({ digest: "[redacted]", password: "[redacted]", token: "[redacted]" });
  });

  it("truncates structure deeper than the snapshot budget", () => {
    const deep = { a: { b: { c: { d: { token: SYNTHETIC_SECRET } } } } };
    expect(redactSensitive(deep)).toEqual({
      a: { b: { c: { d: "[truncated]" } } },
    });
  });

  it("survives a cycle instead of recursing forever", () => {
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic.self = cyclic;
    expect(redactSensitive(cyclic)).toEqual({
      name: "root",
      self: "[truncated]",
    });
  });

  it("returns a copy, so a caller cannot reach the provider's objects", () => {
    const source = { nested: { value: 1 } };
    const copy = redactSensitive(source) as typeof source;
    copy.nested.value = 2;
    expect(source.nested.value).toBe(1);
  });

  it("cleans a plain string value that carries a labelled credential", () => {
    // The shape a real network failure takes in `catalog.error`: the key name
    // says nothing, the message says everything.
    expect(
      redactSensitive({ error: `POST /api failed: token=${SYNTHETIC_SECRET}` }),
    ).toEqual({ error: "POST /api failed: token=[redacted]" });
    expect(redactSensitive(`digest=${SYNTHETIC_SECRET}`)).toBe(
      "digest=[redacted]",
    );
  });

  it("leaves ordinary non-sensitive text alone", () => {
    const message =
      "Shared plate model catalog could not be read (HTTP 503).";
    expect(redactSensitive({ error: message })).toEqual({ error: message });
    expect(redactSensitive("PBDB 2026")).toBe("PBDB 2026");
    expect(redactSensitive(42)).toBe(42);
    expect(redactSensitive(null)).toBe(null);
  });
});

describe("redactErrorMessage", () => {
  it("keeps redaction stable across v1, v2 and state boundaries", () => {
    const message = `request failed token=${SYNTHETIC_SECRET}; password="${SYNTHETIC_SECRET}"`;
    const once = redactErrorMessage(message);
    expect(redactErrorMessage(once)).toBe(once);
    expect(redactSensitive({ error: once })).toEqual({ error: once });
  });

  it("removes labelled credentials from a free-form message", () => {
    expect(redactErrorMessage(`failed: token=${SYNTHETIC_SECRET}`)).toBe(
      "failed: token=[redacted]",
    );
    expect(redactErrorMessage("Authorization: Bearer abc123 failed")).toBe(
      "Authorization: [redacted] failed",
    );
    expect(redactErrorMessage('password: "hunter2" rejected')).toBe(
      "password: [redacted] rejected",
    );
  });

  it("removes the literal value of a sensitive parameter of the call", () => {
    expect(
      redactErrorMessage(`Server rejected ${SYNTHETIC_SECRET}`, {
        password: SYNTHETIC_SECRET,
      }),
    ).toBe("Server rejected [redacted]");
  });
});

describe("agentActions.execute", () => {
  const testId = "test.execute.probe";
  const probeParams = [
    { description: "flag", name: "flag", required: true, type: "boolean" as const },
  ];

  beforeEach(() => {
    agentActions.register(
      {
        ...AGENT_DECLARATIONS[AGENT_ACTIONS.cameraReset],
        id: testId,
        params: probeParams,
      },
      () => ({}),
    );
  });

  afterEach(() => {
    // Drop the probe handler again, so the inventory stays honest.
    agentActions.register({
      ...AGENT_DECLARATIONS[AGENT_ACTIONS.cameraReset],
      id: testId,
      params: probeParams,
    });
  });

  it("classifies a rejected parameter as a validation failure", async () => {
    const result = await agentActions.execute(testId, { flag: "yes" });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      error: { code: 400, kind: "validation" },
    });
  });

  it("classifies a missing capability as unsupported, not internal", async () => {
    const result = await agentActions.execute(AGENT_ACTIONS.publishPlaceholder);
    expect(result).toMatchObject({
      error: { code: 501, kind: "unsupported" },
      ok: false,
    });
  });

  it("maps the handler error classes onto distinct result kinds", async () => {
    const id = "test.error.kinds";
    agentActions.register(
      { ...AGENT_DECLARATIONS[AGENT_ACTIONS.cameraReset], id },
      async (params) => {
        switch (params.kind) {
          case "auth":
            throw new AgentActionAuthError("nope");
          case "busy":
            throw new AgentActionBusyError("later");
          case "unsupported":
            throw new AgentActionUnsupportedError("absent");
          case "validation":
            throw new AgentActionValidationError("bad");
          default:
            throw new Error(`token=${SYNTHETIC_SECRET}`);
        }
      },
    );
    const kinds = await Promise.all(
      ["auth", "busy", "unsupported", "validation", "internal"].map(
        async (kind) => {
          const result = await agentActions.execute(id, { kind });
          return result.ok
            ? { code: 0, kind: "ok", message: "" }
            : { ...result.error };
        },
      ),
    );
    expect(kinds).toEqual([
      { code: 401, kind: "auth", message: "nope" },
      { code: 409, kind: "busy", message: "later" },
      { code: 501, kind: "unsupported", message: "absent" },
      { code: 400, kind: "validation", message: "bad" },
      { code: 500, kind: "internal", message: "token=[redacted]" },
    ]);
    agentActions.register({ ...AGENT_DECLARATIONS[AGENT_ACTIONS.cameraReset], id });
  });

  it("accepts a real array and a real object parameter", async () => {
    const id = "test.structured.params";
    agentActions.register(
      {
        ...AGENT_DECLARATIONS[AGENT_ACTIONS.cameraReset],
        id,
        params: [
          { description: "ids", name: "orderedIds", required: true, type: "array" },
          { description: "map", name: "byLayer", required: false, type: "object" },
        ],
      },
      (params) => ({ data: { ok: true, ...params } }),
    );
    const array = await agentActions.execute(id, { orderedIds: [1, 2] });
    expect(array.ok).toBe(true);
    const stringArray = await agentActions.execute(id, {
      orderedIds: "[1,2]",
    });
    expect(stringArray).toMatchObject({
      error: { code: 400, kind: "validation" },
    });
    const object = await agentActions.execute(id, {
      byLayer: { 3: 101 },
      orderedIds: [1],
    });
    expect(object.ok).toBe(true);
    const fakeObject = await agentActions.execute(id, {
      byLayer: '{"3":101}',
      orderedIds: [1],
    });
    expect(fakeObject).toMatchObject({
      error: { code: 400, kind: "validation" },
    });
    agentActions.register({ ...AGENT_DECLARATIONS[AGENT_ACTIONS.cameraReset], id });
  });

  it("redacts a deep secret in a successful result", async () => {
    const id = "test.deep.result";
    agentActions.register(
      { ...AGENT_DECLARATIONS[AGENT_ACTIONS.cameraReset], id },
      () => ({ data: { a: { b: { c: { d: { token: SYNTHETIC_SECRET } } } } } }),
    );
    const result = await agentActions.execute(id);
    if (!result.ok) {
      throw new Error("expected a success");
    }
    expect(JSON.stringify(result)).not.toContain(SYNTHETIC_SECRET);
    expect(result.data).toEqual({ a: { b: { c: { d: "[truncated]" } } } });
    agentActions.register({ ...AGENT_DECLARATIONS[AGENT_ACTIONS.cameraReset], id });
  });
});

describe("agentActions.getState", () => {
  it("redacts a provider that leaks a secret and a provider that throws", () => {
    agentActions.registerStateSection("leaky", () => ({
      token: SYNTHETIC_SECRET,
    }));
    agentActions.registerStateSection("thrower", () => {
      throw new Error(`token=${SYNTHETIC_SECRET}`);
    });
    agentActions.registerStateSection("deep", () => ({
      a: { b: { c: { d: { token: SYNTHETIC_SECRET } } } },
    }));
    const snapshot = JSON.stringify(agentActions.getState());
    expect(snapshot).not.toContain(SYNTHETIC_SECRET);
    expect(agentActions.getState().leaky).toEqual({ token: "[redacted]" });
    expect(agentActions.getState().thrower).toEqual({
      error: "token=[redacted]",
    });
  });
});

/**
 * Live availability: a registered handler stays registered while a capability
 * is missing, and becomes usable the moment the capability appears. Both
 * directions are asserted, because a one-shot `declareUnsupported` used to drop
 * the handler permanently.
 */
describe("agentActions.setAvailability", () => {
  const id = "test.availability.probe";
  const probe = {
    ...AGENT_DECLARATIONS[AGENT_ACTIONS.cameraReset],
    id,
  };

  afterEach(() => {
    agentActions.register(probe);
    agentActions.setAvailability(id, () => undefined);
  });

  it("reports unsupported while the capability is absent and ready once it appears", async () => {
    let available = false;
    agentActions.register(probe, () => ({ data: { ran: true } }));
    agentActions.setAvailability(id, () =>
      available ? undefined : "Capability is not available yet.",
    );

    const unavailable = await agentActions.execute(id);
    expect(unavailable).toMatchObject({
      error: { code: 501, kind: "unsupported" },
      ok: false,
    });
    expect(
      agentActions.listActions().find((action) => action.id === id)?.status,
    ).toBe("unsupported");

    available = true;
    const available_ = await agentActions.execute(id);
    expect(available_).toMatchObject({ data: { ran: true }, ok: true });
    expect(
      agentActions.listActions().find((action) => action.id === id)?.status,
    ).toBe("ready");

    // ... and back again, so a capability that disappears is reported honestly.
    available = false;
    const gone = await agentActions.execute(id);
    expect(gone).toMatchObject({
      error: { code: 501, kind: "unsupported" },
      ok: false,
    });
  });

  it("keeps the handler registered, so nothing has to be re-registered", async () => {
    agentActions.register(probe, () => ({ data: { ran: true } }));
    agentActions.setAvailability(id, () => "not now");
    expect((await agentActions.execute(id)).ok).toBe(false);
    agentActions.setAvailability(id, () => undefined);
    // The same handler object answers; no second registration happened.
    expect((await agentActions.execute(id)).ok).toBe(true);
  });
});

describe("agentActions.listActions", () => {
  it("hands out copies of the declared parameters", () => {
    const [first] = agentActions.listActions();
    expect(first).toBeDefined();
    if (!first) {
      return;
    }
    (first.params as { description: string; name: string; type: string }[])[0] = {
      description: "tampered",
      name: "x",
      type: "string",
    };
    const [again] = agentActions.listActions();
    expect(again?.params[0]?.name).not.toBe("x");
  });
});

describe("installAgentActions", () => {
  it("publishes the v1 surface and the explicit v2 extension without registry access", () => {
    const target = {} as Window & Record<string, unknown>;
    installAgentActions(target);
    const facade = target.timeMachineAgent!;
    expect(Object.keys(facade).sort()).toEqual([
      "execute",
      "getState",
      "listActions",
      "v2",
      "version",
    ]);
    expect(Object.isFrozen(facade)).toBe(true);
    expect(facade).not.toHaveProperty("register");
    expect(facade).not.toHaveProperty("registerStateSection");
    expect(facade).not.toHaveProperty("definitions");
    expect(facade).not.toHaveProperty("handlers");
    expect(facade).not.toHaveProperty("sections");
    // The published property is not writable, so a caller cannot swap it.
    expect(() => {
      target.timeMachineAgent = { version: "spoof" } as never;
    }).toThrow();
    expect(target.timeMachineAgent).toBe(facade);
  });
});
