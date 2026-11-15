import { describe, expect, it, vi } from "vitest";
import { AtlasTimeError, type PaleoAtlasTimeResult } from "@timemachine/raster-runtime";
import { OperationInterruptedError } from "../agent-actions/operation";
import { executeAtlasTime } from "../layers/atlas-time-operation";

describe("Atlas operation boundary", () => {
  it("forwards the age, exact signal and actual nearest-frame result", async () => {
    const signal = new AbortController().signal;
    const result: PaleoAtlasTimeResult = { status: "ready", requestedAgeMa: 65, actualFrameAgeMa: 66, sourceId: "frame66", generation: 4 };
    const controller = { setTimeAsync: vi.fn(async () => result) };
    expect(await executeAtlasTime(controller, 65, signal)).toBe(result);
    expect(controller.setTimeAsync).toHaveBeenCalledWith(65, { signal });
  });
  for (const [kind, reason] of [["cancelled", "cancelled"], ["disposed", "cancelled"], ["superseded", "superseded"]] as const) {
    it(`maps ${kind} to the application's ${reason} terminal result`, async () => {
      const controller = { setTimeAsync: vi.fn(async () => { throw new AtlasTimeError(kind, `Atlas ${kind}`); }) };
      const error = await executeAtlasTime(controller, 20).catch(error => error);
      expect(error).toBeInstanceOf(OperationInterruptedError);
      expect(error).toMatchObject({ reason, message: `Atlas ${kind}` });
    });
  }
  it("does not misclassify native cleanup or image errors as cancellation", async () => {
    for (const error of [new AtlasTimeError("recovery", "cleanup"), new AtlasTimeError("load", "image"), new Error("unknown")]) {
      const controller = { setTimeAsync: vi.fn(async () => { throw error; }) };
      await expect(executeAtlasTime(controller, 20)).rejects.toBe(error);
    }
  });
});
