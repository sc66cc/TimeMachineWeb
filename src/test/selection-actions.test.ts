import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let registry: typeof import("../agent-actions/registry");
let selection: import("../layers/selection").FeatureSelection;
let target: Window;
let records: Map<number, { owner: object; sourceRef: string; attributes: Record<string, unknown> | null; selectable: boolean }>;
const key = (layerId = 103, featureId = "same", viewportId = "main") => ({ viewportId, layerId, featureId });
const api = () => target.timeMachineAgent!.v2;

beforeEach(async () => {
  vi.resetModules();
  registry = await import("../agent-actions/registry");
  const { FeatureSelection } = await import("../layers/selection");
  const { registerSelectionActions } = await import("../layers/selection-actions");
  records = new Map([103, 104].map(id => [id, { owner: {}, sourceRef: "fixture:selection", attributes: { name: `Feature ${id}`, password: "synthetic-secret", values: { nested: { tooDeep: { leaf: 3 } } } }, selectable: true }]));
  selection = new FeatureSelection(() => registry.agentActions.notifyStateChanged("selection"));
  registry.agentActions.registerStateSection("selection", () => ({ ...selection.snapshot() }));
  registerSelectionActions(selection, {
    assertViewport(viewportId) { if (viewportId !== "main") throw new registry.AgentActionValidationError("Unknown viewport."); },
    readFeature(candidate) {
      if (candidate.featureId !== "same" || !records.has(candidate.layerId)) throw new registry.AgentActionValidationError("Unknown feature.");
      return records.get(candidate.layerId)!;
    },
  });
  target = {} as Window; registry.installAgentActions(target);
});
afterEach(() => registry.agentActions.disposeStateObservers());

describe("selection actions through the real facade", () => {
  it("replaces only the four implemented reserved entries and describes exact inputs", async () => {
    for (const id of ["feature.select", "feature.clear", "selection.snapshot", "feature.attributes"]) {
      expect(api().catalog.list().filter(item => item.id === id)).toHaveLength(1);
      expect(await api().catalog.describe(id)).toMatchObject({ availability: "ready", completion: "state-committed" });
    }
    expect(await api().catalog.describe("feature.pick")).toMatchObject({ availability: "not-implemented" });
    expect(await api().catalog.describe("feature.queryBox")).toMatchObject({ availability: "not-implemented" });
  });
  it("uses the same selection owner for API, UI and read-only snapshots", async () => {
    expect(await api().execute("feature.select", { key: key() })).toMatchObject({ ok: true, data: { selection: { key: key(), source: "api" } } });
    selection.select(key(104), "ui", records.get(104)!.owner);
    expect(await api().query("selection.snapshot", { viewportId: "main" })).toMatchObject({ ok: true, data: { selection: { key: key(104), source: "ui" } } });
    expect(await api().execute("feature.clear", { viewportId: "main" })).toMatchObject({ ok: true, data: { selection: { key: null, source: "api" } } });
    expect(selection.snapshot().key).toBeNull();
  });
  it("rejects unknown/hidden selections and leaves the current selection intact", async () => {
    await api().execute("feature.select", { key: key() });
    records.get(104)!.selectable = false;
    for (const candidate of [key(999), key(103, "missing"), key(104), key(103, "same", "unknown")]) {
      expect(await api().execute("feature.select", { key: candidate })).toMatchObject({ ok: false });
      expect(selection.snapshot().key).toEqual(key());
    }
    expect(await api().execute("feature.clear", { viewportId: "unknown" })).toMatchObject({ ok: false });
    expect(selection.snapshot().key).toEqual(key());
  });
  it("filters attributes, reports absent fields and redacts credentials without changing selection", async () => {
    const result = await api().query("feature.attributes", { key: key(), fields: ["name", "password", "missing"] });
    expect(result).toMatchObject({ ok: true, data: { key: key(), sourceRef: "fixture:selection", attributes: { name: "Feature 103", password: "[redacted]" }, missingFields: ["missing"], truncated: true } });
    expect(selection.snapshot().key).toBeNull();
    expect(JSON.stringify(api().logs.query())).not.toContain("synthetic-secret");
  });
  it("reports further facade depth truncation instead of claiming a lossless attribute result", async () => {
    const result = await api().query("feature.attributes", { key: key(), fields: ["values"] });
    expect(result).toMatchObject({ ok: true, data: { truncated: true, attributes: { values: { nested: { tooDeep: "[truncated]" } } } } });
  });
  it("allows source attributes for hidden existing features without selecting them", async () => {
    records.get(103)!.selectable = false;
    expect(await api().query("feature.attributes", { key: key(), fields: ["name"] })).toMatchObject({ ok: true, data: { attributes: { name: "Feature 103" }, truncated: false } });
    expect(selection.snapshot().key).toBeNull();
  });
  it("preserves null attributes rather than confusing them with an unknown feature", async () => {
    records.get(103)!.attributes = null;
    expect(await api().query("feature.attributes", { key: key() })).toMatchObject({ ok: true, data: { attributes: null, truncated: false } });
    expect(await api().query("feature.attributes", { key: key(999) })).toMatchObject({ ok: false, error: { kind: "validation" } });
  });
  it("keeps reads free of jobs, frame events and selection mutations", async () => {
    const events: unknown[] = []; api().events.subscribe({}, event => events.push(event));
    await api().query("selection.snapshot", { viewportId: "main" });
    await api().query("feature.attributes", { key: key(), fields: ["name"] });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(events).toEqual([]); expect(selection.snapshot().key).toBeNull();
    expect(await api().execute("feature.attributes", { key: key() })).toMatchObject({ ok: false, error: { kind: "validation" } });
  });
  it("does not clear or expose another viewport's current selection", async () => {
    selection.select(key(104, "same", "other"), "ui", records.get(104)!.owner);
    expect(await api().execute("feature.clear", { viewportId: "main" })).toMatchObject({ ok: true, data: { selection: { key: null, source: "runtime" } } });
    expect(await api().query("selection.snapshot", { viewportId: "main" })).toMatchObject({ ok: true, data: { selection: { key: null, source: "runtime" } } });
    expect(selection.snapshot().key?.viewportId).toBe("other");
  });
  it("clearing an empty target viewport invalidates its pending pick while preserving another selection", async () => {
    selection.select(key(104, "same", "other"), "ui", records.get(104)!.owner);
    const pending = selection.beginPick();
    await api().execute("feature.clear", { viewportId: "main" });
    expect(selection.commitPick(pending, key(), records.get(103)!.owner)).toBe(false);
    expect(selection.snapshot().key?.viewportId).toBe("other");
  });
  it.each([{ key: key(), extra: true }, { key: key(0) }, { key: { ...key(), extra: 1 } }, { key: key(103, "") }])("rejects malformed select input %j", async input => {
    expect(await api().execute("feature.select", input)).toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(selection.snapshot().key).toBeNull();
  });
});
