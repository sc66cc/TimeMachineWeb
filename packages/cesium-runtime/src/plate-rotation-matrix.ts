import {
  Cartesian3,
  Matrix3,
  Matrix4,
  Quaternion as CesiumQuaternion,
} from "cesium";

import type { Quaternion } from "@timemachine/reconstruction-core";

/**
 * Model matrix for one plate rotation at a single reconstruction time.
 *
 * The globe fast path (`PlateRenderer#updateTime`) and the CPU rectangle
 * preparation (`plate-rectangle-frame`) must agree on this matrix, so the
 * GPlates quaternion-vector convention lives here once and is re-exported
 * through `plate-renderer` on its original export path. The implementation is
 * unchanged from the one it was moved from.
 */
export function quaternionToCesiumMatrix(
  quaternion: Quaternion,
  result = new Matrix4(),
): Matrix4 {
  const cesiumQuaternion = new CesiumQuaternion(
    quaternion.x,
    quaternion.y,
    quaternion.z,
    quaternion.w,
  );
  const rotation = Matrix3.fromQuaternion(cesiumQuaternion, new Matrix3());
  return Matrix4.fromRotationTranslation(
    rotation,
    Cartesian3.ZERO,
    result,
  );
}
