// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { Camera, Cartesian3, GeographicProjection, MapMode2D, Matrix4, OrthographicFrustum, OrthographicOffCenterFrustum, PerspectiveFrustum, PrimitiveCollection, SceneMode, type Scene, type Viewer } from "cesium";
import { FlatMapCamera, flatMapWidths, normalizeWheelDelta, wheelWidth } from "../projection/flat-map-camera";
import { EARTH_RADIUS_METRES, MOLLWEIDE_DEPTH } from "@timemachine/cesium-runtime";

function createRestorationCamera() {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("ImageBitmap", class {});
  vi.stubGlobal("OffscreenCanvas", class {});
  const width = 944, height = 703, aspect = width / height;
  const canvas = document.createElement("canvas");
  Object.defineProperties(canvas, { clientWidth: { value: width }, clientHeight: { value: height } });
  const primitives = new PrimitiveCollection();
  const scene = {
    canvas, mode: SceneMode.SCENE3D, mapMode2D: MapMode2D.ROTATE,
    mapProjection: new GeographicProjection(), drawingBufferWidth: width, drawingBufferHeight: height,
    pixelRatio: 1, screenSpaceCameraController: {}, primitives, requestRender: vi.fn(),
  } as unknown as Scene;
  const camera = new Camera(scene);
  const update = (mode: SceneMode) => (camera as Camera & { update(mode: SceneMode): void }).update(mode);
  const globePose = () => camera.setView({
    destination: new Cartesian3(4 * EARTH_RADIUS_METRES, 0, 0),
    orientation: { direction: new Cartesian3(-1, 0, 0), up: new Cartesian3(0, 0, 1) },
  });
  update(SceneMode.SCENE3D);
  globePose();
  Object.assign(scene, {
    // Only Scene's mode/frustum transition is controlled. Camera.setView,
    // transforms, orientation conversion and viewMatrix are the real Cesium APIs.
    morphTo2D: () => {
      if (scene.mode === SceneMode.SCENE2D) return;
      Object.assign(scene, { mode: SceneMode.SCENE2D });
      const home = flatMapWidths("rectangle", aspect).home;
      Object.assign(camera, { frustum: new OrthographicOffCenterFrustum({
        left: -home / 2, right: home / 2, bottom: -home / (2 * aspect), top: home / (2 * aspect),
        near: 1, far: 32 * EARTH_RADIUS_METRES,
      }) });
      update(SceneMode.SCENE2D);
      camera.position = new Cartesian3(0, 0, 2 * EARTH_RADIUS_METRES);
      camera.direction = new Cartesian3(0, 0, -1);
      camera.up = new Cartesian3(0, 1, 0);
      camera.right = new Cartesian3(1, 0, 0);
    },
    morphTo3D: () => {
      if (scene.mode === SceneMode.SCENE3D) return;
      Object.assign(scene, { mode: SceneMode.SCENE3D });
      camera.frustum = new PerspectiveFrustum({ aspectRatio: aspect, fov: Math.PI / 3 });
      update(SceneMode.SCENE3D);
      globePose();
    },
  });
  const flat = new FlatMapCamera({ scene, camera, isDestroyed: () => false } as unknown as Viewer);
  return { camera, flat, dispose: () => { flat.destroy(); primitives.destroy(); vi.unstubAllGlobals(); } };
}

describe("complete flat world camera domain", () => {
  for (const mode of ["rectangle", "mollweide"] as const) {
    for (const aspect of [1.6, 3, 0.75]) {
      it(`${mode} aspect ${aspect}: Home 65%, maximum zoom-out 20%`, () => {
        const limits = flatMapWidths(mode, aspect);
        const projectedExtent = (width: number): number => Math.max(
          limits.worldWidth / width,
          limits.worldHeight / (width / aspect),
        );
        expect(projectedExtent(limits.home)).toBeCloseTo(0.65, 14);
        expect(projectedExtent(limits.max)).toBeCloseTo(0.20, 14);
        expect(Number.isFinite(limits.max)).toBe(true);
        expect(wheelWidth(limits.home, 10000, limits)).toBe(limits.max);
        expect(wheelWidth(limits.max, -100, limits)).toBeLessThan(limits.max);
      });
    }
  }

  for (const mode of ["rectangle", "mollweide"] as const) for (const aspect of [0.75, 1.6, 3]) {
    it(`real Cesium view matrix: ${mode}, aspect ${aspect}`, () => {
      vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
      const canvas = document.createElement("canvas");
      Object.defineProperties(canvas, {clientWidth:{value:800*aspect},clientHeight:{value:800}});
      const scene = {canvas, mapProjection:new GeographicProjection(), drawingBufferWidth:800*aspect, drawingBufferHeight:800,
        screenSpaceCameraController:{}, requestRender:vi.fn()} as unknown as Scene;
      const camera = new Camera(scene);
      const limits=flatMapWidths(mode,aspect);
      const frustum = mode === "rectangle" ? new OrthographicOffCenterFrustum({
        left:-limits.home/2,right:limits.home/2,bottom:-limits.home/2/aspect,top:limits.home/2/aspect,near:1,far:32*EARTH_RADIUS_METRES,
      }) : new OrthographicFrustum({width:limits.home,aspectRatio:aspect,near:1,far:32*EARTH_RADIUS_METRES});
      // Cesium's declaration omits its supported 2D frustum union member.
      Object.assign(camera,{frustum});
      // Cesium Scene calls update on morph. No matrix or coordinate API is stubbed.
      (camera as Camera & {update(mode: SceneMode):void}).update(mode === "rectangle" ? SceneMode.SCENE2D : SceneMode.SCENE3D);
      camera.position = mode === "rectangle" ? new Cartesian3(0,0,8*EARTH_RADIUS_METRES) : new Cartesian3(MOLLWEIDE_DEPTH+8*EARTH_RADIUS_METRES,0,0);
      camera.direction = mode === "rectangle" ? new Cartesian3(0,0,-1) : new Cartesian3(-1,0,0);
      camera.up = mode === "rectangle" ? new Cartesian3(0,1,0) : new Cartesian3(0,0,1);
      camera.right = mode === "rectangle" ? new Cartesian3(1,0,0) : new Cartesian3(0,1,0);
      const flat = new FlatMapCamera({scene,camera} as Viewer);
      Object.assign(flat,{mode});
      const before=flat.getSnapshot();
      expect(Math.max(before.worldRatio!.width,before.worldRatio!.height)).toBeCloseTo(0.65,12);
      expect(before.worldBounds!.left).toBeCloseTo((canvas.clientWidth-before.worldBounds!.width)/2,8);
      flat.panBy(40,25);
      const panned=flat.getSnapshot();
      expect(panned.worldBounds!.width).toBeCloseTo(before.worldBounds!.width,8);
      expect(panned.worldBounds!.height).toBeCloseTo(before.worldBounds!.height,8);
      expect(panned.worldBounds!.left-before.worldBounds!.left).toBeCloseTo(40,8);
      expect(panned.worldBounds!.top-before.worldBounds!.top).toBeCloseTo(25,8);
      flat.zoom(100);
      const out=flat.getSnapshot();
      expect(Math.max(out.worldRatio!.width,out.worldRatio!.height)).toBeCloseTo(0.20,12);
      vi.unstubAllGlobals();
    });
  }

  for (const mode of ["rectangle", "mollweide"] as const) for (const adjusted of [false, true]) {
    it(`real Cesium capture/restore: ${mode}, ${adjusted ? "panned, zoomed and transformed" : "home"}`, () => {
      const { camera, flat, dispose } = createRestorationCamera();
      try {
        flat.setMode(mode);
        if (adjusted) {
          flat.zoom(0.55);
          flat.panBy(73, -41);
          if (mode === "rectangle") {
            camera.twistRight(0.25);
            camera.position.z = 3 * EARTH_RADIUS_METRES;
          }
          camera.lookAtTransform(Matrix4.fromTranslation(new Cartesian3(1000, 2000, 3000)));
        }
        const saved = flat.capture();
        const before = flat.getSnapshot();
        expect(saved.position).toEqual(camera.positionWC);
        expect(saved.direction).toEqual(camera.directionWC);
        expect(saved.up).toEqual(camera.upWC);

        flat.setMode("globe");
        expect(flat.getSnapshot().mode).toBe("globe");
        flat.restore(saved);

        for (const [actual, expected] of [
          [camera.positionWC, saved.position], [camera.directionWC, saved.direction], [camera.upWC, saved.up],
        ] as const) {
          expect(actual.x).toBeCloseTo(expected.x, 6);
          expect(actual.y).toBeCloseTo(expected.y, 6);
          expect(actual.z).toBeCloseTo(expected.z, 6);
        }
        expect(camera.frustum).toEqual(saved.frustum);
        expect(camera.transform).toEqual(Matrix4.IDENTITY);
        for (const vector of [camera.directionWC, camera.upWC, camera.rightWC]) {
          expect(Cartesian3.magnitude(vector)).toBeCloseTo(1, 12);
        }
        expect(Cartesian3.dot(camera.directionWC, camera.upWC)).toBeCloseTo(0, 12);
        expect(Cartesian3.dot(camera.directionWC, camera.rightWC)).toBeCloseTo(0, 12);
        expect(Cartesian3.dot(camera.upWC, camera.rightWC)).toBeCloseTo(0, 12);
        const after = flat.getSnapshot();
        expect(after.mode).toBe(before.mode);
        expect(after.width).toBe(before.width);
        for (const key of ["left", "top", "right", "bottom", "width", "height"] as const) {
          expect(after.worldBounds![key]).toBeCloseTo(before.worldBounds![key], 7);
        }
        expect(after.worldRatio!.width).toBeCloseTo(before.worldRatio!.width, 12);
        expect(after.worldRatio!.height).toBeCloseTo(before.worldRatio!.height, 12);
      } finally { dispose(); }
    });
  }

  it("normalizes pixel/line/page wheels once without a control-pinch sign flip", () => {
    expect(normalizeWheelDelta(10, 0, 800)).toBe(10);
    expect(normalizeWheelDelta(10, 1, 800)).toBe(160);
    expect(normalizeWheelDelta(1, 2, 800)).toBe(800);
    const limits = flatMapWidths("mollweide", 1.6);
    const out = wheelWidth(limits.home, 120, limits);
    expect(out).toBeGreaterThan(limits.home);
    expect(wheelWidth(out, -120, limits)).toBeCloseTo(limits.home, 7);
    expect(wheelWidth(limits.home, -10000, limits)).toBe(limits.min);
  });
});
