import { describe, expect, it } from "vitest";
import "../agent-actions/actions";
import { installAgentActions } from "../agent-actions/registry";
import { validateApiInput, type ApiDescriptor } from "../agent-actions/contracts";

// Successful data copied from the safe 11:18 real-browser captures listed in
// P1-01-runtime-output-contracts.md. These are replayed payloads, not new handler
// executions. Keep this test portable: it does not read ignored .artifacts files.
const capturedOutputs = [
  { id: "time.set", data: { ageMa: 50, committedAgeMa: 50 } },
  { id: "time.setPlaying", data: { playing: false } },
  { id: "time.setSpeed", data: { speedMaPerSecond: 25, requestedSpeedMaPerSecond: 25 } },
  { id: "camera.reset", data: { projectionId: "rectangle", camera: {
    position: [12742000, 0, 0], direction: [-1, 0, 0], up: [2.220446049250313e-16, 2.220446049250313e-16, 1],
  } } },
  { id: "camera.zoom", data: { mode: "rectangle", factor: 0.8, width: 49267905.959435254 } },
  { id: "camera.pan", data: { mode: "rectangle", deltaX: 12, deltaY: 8, width: 49267905.959435254 } },
  { id: "projection.select", data: { projectionId: "rectangle", revision: 5 } },
  { id: "layer.setVisibility", data: { active: false, layerId: 2, effective: false } },
  { id: "layer.setOpacity", data: { alpha: 0.8, layerId: 2, effective: 0.4 } },
  { id: "layer.group.setCollapsed", data: { collapsed: true, groupId: 103 } },
  { id: "layer.setGroup", data: { groupId: 104, layerId: 2 } },
  { id: "layer.setOrder", data: { orderedIds: [1, 2, 3, 4], groupIdByLayer: { "1": 101, "2": 104, "3": 101, "4": 102 } } },
];

async function descriptor(id: string): Promise<ApiDescriptor> {
  const target = {} as Window;
  installAgentActions(target);
  const value = await target.timeMachineAgent!.v2.catalog.describe(id);
  if (!value) throw new Error(`Missing actual catalog descriptor ${id}`);
  return value;
}

describe("time, camera, projection and layer output contracts", () => {
  it.each(capturedOutputs)("accepts recorded success data and rejects missing/extra/wrong-type fields for $id", async ({ id, data }) => {
    const { outputSchema, inputSchema, examples } = await descriptor(id);
    expect(validateApiInput(outputSchema, data)).toBeUndefined();
    expect(outputSchema.additionalProperties).toBe(false);
    expect([...(outputSchema.required ?? [])].sort()).toEqual(Object.keys(data).sort());
    expect(validateApiInput(outputSchema, { ...data, undeclared: true })).toBeDefined();
    for (const key of Object.keys(data)) {
      const missing: Record<string, unknown> = { ...data }; delete missing[key];
      expect(validateApiInput(outputSchema, missing), `missing ${key}`).toBeDefined();
      expect(validateApiInput(outputSchema, { ...data, [key]: null }), `wrong type ${key}`).toBeDefined();
    }
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples as Array<{ input: unknown; output?: unknown; resultDescription?: string }>) {
      expect(validateApiInput(inputSchema, example.input)).toBeUndefined();
      if (id === "camera.reset") {
        expect(example).not.toHaveProperty("output");
        expect(example.resultDescription).toContain("three-component");
      } else expect(validateApiInput(outputSchema, example.output)).toBeUndefined();
    }
  });

  it("describes actual presets and clamped flat-camera results without advertising a Globe success", async () => {
    const speed = (await descriptor("time.setSpeed")).outputSchema;
    for (const preset of [10, 25, 50]) expect(validateApiInput(speed, { speedMaPerSecond: preset, requestedSpeedMaPerSecond: 12 })).toBeUndefined();
    expect(validateApiInput(speed, { speedMaPerSecond: 12, requestedSpeedMaPerSecond: 12 })).toBeDefined();
    expect(validateApiInput(speed, { speedMaPerSecond: 10, requestedSpeedMaPerSecond: 0 })).toBeDefined();
    const zoom = (await descriptor("camera.zoom")).outputSchema;
    for (const mode of ["rectangle", "mollweide"]) expect(validateApiInput(zoom, { mode, factor: 1, width: 1000 })).toBeUndefined();
    for (const output of [{ mode: "globe", factor: 1, width: 1000 }, { mode: "rectangle", factor: 0, width: 1000 }, { mode: "rectangle", factor: 1, width: Infinity }]) {
      expect(validateApiInput(zoom, output)).toBeDefined();
    }
    const pan = (await descriptor("camera.pan")).outputSchema;
    expect(validateApiInput(pan, { mode: "mollweide", deltaX: -100000, deltaY: 100000, width: 1000 })).toBeUndefined();
    expect(validateApiInput(pan, { mode: "rectangle", deltaX: 100001, deltaY: 0, width: 1000 })).toBeDefined();
    expect(zoom.description).toMatch(/actual|clamp/i);
  });

  it("constrains nested reset data and documents the three-component vector contract", async () => {
    const schema = (await descriptor("camera.reset")).outputSchema;
    const camera = { position: [1, 2, 3], direction: [-1, 0, 0], up: [0, 0, 1] };
    for (const projectionId of ["globe", "rectangle", "mollweide"]) expect(validateApiInput(schema, { projectionId, camera })).toBeUndefined();
    for (const badCamera of [
      { ...camera, extra: true }, { position: camera.position, direction: camera.direction },
      { ...camera, position: [1, 2] }, { ...camera, direction: [1, NaN, 3] }, { ...camera, up: [1, "2", 3] },
    ]) expect(validateApiInput(schema, { projectionId: "rectangle", camera: badCamera })).toBeDefined();
    expect(schema.properties!.camera!.properties!.position!.description).toMatch(/three|3/);
    // ApiSchema currently has minItems but no maxItems/tuple support. Do not
    // invent stricter machine validation than the shared validator can enforce.
    expect(validateApiInput(schema, { projectionId: "rectangle", camera: { ...camera, position: [1, 2, 3, 4] } })).toBeUndefined();
  });

  it("rejects invalid IDs, ranges, revisions and dictionary values while preserving legitimate effective values", async () => {
    for (const [id, data] of [
      ["time.set", { ageMa: -1, committedAgeMa: 0 }],
      ["projection.select", { projectionId: "mercator", revision: 1 }],
      ["projection.select", { projectionId: "globe", revision: -1 }],
      ["projection.select", { projectionId: "rectangle", revision: 1.5 }],
      ["layer.setVisibility", { layerId: 0, active: true, effective: true }],
      ["layer.setOpacity", { layerId: 2, alpha: 1.1, effective: 0.5 }],
      ["layer.setOpacity", { layerId: 2, alpha: 1, effective: -0.1 }],
      ["layer.group.setCollapsed", { groupId: 1.5, collapsed: true }],
      ["layer.setGroup", { layerId: 2, groupId: 0 }],
      ["layer.setOrder", { orderedIds: [1, 0], groupIdByLayer: { "1": 101 } }],
      ["layer.setOrder", { orderedIds: [1], groupIdByLayer: { "1": "101" } }],
    ] as const) expect(validateApiInput((await descriptor(id)).outputSchema, data), id).toBeDefined();
    expect(validateApiInput((await descriptor("layer.setVisibility")).outputSchema, { layerId: 2, active: true, effective: false })).toBeUndefined();
    expect(validateApiInput((await descriptor("layer.setOpacity")).outputSchema, { layerId: 2, alpha: 0.8, effective: 0.4 })).toBeUndefined();
  });
});
