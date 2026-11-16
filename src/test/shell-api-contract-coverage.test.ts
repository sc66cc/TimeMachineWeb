import { describe, expect, it } from "vitest";
import "../agent-actions/actions";
import { AGENT_DECLARATIONS } from "../agent-actions/actions";
import { agentActions, installAgentActions } from "../agent-actions/registry";
import { FeatureSelection } from "../layers/selection";
import { registerSelectionActions } from "../layers/selection-actions";

/**
 * The catalog is the discovery surface the shell API relies on, so its shape is
 * asserted rather than eyeballed. Counts here are the real ones for this build;
 * they are not carried over from an earlier revision.
 */
function v2() {
  const target = {} as Window;
  installAgentActions(target);
  return target.timeMachineAgent!.v2;
}

/** Contracts attached by `registerSelectionActions` inside the app. */
registerSelectionActions(new FeatureSelection(), {
  assertViewport: () => {},
  readFeature: () => {
    throw new Error("This suite only reads contracts.");
  },
});

const SNAPSHOT_QUERIES = ["scene.snapshot", "project.snapshot", "ui.snapshot"];
/** Declarations this build ships without a handler, as `actions.ts` marks them. */
const PLACEHOLDER_ACTION_IDS = Object.values(AGENT_DECLARATIONS)
  .filter(definition => definition.status === "unsupported")
  .map(definition => definition.id);
const RESERVED = 15;
const AUXILIARY = 9;
const EVENTS = 3;

describe("frontend contract coverage", () => {
  it("keeps the documented catalog composition", () => {
    const rows = v2().catalog.list();
    const ids = rows.map(row => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(AGENT_DECLARATIONS).length).toBe(70);
    // 70 registered (the original 64 plus six shell controls) + 3 snapshots
    // + 3 events + 9 facade helpers + 19 reserved, minus the two registered
    // ids that the reserved table also names.
    expect(rows.length).toBe(102);
    expect(rows.filter(row => row.kind === "event").length).toBe(EVENTS);
    // Four reserved Server endpoints are already named by the internal adapter
    // catalog: capabilities, the public catalog and two account-scoped reads.
    expect(rows.filter(row => row.id.startsWith("service.")).map(row => row.id)).toEqual([
      "service.TimeMachinePlatform.GetCapabilities",
      "service.UserPlateModel.Display",
      "service.UserPlateModel.DisplayMine",
      "service.UserPlateModel.GetDetail",
    ]);
    // `events.subscribe` is the only other service-kind entry: a direct facade
    // method, not a Server endpoint.
    expect(rows.filter(row => row.kind === "service").map(row => row.id))
      .toEqual(["events.subscribe", ...rows.filter(row => row.id.startsWith("service.")).map(row => row.id)].sort());
    // 19 ids are reserved by the plan; the four selection/attribute entries
    // are covered by real registered contracts, so only 15 still carry a
    // reserved schema reference.
    const reservedIds = rows.filter(row => row.schemaRef.startsWith("reserved:")).map(row => row.id);
    expect(reservedIds.length).toBe(RESERVED);
    for (const id of ["feature.select", "feature.clear", "selection.snapshot", "feature.attributes"]) {
      expect(rows.find(row => row.id === id)?.schemaRef).toBe(`action:${id}:v2`);
    }
  });

  it("ships the six shell controls as typed, ui-local, state-committed actions", async () => {
    const api = v2();
    const rows = api.catalog.list();
    const ids = [
      "ui.addPanel.setVisible",
      "ui.console.clear",
      "ui.console.selectOutput",
      "ui.console.setVisible",
      "ui.sidebar.setVisible",
      "ui.welcome.setVisible",
    ] as const;
    const original = Object.keys(AGENT_DECLARATIONS).filter(
      id => !(ids as readonly string[]).includes(id),
    );
    expect(original).toHaveLength(64);
    for (const id of ids) {
      const summary = rows.find(row => row.id === id);
      // This registry has no mounted AppShell, so a declaration is honestly
      // reported as not implemented; the mounted suites exercise the handlers.
      expect(summary, id).toMatchObject({
        id, kind: "command", effect: "ui-local", completion: "state-committed", availability: "not-implemented",
      });
      const descriptor = await api.catalog.describe(id);
      expect(descriptor, id).toBeDefined();
      expect(descriptor!.inputSchema.type, id).toBe("object");
      expect(descriptor!.outputSchema.type, id).toBe("object");
      expect(descriptor!.outputSchema.description ?? descriptor!.description, id).toEqual(expect.any(String));
    }
  });

  it("resolves a descriptor for every catalog id", async () => {
    const api = v2();
    const missing: string[] = [];
    for (const row of api.catalog.list()) {
      const descriptor = await api.catalog.describe(row.id);
      if (!descriptor || descriptor.id !== row.id || descriptor.schemaRef !== row.schemaRef) missing.push(row.id);
    }
    expect(missing).toEqual([]);
  });

  it("declares a real input type for every implemented contract", async () => {
    const api = v2();
    const unresolved: string[] = [];
    for (const row of api.catalog.list()) {
      const descriptor = await api.catalog.describe(row.id);
      if (!descriptor) continue;
      if (descriptor.inputSchema.type !== undefined) continue;
      // Reserved entries document intent in prose instead of a schema; that is
      // reported as reserved metadata rather than passed off as a schema.
      if (row.schemaRef.startsWith("reserved:")) continue;
      unresolved.push(row.id);
    }
    expect(unresolved).toEqual([]);
  });

  it("keeps output schemas precise everywhere except documented dynamic reads", async () => {
    const api = v2();
    const generic: string[] = [];
    for (const row of api.catalog.list()) {
      const descriptor = await api.catalog.describe(row.id);
      if (!descriptor) continue;
      const output = descriptor.outputSchema as Record<string, unknown>;
      if (output.type === "object" && output.additionalProperties === true &&
          !output.properties && !output.required) generic.push(row.id);
    }
    // Snapshot queries return a dynamic section by design; the eight
    // placeholder actions are declared unsupported and have no handler output.
    const expected = [...SNAPSHOT_QUERIES, ...PLACEHOLDER_ACTION_IDS].sort();
    expect(generic.sort()).toEqual(expected);
  });

  it("describes the handler result for every implemented action", async () => {
    const api = v2();
    const vague: string[] = [];
    for (const row of api.catalog.list()) {
      if (row.kind !== "command" || row.schemaRef.startsWith("reserved:")) continue;
      if (PLACEHOLDER_ACTION_IDS.includes(row.id)) continue;
      const descriptor = await api.catalog.describe(row.id);
      const output = descriptor!.outputSchema as Record<string, unknown>;
      // A precise output either declares its own properties or delegates to a
      // named native return type with a description.
      const precise = (output.properties && Object.keys(output.properties).length > 0) ||
        (output.oneOf !== undefined) || typeof output.description === "string";
      if (!precise) vague.push(row.id);
    }
    expect(vague).toEqual([]);
  });

  it("does not advertise job options for inline operations", () => {
    const rows = new Map(v2().catalog.list().map(row => [row.id, row]));
    const jobActions = [...rows.values()].filter(row => row.execution === "job").map(row => row.id).sort();
    expect(jobActions).toEqual([
      "camera.reset", "layer.add", "layer.remove", "layer.retry", "points.load",
      "points.selectDataset", "projection.select", "raster.select", "time.set",
    ]);
    // `layer.remove` cannot be cancelled; the others declare cancellation.
    expect(jobActions.filter(id => rows.get(id)?.cancellationSupported === false)).toEqual(["layer.remove"]);
    for (const row of rows.values()) {
      if (row.execution === "job") continue;
      expect(row.cancellationSupported, row.id).toBeUndefined();
    }
  });

  it("keeps page-reload operations out of v2 while v1 keeps the handler", async () => {
    const rows = new Map(v2().catalog.list().map(row => [row.id, row]));
    const reload = ["dataset.select", "model.select", "project.open", "upload.run"];
    for (const id of reload) {
      expect(rows.get(id)?.completion, id).toBe("page-reload");
      expect(rows.get(id)?.availability, id).toBe("not-implemented");
      expect(await v2().execute(id, {})).toMatchObject({ ok: false, status: "failed", error: { kind: "not-implemented" } });
    }
    // The declaration is ready and its handler is attached inside the app, so
    // v1 can still run it; only the v2 completion contract is missing.
    expect(AGENT_DECLARATIONS["model.select"].status).toBe("ready");
  });
});
