import type { LonLat, Quaternion, Vec3 } from "./types";

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const NORMALIZATION_EPSILON = 1e-15;

export const IDENTITY_QUATERNION: Readonly<Quaternion> = Object.freeze({
  w: 1,
  x: 0,
  y: 0,
  z: 0,
});

export function normalizeQuaternion(quaternion: Quaternion): Quaternion {
  const norm = Math.hypot(
    quaternion.w,
    quaternion.x,
    quaternion.y,
    quaternion.z,
  );
  if (norm < NORMALIZATION_EPSILON) {
    throw new Error("Cannot normalize a zero-magnitude quaternion.");
  }

  return {
    w: quaternion.w / norm,
    x: quaternion.x / norm,
    y: quaternion.y / norm,
    z: quaternion.z / norm,
  };
}

export function quaternionFromEulerPole(
  latitudeDeg: number,
  longitudeDeg: number,
  angleDeg: number,
): Quaternion {
  const axis = lonLatToUnitVector(longitudeDeg, latitudeDeg);
  const halfAngle = angleDeg * DEG_TO_RAD * 0.5;
  const sinHalfAngle = Math.sin(halfAngle);

  return normalizeQuaternion({
    w: Math.cos(halfAngle),
    x: axis.x * sinHalfAngle,
    y: axis.y * sinHalfAngle,
    z: axis.z * sinHalfAngle,
  });
}

/**
 * Hamilton product. multiplyQuaternions(parent, child) means: apply child,
 * then parent. This is the same premultiplication convention as
 * GPlatesMaths::compose(r1, r2).
 */
export function multiplyQuaternions(
  parent: Quaternion,
  child: Quaternion,
): Quaternion {
  return normalizeQuaternion({
    w:
      parent.w * child.w -
      parent.x * child.x -
      parent.y * child.y -
      parent.z * child.z,
    x:
      parent.w * child.x +
      parent.x * child.w +
      parent.y * child.z -
      parent.z * child.y,
    y:
      parent.w * child.y -
      parent.x * child.z +
      parent.y * child.w +
      parent.z * child.x,
    z:
      parent.w * child.z +
      parent.x * child.y -
      parent.y * child.x +
      parent.z * child.w,
  });
}

export function inverseQuaternion(quaternion: Quaternion): Quaternion {
  return {
    w: quaternion.w,
    x: -quaternion.x,
    y: -quaternion.y,
    z: -quaternion.z,
  };
}

export function quaternionDot(left: Quaternion, right: Quaternion): number {
  return (
    left.w * right.w +
    left.x * right.x +
    left.y * right.y +
    left.z * right.z
  );
}

/**
 * Shortest-path spherical linear interpolation, ported from
 * GPlates/src/maths/FiniteRotation.cc.
 */
export function slerp(
  start: Quaternion,
  end: Quaternion,
  interpolation: number,
): Quaternion {
  let cosine = quaternionDot(start, end);
  let endScaleSign = 1;

  // q and -q represent the same spatial rotation. Negating the second
  // coefficient makes interpolation follow the shorter arc on S³.
  if (cosine < 0) {
    cosine = -cosine;
    endScaleSign = -1;
  }

  if (cosine >= 1 - 1e-14) {
    return normalizeQuaternion({
      w: start.w * (1 - interpolation) + end.w * endScaleSign * interpolation,
      x: start.x * (1 - interpolation) + end.x * endScaleSign * interpolation,
      y: start.y * (1 - interpolation) + end.y * endScaleSign * interpolation,
      z: start.z * (1 - interpolation) + end.z * endScaleSign * interpolation,
    });
  }

  const theta = Math.acos(Math.min(1, Math.max(-1, cosine)));
  const inverseSinTheta = 1 / Math.sqrt(1 - cosine * cosine);
  const startScale = Math.sin((1 - interpolation) * theta) * inverseSinTheta;
  const endScale =
    endScaleSign * Math.sin(interpolation * theta) * inverseSinTheta;

  return normalizeQuaternion({
    w: start.w * startScale + end.w * endScale,
    x: start.x * startScale + end.x * endScale,
    y: start.y * startScale + end.y * endScale,
    z: start.z * startScale + end.z * endScale,
  });
}

/**
 * GPlates' optimized quaternion-vector rotation:
 * v' = (2w² - 1)v + 2(w(qv × v) + (qv · v)qv)
 */
export function rotateVector(
  quaternion: Quaternion,
  vector: Vec3,
): Vec3 {
  const dot =
    quaternion.x * vector.x +
    quaternion.y * vector.y +
    quaternion.z * vector.z;
  const crossX = quaternion.y * vector.z - quaternion.z * vector.y;
  const crossY = quaternion.z * vector.x - quaternion.x * vector.z;
  const crossZ = quaternion.x * vector.y - quaternion.y * vector.x;
  const vectorScale = 2 * quaternion.w * quaternion.w - 1;

  const rotated = {
    x:
      vectorScale * vector.x +
      2 * (quaternion.w * crossX + dot * quaternion.x),
    y:
      vectorScale * vector.y +
      2 * (quaternion.w * crossY + dot * quaternion.y),
    z:
      vectorScale * vector.z +
      2 * (quaternion.w * crossZ + dot * quaternion.z),
  };
  const magnitude = Math.hypot(rotated.x, rotated.y, rotated.z);

  return {
    x: rotated.x / magnitude,
    y: rotated.y / magnitude,
    z: rotated.z / magnitude,
  };
}

export function lonLatToUnitVector(
  longitudeDeg: number,
  latitudeDeg: number,
): Vec3 {
  const longitude = longitudeDeg * DEG_TO_RAD;
  const latitude = latitudeDeg * DEG_TO_RAD;
  const latitudeRadius = Math.cos(latitude);

  return {
    x: latitudeRadius * Math.cos(longitude),
    y: latitudeRadius * Math.sin(longitude),
    z: Math.sin(latitude),
  };
}

export function unitVectorToLonLat(vector: Vec3): LonLat {
  const magnitude = Math.hypot(vector.x, vector.y, vector.z);
  const latitude = Math.asin(
    Math.min(1, Math.max(-1, vector.z / magnitude)),
  );
  const longitude = Math.atan2(vector.y, vector.x);
  return [longitude * RAD_TO_DEG, latitude * RAD_TO_DEG];
}

export function rotateLonLat(
  quaternion: Quaternion,
  longitudeDeg: number,
  latitudeDeg: number,
): LonLat {
  return unitVectorToLonLat(
    rotateVector(
      quaternion,
      lonLatToUnitVector(longitudeDeg, latitudeDeg),
    ),
  );
}
