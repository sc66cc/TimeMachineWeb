import { describe, expect, it } from "vitest";
import { AGENT_ACTIONS, AGENT_DECLARATIONS } from "../agent-actions/actions";
import { agentActions, installAgentActions } from "../agent-actions/registry";

function api() {
  const target = {} as Window;
  installAgentActions(target);
  expect(target.timeMachineAgent?.v2).toBeDefined();
  return target.timeMachineAgent!.v2;
}

const metadata = {
  kind: "command" as const,
  scope: "p0-p3" as const,
  effect: "project-local" as const,
  completion: "state-committed" as const,
  requirements: [],
};

describe("frontend v2 catalog and shared execution", () => {
  it("preserves the v1 contract and does not expose registry mutation through v2", () => {
    const target = {} as Window;
    installAgentActions(target);
    const facade = target.timeMachineAgent!;
    expect(facade.version).toBe("1.0.0");
    expect(facade.v2).toBeDefined();
    expect(facade.v2.version).toBe("2.0.0");
    expect(Object.isFrozen(facade.v2)).toBe(true);
    expect(Object.isFrozen(facade.v2.catalog)).toBe(true);
    expect(facade.v2).not.toHaveProperty("register");
    expect(facade.v2).not.toHaveProperty("setContract");
    expect(facade.v2).not.toHaveProperty("handlers");
  });

  it("exposes known unimplemented actions and rejects them without pretending success", async () => {
    const v2 = api();
    const item = v2.catalog.list().find(row => row.id === "publish.run");
    expect(item).toMatchObject({ kind: "command", scope: "future", availability: "not-implemented" });
    expect(await v2.execute("publish.run", {})).toMatchObject({
      ok: false, status: "failed", error: { kind: "not-implemented" },
    });
    expect(await v2.execute("missing.operation", {})).toMatchObject({
      ok: false, error: { kind: "validation" },
    });
    expect(await v2.catalog.describe("missing.operation")).toBeUndefined();
  });

  it("advertises possible cloud autosaves so local-looking edits are not replayed as read-only actions", () => {
    const v2 = api();
    const rows = new Map(v2.catalog.list().map(row => [row.id, row]));
    for (const id of ["layer.setOpacity", "layer.group.setCollapsed", "layer.setOrder", "points.setStyle", "points.setSize", "project.setName"]) {
      expect(rows.get(id), id).toMatchObject({ effect: "remote-write", completion: "state-committed" });
      expect(rows.get(id)?.completionNote, id).toContain("autosave");
    }
    expect(rows.get("ui.sidebar.select")?.effect).toBe("ui-local");
  });

  it("derives current availability from the same handler and live predicate used by v1", async () => {
    const v2 = api();
    const id = "test.catalog.live";
    let permitted = false;
    let count = 0;
    agentActions.register({ ...AGENT_DECLARATIONS[AGENT_ACTIONS.cameraReset], id }, () => ({ data: { count: ++count } }));
    agentActions.setContract(id, metadata);
    agentActions.setAvailability(id, () => permitted ? undefined : "Capability not ready.");
    expect(v2.catalog.list().find(row => row.id === id)?.availability).toBe("unavailable");
    expect(await v2.execute(id, {})).toMatchObject({ ok: false, error: { kind: "unsupported" } });
    expect(count).toBe(0);
    permitted = true;
    expect(v2.catalog.list().find(row => row.id === id)?.availability).toBe("ready");
    expect(await v2.execute(id, {})).toMatchObject({ ok: true, status: "completed", data: { count: 1 } });
    expect(await agentActions.execute(id)).toEqual({ actionId: id, ok: true, data: { count: 2 }, reloadRequired: false });
    permitted = false;
    expect((await v2.execute(id, {})).ok).toBe(false);
    expect(count).toBe(2);
  });

  it("loads schemas only on describe/execute and keeps deep credential field definitions intact", async () => {
    const v2 = api();
    const id = "test.catalog.schema";
    let loads = 0;
    agentActions.register({ ...AGENT_DECLARATIONS[AGENT_ACTIONS.cameraReset], id }, () => ({}));
    agentActions.setContract(id, metadata, async () => {
      loads++;
      return {
        inputSchema: {
          type: "object", properties: { auth: { type: "object", properties: {
            nested: { type: "object", properties: { password: { type: "string", minLength: 3 } }, required: ["password"] },
          } } },
        },
        outputSchema: { type: "object" },
        examples: [{ auth: { password: "synthetic-private-value" } }],
      };
    });
    expect(v2.catalog.list({ idPrefix: "test.catalog.schema" })).toHaveLength(1);
    expect(loads).toBe(0);
    const first = await v2.catalog.describe(id);
    expect(first?.inputSchema.properties?.auth?.properties?.nested?.properties?.password).toEqual({ type: "string", minLength: 3 });
    expect(JSON.stringify(first?.examples)).not.toContain("synthetic-private-value");
    first!.inputSchema.properties!.auth!.properties!.nested!.properties!.password!.minLength = 999;
    const second = await v2.catalog.describe(id);
    expect(second?.inputSchema.properties?.auth?.properties?.nested?.properties?.password?.minLength).toBe(3);
    expect(loads).toBe(1);
  });

  it("validates nested enums, finite numbers, array items, ranges and unknown keys before side effects", async () => {
    const v2 = api();
    const id = "test.catalog.validation";
    let count = 0;
    agentActions.register({ ...AGENT_DECLARATIONS[AGENT_ACTIONS.cameraReset], id }, () => ({ data: { count: ++count } }));
    agentActions.setContract(id, metadata, async () => ({
      inputSchema: { type: "object", required: ["style"], additionalProperties: false, properties: {
        style: { type: "object", required: ["alpha", "mode", "ids"], additionalProperties: false, properties: {
          alpha: { type: "number", minimum: 0, maximum: 1 },
          mode: { type: "string", enum: ["single", "plate"] },
          ids: { type: "array", minItems: 1, items: { type: "integer", minimum: 1 } },
        } },
      } },
      outputSchema: { type: "object" }, examples: [],
    }));
    const good = { style: { alpha: 0, mode: "plate", ids: [1, 2] } };
    for (const bad of [
      null, [], {}, { ...good, unexpected: true },
      { style: { ...good.style, alpha: Infinity } },
      { style: { ...good.style, alpha: 1.01 } },
      { style: { ...good.style, mode: "unknown" } },
      { style: { ...good.style, ids: [1, "2"] } },
      { style: { ...good.style, ids: [] } },
    ]) {
      expect(await v2.execute(id, bad)).toMatchObject({ ok: false, error: { kind: "validation" } });
    }
    expect(count).toBe(0);
    expect(await v2.execute(id, good)).toMatchObject({ ok: true, data: { count: 1 } });
  });

  it("redacts lazy catalog failures and permits a later retry", async () => {
    const v2 = api();
    const id = "test.catalog.retry";
    let attempts = 0;
    agentActions.register({ ...AGENT_DECLARATIONS[AGENT_ACTIONS.cameraReset], id }, () => ({}));
    agentActions.setContract(id, metadata, async () => {
      if (++attempts === 1) throw new Error("chunk failed token=synthetic-private-value");
      return { inputSchema: { type: "object" }, outputSchema: { type: "object" }, examples: [] };
    });
    const message = await v2.catalog.describe(id).catch(error => error.message);
    expect(message).toBe("chunk failed token=[redacted]");
    expect(await v2.catalog.describe(id)).toMatchObject({ id, availability: "ready" });
    expect(attempts).toBe(2);
  });

  it("does not echo caller-owned dictionary keys into validation errors", async () => {
    const v2 = api();
    let writes = 0;
    agentActions.register(AGENT_DECLARATIONS[AGENT_ACTIONS.layerOrder], () => ({ data: { writes: ++writes } }));
    const result = await v2.execute("layer.setOrder", {
      orderedIds: [1], groupIdByLayer: { "synthetic-private-key-value": "invalid" },
    });
    expect(result).toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(JSON.stringify(result)).not.toContain("synthetic-private-key-value");
    expect(writes).toBe(0);
  });

  it("does not report asynchronous completion until the shared handler has actually resolved", async () => {
    const v2 = api();
    const id = "test.catalog.wait";
    let commit!: () => void;
    const frame = new Promise<void>(resolve => { commit = resolve; });
    agentActions.register({ ...AGENT_DECLARATIONS[AGENT_ACTIONS.cameraReset], id }, async () => {
      await frame;
      return { data: { committedAgeMa: 100, token: "synthetic-private-value" } };
    });
    agentActions.setContract(id, { ...metadata, completion: "frame-committed" });
    let finished = false;
    const operation = v2.execute(id, {}).then(result => { finished = true; return result; });
    await Promise.resolve();
    expect(finished).toBe(false);
    commit();
    const result = await operation;
    expect(result).toMatchObject({ ok: true, status: "completed", data: { committedAgeMa: 100, token: "[redacted]" } });
    expect(result.traceId).toEqual(expect.any(String));
  });

  it("matches the real point-style contract, including its nullable filter and pixel limits", async () => {
    const v2 = api();
    let writes = 0;
    agentActions.register(AGENT_DECLARATIONS[AGENT_ACTIONS.pointsSetStyle], params => ({ data: { style: params.style, writes: ++writes } }));
    const valid = { style: {
      colorMode: "occurrence", shape: "square", pointSize: 0.5, occurrenceSizeScale: 4,
      schemaVersion: 1, singleColor: "#ff00aa", filter: { plateId: null, minimumOccurrence: 0, maximumOccurrence: 65535 },
    } };
    expect(await v2.execute("points.setStyle", valid)).toMatchObject({ ok: true, data: { writes: 1 } });
    for (const style of [
      { ...valid.style, pointSize: 8.1 }, { ...valid.style, colorMode: "age" },
      { ...valid.style, shape: "triangle" }, { ...valid.style, singleColor: "invalid" },
      { ...valid.style, filter: { plateId: -1 } },
    ]) expect(await v2.execute("points.setStyle", { style })).toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(writes).toBe(1);
  });

  it("does not invoke reload/fire-and-forget actions through an unimplemented v2 completion contract", async () => {
    const v2 = api();
    let invoked = false;
    const id = "test.catalog.reload";
    agentActions.register({ ...AGENT_DECLARATIONS[AGENT_ACTIONS.modelSelect], id, params: [] }, () => {
      invoked = true;
      return { reloadRequired: true };
    });
    agentActions.setContract(id, { ...metadata, completion: "page-reload" });
    expect(await v2.execute(id, {})).toMatchObject({ ok: false, error: { kind: "not-implemented" } });
    expect(invoked).toBe(false);
    expect(await agentActions.execute(id)).toMatchObject({ ok: true, reloadRequired: true });
  });

  it("rejects unimplemented wait options instead of ignoring timeout/accepted requests", async () => {
    const v2 = api();
    const id = "test.catalog.options";
    let invoked = false;
    agentActions.register({ ...AGENT_DECLARATIONS[AGENT_ACTIONS.cameraReset], id }, () => {
      invoked = true;
      return {};
    });
    agentActions.setContract(id, metadata);
    expect(await v2.execute(id, {}, { timeoutMs: 1 })).toMatchObject({ ok: false, error: { kind: "not-implemented" } });
    expect(await v2.execute(id, {}, { completion: "accepted" })).toMatchObject({ ok: false, error: { kind: "not-implemented" } });
    expect(invoked).toBe(false);
  });
});


describe("event catalog contracts", () => {
  it("describes only implemented events with exact identity and bounded-delivery contracts", async () => {
    const v2 = api();
    expect(v2.catalog.list({ kind: "event" }).map(event => event.id)).toEqual(["frame.committed", "job.changed", "state.changed"]);
    for (const id of ["state.changed", "job.changed", "frame.committed"]) {
      const entry = await v2.catalog.describe(id);
      expect(entry).toMatchObject({ kind: "event", availability: "ready", effect: "read", outputSchema: { additionalProperties: false } });
      expect(entry!.outputSchema.required).toEqual(expect.arrayContaining(["type", "bootId", "sequence", "revision", "droppedCount"]));
      expect(entry!.description).toContain("256");
      expect(entry!.inputSchema.properties?.types?.items?.enum).toEqual(["state.changed", "job.changed", "frame.committed"]);
      if (id === "state.changed") expect(entry!.outputSchema.properties).not.toHaveProperty("traceId");
      else expect(entry!.outputSchema.required).toEqual(expect.arrayContaining(["traceId", "actionId"]));
      if (id === "job.changed") expect(entry!.outputSchema.required).toContain("jobId");
      if (id === "frame.committed") expect(entry!.outputSchema.required).not.toContain("jobId");
    }
  });
});
