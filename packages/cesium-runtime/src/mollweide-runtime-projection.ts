import { EARTH_RADIUS_METRES } from "./geometry";
import { createProjection, type ProjectedPoint } from "./map-projection";

export const mollweideReference = createProjection("mollweide");
const scale = Math.SQRT2 * EARTH_RADIUS_METRES;

/** Runtime-only solve; the accepted forward bisection oracle stays unchanged. */
export function projectMollweideRuntime(longitude: number, latitude: number): ProjectedPoint {
  if (!Number.isFinite(longitude) || Math.abs(longitude) > 180 ||
      !Number.isFinite(latitude) || Math.abs(latitude) > 89) {
    return mollweideReference.projectRelative(longitude, latitude);
  }
  const target = Math.PI * Math.sin(latitude * Math.PI / 180);
  let theta = latitude * Math.PI / 180;
  let low = -Math.PI / 2;
  let high = Math.PI / 2;
  for (let iteration = 0; iteration < 20; iteration++) {
    const residual = 2 * theta + Math.sin(2 * theta) - target;
    if (Math.abs(residual) < 2e-16) break;
    if (residual < 0) low = theta;
    else high = theta;
    const next = theta - residual / (2 + 2 * Math.cos(2 * theta));
    if (Math.abs(next - theta) < 3e-16) {
      theta = next;
      break;
    }
    theta = next > low && next < high ? next : (low + high) / 2;
    if (iteration === 19) return mollweideReference.projectRelative(longitude, latitude);
  }
  return {
    x: 2 * scale / Math.PI * longitude * Math.PI / 180 * Math.cos(theta),
    y: scale * Math.sin(theta),
  };
}

export const mollweideRuntimeProjection = {
  ...mollweideReference,
  projectRelative: projectMollweideRuntime,
};
