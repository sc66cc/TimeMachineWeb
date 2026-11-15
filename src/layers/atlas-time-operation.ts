import { AtlasTimeError, type PaleoAtlasLayerController, type PaleoAtlasTimeResult } from "@timemachine/raster-runtime";
import { OperationInterruptedError } from "../agent-actions/operation";

/** Keep native Atlas errors independent of the application's job contract. */
export async function executeAtlasTime(
  controller: Pick<PaleoAtlasLayerController, "setTimeAsync">,
  ageMa: number,
  signal?: AbortSignal,
): Promise<PaleoAtlasTimeResult> {
  try {
    return await controller.setTimeAsync(ageMa, { signal });
  } catch (error) {
    if (error instanceof AtlasTimeError) {
      if (error.kind === "cancelled" || error.kind === "disposed") throw new OperationInterruptedError("cancelled", error.message);
      if (error.kind === "superseded") throw new OperationInterruptedError("superseded", error.message);
    }
    throw error;
  }
}
