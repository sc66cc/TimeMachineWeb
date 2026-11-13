// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  applyPointRuntimeState,
  parsePointSizePixels,
  type PointRuntimeRenderer,
} from "../layers/point-runtime-state";
import {
  DEFAULT_POINT_STYLE,
  type PointStyleExpression,
} from "@timemachine/point-runtime";
import { ProjectSession, RUNTIME_LAYER_IDS } from "../project/project-session";

/**
 * `main.ts` pushes a layer edit into its renderer through this function, so the
 * GPU side of a point style edit is pinned here with a recording renderer and a
 * real ProjectSession instead of only the session change.
 */
function recordingRenderer(): PointRuntimeRenderer & {
  calls: { style: unknown[]; opacity: number[]; show: boolean[] };
} {
  const calls = { opacity: [], show: [], style: [] } as {
    style: unknown[];
    opacity: number[];
    show: boolean[];
  };
  return {
    calls,
    setOpacity: (alpha) => calls.opacity.push(alpha),
    setShow: (show) => calls.show.push(show),
    setStyle: (style) => calls.style.push(style),
  };
}

describe("applyPointRuntimeState", () => {
  it("pushes the stored point style, visibility and opacity to the renderer", () => {
    const session = new ProjectSession();
    const style: PointStyleExpression = {
      ...DEFAULT_POINT_STYLE,
      pointSize: 4.5,
      shape: "square",
    };
    session.setPointStyle(RUNTIME_LAYER_IDS.points, style);
    const renderer = recordingRenderer();

    applyPointRuntimeState(
      renderer,
      session.getLayer(RUNTIME_LAYER_IDS.points)?.pointStyle,
      session.getEffectiveLayerVisibility(RUNTIME_LAYER_IDS.points),
      session.getEffectiveLayerOpacity(RUNTIME_LAYER_IDS.points),
    );

    // The GPU receives the style, not just visibility and opacity.
    expect(renderer.calls.style).toEqual([expect.objectContaining(style)]);
    expect(renderer.calls.show).toEqual([true]);
    expect(renderer.calls.opacity).toEqual([1]);
  });

  it("falls back to the default expression when the layer has no style", () => {
    const renderer = recordingRenderer();
    applyPointRuntimeState(renderer, undefined, false, 0.5);
    expect(renderer.calls.style).toEqual([
      expect.objectContaining(DEFAULT_POINT_STYLE),
    ]);
    expect(renderer.calls.show).toEqual([false]);
    expect(renderer.calls.opacity).toEqual([0.5]);
  });

  it("normalizes a partially specified style before it reaches the renderer", () => {
    const renderer = recordingRenderer();
    applyPointRuntimeState(renderer, { pointSize: 99 } as PointStyleExpression, true, 1);
    const applied = renderer.calls.style[0] as PointStyleExpression;
    expect(applied.pointSize).toBe(8);
    expect(applied.singleColor).toBe(DEFAULT_POINT_STYLE.singleColor);
    expect("arbitrary" in applied).toBe(false);
  });

  it("does nothing while no renderer exists yet", () => {
    expect(() =>
      applyPointRuntimeState(undefined, undefined, true, 1),
    ).not.toThrow();
    expect(() =>
      applyPointRuntimeState(null, undefined, true, 1),
    ).not.toThrow();
  });
});

/**
 * `main.ts` validates a `points.setSize` request with this function before it
 * touches the session, so the range is pinned here on the production function
 * rather than on a copy of its logic.
 */
describe("parsePointSizePixels", () => {
  it("accepts the range boundaries", () => {
    expect(parsePointSizePixels(0.5)).toBe(0.5);
    expect(parsePointSizePixels(8)).toBe(8);
    expect(parsePointSizePixels(2.2)).toBe(2.2);
  });

  it("rejects sizes outside the range instead of clamping them", () => {
    // The session clamps these to 0.5 / 8, so accepting them here would answer
    // `ok` while storing a different size than the caller asked for.
    expect(parsePointSizePixels(0.4)).toBeUndefined();
    expect(parsePointSizePixels(13)).toBeUndefined();
    expect(parsePointSizePixels(0)).toBeUndefined();
    expect(parsePointSizePixels(-2)).toBeUndefined();
  });

  it("rejects values that are not finite numbers", () => {
    expect(parsePointSizePixels(Number.NaN)).toBeUndefined();
    expect(parsePointSizePixels(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(parsePointSizePixels(Number.NEGATIVE_INFINITY)).toBeUndefined();
    expect(parsePointSizePixels("4")).toBeUndefined();
    expect(parsePointSizePixels(undefined)).toBeUndefined();
    expect(parsePointSizePixels(null)).toBeUndefined();
  });
});
