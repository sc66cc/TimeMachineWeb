import {
  RasterSelectionError,
  type SingleRasterLayerController,
  type SingleRasterSelectionResult,
} from "@timemachine/raster-runtime";
import { OperationInterruptedError } from "../agent-actions/operation";

/** Keep the runtime independent of the application's operation error contract. */
export async function executeRasterSelection(
  controller: Pick<SingleRasterLayerController, "selectAsync">,
  rasterId: string,
  signal?: AbortSignal,
): Promise<SingleRasterSelectionResult> {
  try {
    return await controller.selectAsync(rasterId, { signal });
  } catch (error) {
    if (error instanceof RasterSelectionError) {
      if (error.kind === "cancelled" || error.kind === "disposed") {
        throw new OperationInterruptedError("cancelled", error.message);
      }
      if (error.kind === "superseded") {
        throw new OperationInterruptedError("superseded", error.message);
      }
    }
    throw error;
  }
}
