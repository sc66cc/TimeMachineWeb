import {
  CameraEventType, Cartesian2, Cartesian3, Color, KeyboardEventModifier, Material,
  Matrix4, OrthographicFrustum, PolylineCollection, type Viewer,
} from "cesium";
import { createProjection, EARTH_RADIUS_METRES, MOLLWEIDE_DEPTH } from "@timemachine/cesium-runtime";

type Mode = "globe" | "rectangle" | "mollweide";
const controlKeys = [
  "enableRotate", "enableTilt", "enableLook", "enableTranslate", "enableZoom",
  "enableCollisionDetection", "minimumZoomDistance", "maximumZoomDistance", "zoomEventTypes",
] as const;

export function flatMapWidths(mode: Exclude<Mode, "globe">, aspect: number) {
  const worldWidth = mode === "rectangle"
    ? 2 * Math.PI * EARTH_RADIUS_METRES
    : 4 * Math.SQRT2 * EARTH_RADIUS_METRES;
  const worldHeight = worldWidth / 2;
  const fit = Math.max(worldWidth, aspect * worldHeight);
  return { worldWidth, worldHeight, fit, home: fit / 0.65, max: fit / 0.20, min: 1000 };
}

export function normalizeWheelDelta(delta: number, mode: number, height: number): number {
  return delta * (mode === 1 ? 16 : mode === 2 ? height : 1);
}

export function wheelWidth(width: number, delta: number, limits: { min: number; max: number }): number {
  const exponent = Math.max(-20, Math.min(20, delta * 0.002));
  return Math.min(limits.max, Math.max(limits.min, width * Math.exp(exponent)));
}

/** Public Cesium camera APIs; a native SCENE3D hosts the Mollweide plane. */
export class FlatMapCamera {
  private mode: Mode = "globe";
  private globe: ReturnType<FlatMapCamera["capture"]> | undefined;
  private masks: { object: { show: boolean }; show: boolean }[] = [];
  private graticule: PolylineCollection | undefined;
  private pan: { x: number; y: number; id: number } | undefined;
  private readonly projection = createProjection("mollweide");
  private readonly observer: ResizeObserver;
  private readonly canvas: HTMLCanvasElement;

  constructor(private readonly viewer: Viewer) {
    const canvas = viewer.scene.canvas;
    this.canvas = canvas;
    canvas.addEventListener("wheel", this.wheel, { passive: false });
    canvas.addEventListener("pointerdown", this.down);
    canvas.addEventListener("pointermove", this.move);
    canvas.addEventListener("pointerup", this.up);
    canvas.addEventListener("pointercancel", this.up);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
  }

  private get aspect(): number {
    const canvas = this.viewer.scene.canvas;
    return canvas.clientWidth / Math.max(1, canvas.clientHeight);
  }

  capture() {
    const camera = this.viewer.camera;
    const controller = this.viewer.scene.screenSpaceCameraController;
    return {
      mode: this.mode,
      position: Cartesian3.clone(camera.positionWC),
      direction: Cartesian3.clone(camera.directionWC),
      up: Cartesian3.clone(camera.upWC),
      frustum: camera.frustum.clone(),
      factor: camera.maximumZoomFactor,
      controls: Object.fromEntries(controlKeys.map(key => [key, controller[key]])),
    };
  }

  restore(snapshot: ReturnType<FlatMapCamera["capture"]>): void {
    this.setMode(snapshot.mode, false);
    const camera = this.viewer.camera;
    camera.frustum = snapshot.frustum.clone();
    camera.maximumZoomFactor = snapshot.factor;
    Object.assign(this.viewer.scene.screenSpaceCameraController, snapshot.controls);
    // With an identity reference transform, SCENE2D world axes are
    // (depth, east, north), while setView(convert:false) expects (east, north, zoom).
    // Keep the checkpoint in world coordinates for every mode.
    const rectangle = snapshot.mode === "rectangle";
    const direction = rectangle
      ? new Cartesian3(snapshot.direction.y, snapshot.direction.z, snapshot.direction.x)
      : snapshot.direction;
    const up = rectangle
      ? new Cartesian3(snapshot.up.y, snapshot.up.z, snapshot.up.x)
      : snapshot.up;
    const frustum2D = snapshot.frustum as unknown as import("cesium").OrthographicOffCenterFrustum;
    camera.setView({
      destination: rectangle
        ? new Cartesian3(snapshot.position.y, snapshot.position.z, frustum2D.right! - frustum2D.left!)
        : snapshot.position,
      orientation: { direction, up },
      endTransform: Matrix4.IDENTITY,
      convert: false,
    });
    if (rectangle) {
      // In 2D setView writes only east/north; its destination.z controls zoom,
      // so restore the checkpoint's independent camera depth explicitly.
      camera.position = new Cartesian3(snapshot.position.y, snapshot.position.z, snapshot.position.x);
    }
    if (snapshot.mode !== "globe") {
      // Avoid the lossy direction -> heading/pitch/roll -> direction round-trip
      // near a radial view after panning the native 3D Mollweide plane.
      camera.direction = Cartesian3.normalize(direction, new Cartesian3());
      camera.right = Cartesian3.normalize(Cartesian3.cross(camera.direction, up, new Cartesian3()), new Cartesian3());
      camera.up = Cartesian3.cross(camera.right, camera.direction, new Cartesian3());
    }
    // setView can adjust orthographic width; the checkpoint owns the final width.
    camera.frustum = snapshot.frustum.clone();
    this.viewer.scene.requestRender();
  }

  setMode(mode: Mode, home = true): void {
    const scene = this.viewer.scene;
    const camera = this.viewer.camera;
    const controller = scene.screenSpaceCameraController;
    camera.cancelFlight();
    this.cancelPan();
    if (this.mode === "globe" && mode !== "globe") this.globe = this.capture();
    if (mode !== "mollweide") this.restoreMasks();

    if (mode === "globe") {
      scene.morphTo3D(0);
      this.mode = mode;
      if (this.globe) {
        const saved = this.globe;
        this.globe = undefined;
        this.restore(saved);
      }
      return;
    }

    if (mode === "rectangle") {
      // Morph from the saved globe pose as well as its perspective frustum:
      // the plane camera lives far outside the ellipsoid in a custom direction.
      if (this.mode === "mollweide" && this.globe) {
        camera.frustum = this.globe.frustum.clone();
        camera.setView({
          destination: this.globe.position,
          orientation: { direction: this.globe.direction, up: this.globe.up },
          endTransform: Matrix4.IDENTITY,
          convert: false,
        });
        camera.frustum = this.globe.frustum.clone();
      }
      scene.morphTo2D(0);
      controller.enableRotate = false;
      controller.enableTilt = false;
      controller.enableLook = false;
      controller.enableTranslate = true;
      controller.enableZoom = true;
      controller.enableCollisionDetection = true;
      controller.zoomEventTypes = [
        CameraEventType.WHEEL,
        CameraEventType.PINCH,
        { eventType: CameraEventType.WHEEL, modifier: KeyboardEventModifier.CTRL },
      ];
    } else {
      if (this.mode === "rectangle") scene.morphTo3D(0);
      this.hideMasks();
      controller.enableRotate = false;
      controller.enableTilt = false;
      controller.enableLook = false;
      controller.enableTranslate = false;
      controller.enableZoom = false;
      camera.frustum = new OrthographicFrustum({
        width: flatMapWidths(mode, this.aspect).home,
        aspectRatio: this.aspect,
        near: 1,
        far: 32 * EARTH_RADIUS_METRES,
      });
      this.ensureGraticule();
    }
    this.mode = mode;
    if (this.graticule) this.graticule.show = mode === "mollweide";
    this.resize();
    if (home) this.home();
  }

  home(): void {
    if (this.mode === "globe") return;
    const camera = this.viewer.camera;
    const limits = flatMapWidths(this.mode, this.aspect);
    if (this.mode === "rectangle") {
      camera.setView({
        destination: new Cartesian3(0, 0, limits.home),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        endTransform: Matrix4.IDENTITY,
        convert: false,
      });
    } else {
      camera.setView({
        destination: new Cartesian3(MOLLWEIDE_DEPTH + 8 * EARTH_RADIUS_METRES, 0, 0),
        orientation: { direction: new Cartesian3(-1, 0, 0), up: new Cartesian3(0, 0, 1) },
        endTransform: Matrix4.IDENTITY,
        convert: false,
      });
      const frustum = camera.frustum as OrthographicFrustum;
      frustum.aspectRatio = this.aspect;
      frustum.width = limits.home;
    }
    this.viewer.scene.requestRender();
  }

  private get viewWidth(): number {
    const frustum = this.viewer.camera.frustum;
    return frustum instanceof OrthographicFrustum ? frustum.width! :
      (frustum as import("cesium").OrthographicOffCenterFrustum).right! - (frustum as import("cesium").OrthographicOffCenterFrustum).left!;
  }

  /** Multiplicative view width; reports the actual clamp, never the request. */
  zoom(factor: number) {
    const before = this.viewWidth;
    if (this.mode === "globe") throw new Error("Flat camera required.");
    const limits = flatMapWidths(this.mode, this.aspect);
    const width = Math.min(limits.max, Math.max(limits.min, before * factor));
    if (this.mode === "mollweide") (this.viewer.camera.frustum as OrthographicFrustum).width = width;
    else {
      const frustum = this.viewer.camera.frustum as unknown as import("cesium").OrthographicOffCenterFrustum;
      const scale = width / before;
      frustum.left = frustum.left! * scale;
      frustum.right = frustum.right! * scale;
      frustum.top = frustum.top! * scale;
      frustum.bottom = frustum.bottom! * scale;
    }
    this.viewer.scene.requestRender();
    return { mode: this.mode, factor: this.viewWidth / before, width: this.viewWidth };
  }

  /** CSS drag deltas: positive X moves content right, positive Y down. */
  panBy(deltaX: number, deltaY: number) {
    const width = this.viewWidth;
    const units = width / Math.max(1, this.canvas.clientWidth);
    const camera = this.viewer.camera;
    camera.moveRight(-deltaX * units);
    camera.moveUp(deltaY * units);
    // Cesium move() adjusts a SCENE3D orthographic frustum to distance from
    // the ECEF origin. That heuristic is not a zoom of our offset map plane.
    if (this.mode === "mollweide") (camera.frustum as OrthographicFrustum).width = width;
    this.viewer.scene.requestRender();
    return { mode: this.mode, deltaX, deltaY, width: this.viewWidth };
  }

  /** Pure read: complete projection domain, not the current plate geometry. */
  getSnapshot() {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const viewport = { width, height };
    if (this.mode === "globe") return { mode: this.mode, viewport };
    const limits = flatMapWidths(this.mode, this.aspect);
    const w = limits.worldWidth / 2, h = limits.worldHeight / 2;
    const domain = this.mode === "mollweide"
      ? [[-w, 0], [w, 0], [0, -h], [0, h]]
      : [[-w, -h], [w, -h], [w, h], [-w, h]];
    const frustum = this.viewer.camera.frustum;
    const off = frustum instanceof OrthographicFrustum
      ? { left: -frustum.width! / 2, right: frustum.width! / 2,
          bottom: -frustum.width! / (2 * frustum.aspectRatio!), top: frustum.width! / (2 * frustum.aspectRatio!) }
      : frustum as Required<import("cesium").OrthographicOffCenterFrustum>;
    const points = domain.map(([east, north]) => {
      // Both flat scenes use scene-world (depth, east, north). viewMatrix
      // includes SCENE2D's axis permutation; worldToCameraCoordinatesPoint
      // only changes the reference frame and is not an eye-space transform.
      const p = Matrix4.multiplyByPoint(this.viewer.camera.viewMatrix, new Cartesian3(
        this.mode === "mollweide" ? MOLLWEIDE_DEPTH : 0, east, north,
      ), new Cartesian3());
      return { x: (p.x - off.left!) / (off.right! - off.left!) * width,
        y: (off.top! - p.y) / (off.top! - off.bottom!) * height };
    });
    const left = Math.min(...points.map(p => p.x)), right = Math.max(...points.map(p => p.x));
    const top = Math.min(...points.map(p => p.y)), bottom = Math.max(...points.map(p => p.y));
    return { mode: this.mode, viewport, width: this.viewWidth,
      worldBounds: { left, top, right, bottom, width: right - left, height: bottom - top },
      worldRatio: { width: (right - left) / width, height: (bottom - top) / height } };
  }

  private resize(): void {
    if (this.mode === "globe") return;
    const limits = flatMapWidths(this.mode, this.aspect);
    const controller = this.viewer.scene.screenSpaceCameraController;
    controller.minimumZoomDistance = limits.min;
    controller.maximumZoomDistance = Math.max(limits.max, limits.max / this.aspect);
    this.viewer.camera.maximumZoomFactor = limits.max / limits.worldWidth;
    if (this.mode === "mollweide") {
      const frustum = this.viewer.camera.frustum as OrthographicFrustum;
      frustum.aspectRatio = this.aspect;
      frustum.width = Math.min(limits.max, Math.max(limits.min, frustum.width ?? limits.home));
    }
    this.viewer.scene.requestRender();
  }

  /** Reject rays outside the actual ellipse before native picking or dragging. */
  contains(position: Cartesian2): boolean {
    if (this.mode !== "mollweide") return true;
    const ray = this.viewer.camera.getPickRay(position);
    if (!ray || Math.abs(ray.direction.x) < 1e-12) return false;
    const distance = (MOLLWEIDE_DEPTH - ray.origin.x) / ray.direction.x;
    return distance >= 0 && this.projection.unproject(
      ray.origin.y + distance * ray.direction.y,
      ray.origin.z + distance * ray.direction.z,
    ) !== null;
  }

  private wheel = (event: WheelEvent): void => {
    if (this.mode === "globe") return;
    event.preventDefault();
    // Rectangle's native controller receives the same wheel exactly once.
    if (this.mode !== "mollweide") return;
    const delta = normalizeWheelDelta(event.deltaY, event.deltaMode, this.viewer.scene.canvas.clientHeight);
    this.zoom(Math.exp(Math.max(-20, Math.min(20, delta * 0.002))));
  };

  private down = (event: PointerEvent): void => {
    if (this.mode !== "mollweide" || event.button !== 0) return;
    const canvas = this.viewer.scene.canvas;
    const rect = canvas.getBoundingClientRect();
    if (!this.contains(new Cartesian2(event.clientX - rect.left, event.clientY - rect.top))) return;
    this.pan = {
      x: event.clientX, y: event.clientY,
      id: event.pointerId,
    };
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  private move = (event: PointerEvent): void => {
    const pan = this.pan;
    if (!pan || pan.id !== event.pointerId) return;
    this.panBy(event.clientX - pan.x, event.clientY - pan.y);
    pan.x = event.clientX;
    pan.y = event.clientY;
    event.preventDefault();
  };

  private up = (): void => { this.pan = undefined; };

  private cancelPan(): void {
    const canvas = this.canvas;
    if (this.pan && canvas.hasPointerCapture(this.pan.id)) canvas.releasePointerCapture(this.pan.id);
    this.pan = undefined;
  }

  private hideMasks(): void {
    if (this.masks.length) return;
    const scene = this.viewer.scene;
    for (const object of [scene.globe, scene.skyBox, scene.skyAtmosphere, scene.sun, scene.moon, scene.groundPrimitives]) {
      if (!object) continue;
      this.masks.push({ object, show: object.show });
      object.show = false;
    }
  }

  private restoreMasks(): void {
    for (const { object, show } of this.masks) object.show = show;
    this.masks = [];
    if (this.graticule) this.graticule.show = false;
  }

  private ensureGraticule(): void {
    if (this.graticule) return;
    const lines = new PolylineCollection();
    const add = (positions: Cartesian3[]): void => {
      lines.add({
        positions, width: 0.65,
        material: Material.fromType("Color", { color: Color.fromCssColorString("#9fc3c2").withAlpha(0.22) }),
      });
    };
    const point = (lon: number, lat: number): Cartesian3 => {
      const p = this.projection.projectRelative(lon, lat);
      return new Cartesian3(MOLLWEIDE_DEPTH - 1000, p.x, p.y);
    };
    for (let lat = -75; lat <= 75; lat += 15) {
      const positions = [];
      for (let lon = -180; lon <= 180; lon += 2) positions.push(point(lon, lat));
      add(positions);
    }
    for (let lon = -180; lon <= 180; lon += 30) {
      const positions = [];
      for (let lat = -90; lat <= 90; lat++) positions.push(point(lon, lat));
      add(positions);
    }
    this.graticule = this.viewer.scene.primitives.add(lines);
  }

  destroy(): void {
    this.cancelPan();
    this.observer.disconnect();
    const canvas = this.canvas;
    canvas.removeEventListener("wheel", this.wheel);
    canvas.removeEventListener("pointerdown", this.down);
    canvas.removeEventListener("pointermove", this.move);
    canvas.removeEventListener("pointerup", this.up);
    canvas.removeEventListener("pointercancel", this.up);
    this.restoreMasks();
    if (this.graticule && !this.viewer.isDestroyed()) this.viewer.scene.primitives.remove(this.graticule);
  }
}
