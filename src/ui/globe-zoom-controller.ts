import {
	Cartesian2,
	Cartesian3,
	Math as CesiumMath,
	SceneMode,
	type Viewer,
} from "cesium";

/**
 * Globe-only zoom input owner.
 *
 * Cesium's native 3D zoom picks the world point under the cursor and the world
 * point under the screen centre. At globe distance those two normals can be
 * bit-identical while their floating-point dot is 0.9999999999999998, so the
 * native branch enters `v > 0 && v < 1`, computes `acos(v) > 0` and a
 * cross-product axis of exactly (0, 0, 0). `Camera.rotate` then normalises that
 * zero axis and writes NaN into position/direction/up/right.
 *
 * The native controller exposes no public guard for that case, so while the
 * scene is Globe this owner disables only the competing native zoom inputs
 * (`zoomEventTypes`) and reproduces the documented `handleZoom` math with
 * public Camera calls. The subtle part is the anchor compensation: a non-zero,
 * finite cross axis is rotated exactly like the native path; an identical or
 * degenerate axis skips only the compensation rotation and still performs the
 * real bounded zoom translation. No zoom is dropped, no native prototype or
 * Cesium source is touched, and flat projections keep their native camera.
 */
const AXIS_EPSILON = 1e-12;
const MINIMUM_ZOOM_RATE = 20;
const ZOOM_INERTIA = 0.88;
const INERTIA_STOP_PIXELS = 0.5;
const INERTIA_MAX_FRAMES = 90;
/** ScreenSpaceCameraController's inertiaMaxClickTimeThreshold, seconds. */
const INERTIA_MAX_GESTURE_MS = 300;
/** ScreenSpaceEventHandler converts a wheel tick to 7.5deg per reported unit. */
const WHEEL_ARC_PER_DEGREE = 7.5;
const PINCH_SEPARATION_SCALE = 0.25;

interface DragState {
	id: number;
	lastY: number;
	anchor: Cartesian2;
	lastDiff: number;
	startedAt: number;
}

interface PinchState {
	ids: [number, number];
	lastDistance: number;
	anchor: Cartesian2;
	lastDiff: number;
	startedAt: number;
}

interface TouchPoint {
	x: number;
	y: number;
}

function finiteCartesian3(value: Cartesian3): boolean {
	return (
		Number.isFinite(value.x) &&
		Number.isFinite(value.y) &&
		Number.isFinite(value.z)
	);
}

/** The complete pose a camera needs before any public camera operation. */
export function cameraPoseIsFinite(camera: {
	positionWC: Cartesian3;
	directionWC: Cartesian3;
	upWC: Cartesian3;
	rightWC: Cartesian3;
}): boolean {
	return (
		finiteCartesian3(camera.positionWC) &&
		finiteCartesian3(camera.directionWC) &&
		finiteCartesian3(camera.upWC) &&
		finiteCartesian3(camera.rightWC)
	);
}

function finitePose(camera: Viewer["camera"]): boolean {
	return cameraPoseIsFinite(camera);
}

function separation(a: TouchPoint, b: TouchPoint): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: TouchPoint, b: TouchPoint): Cartesian2 {
	return new Cartesian2((a.x + b.x) / 2, (a.y + b.y) / 2);
}

export class GlobeZoomController {
	private readonly controller: Viewer["scene"]["screenSpaceCameraController"];
	private readonly canvas: HTMLCanvasElement;
	private readonly nativeZoomEventTypes: Viewer["scene"]["screenSpaceCameraController"]["zoomEventTypes"];
	private enabled = false;
	private destroyed = false;
	private drag: DragState | undefined;
	private pinch: PinchState | undefined;
	private readonly touches = new Map<number, TouchPoint>();
	private inertiaFrame: number | undefined;

	constructor(private readonly viewer: Viewer) {
		this.canvas = viewer.scene.canvas;
		this.controller = viewer.scene.screenSpaceCameraController;
		this.nativeZoomEventTypes = this.controller.zoomEventTypes;
		this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
		this.canvas.addEventListener("pointerdown", this.onPointerDown);
		this.canvas.addEventListener("pointermove", this.onPointerMove);
		this.canvas.addEventListener("pointerup", this.onPointerUp);
		this.canvas.addEventListener("pointercancel", this.onPointerCancel);
		window.addEventListener("blur", this.onWindowBlur);
	}

	/** Globe owns the zoom inputs; flat projections get their native ones back. */
	setEnabled(enabled: boolean): void {
		if (this.destroyed) return;
		this.enabled = enabled;
		this.stopInertia();
		this.clearGestures();
		if (enabled) {
			// Cesium treats an empty array as "no zoom inputs", so nothing native
			// competes with this owner. Re-asserting here also repairs a restored
			// FlatMapCamera checkpoint that captured the native array.
			this.controller.zoomEventTypes = [];
		} else {
			this.controller.zoomEventTypes = this.nativeZoomEventTypes;
		}
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.enabled = false;
		this.stopInertia();
		this.clearGestures();
		this.canvas.removeEventListener("wheel", this.onWheel);
		this.canvas.removeEventListener("pointerdown", this.onPointerDown);
		this.canvas.removeEventListener("pointermove", this.onPointerMove);
		this.canvas.removeEventListener("pointerup", this.onPointerUp);
		this.canvas.removeEventListener("pointercancel", this.onPointerCancel);
		window.removeEventListener("blur", this.onWindowBlur);
		this.controller.zoomEventTypes = this.nativeZoomEventTypes;
	}

	private canvasPoint(clientX: number, clientY: number): Cartesian2 | undefined {
		const rect = this.canvas.getBoundingClientRect();
		const x = clientX - rect.left;
		const y = clientY - rect.top;
		return Number.isFinite(x) && Number.isFinite(y) ? new Cartesian2(x, y) : undefined;
	}

	private onWheel = (event: WheelEvent): void => {
		if (!this.enabled || this.destroyed) return;
		// The native wheel action always prevented the page default, including for
		// modifier wheels that the zoom mapping ignores; keep that behaviour.
		event.preventDefault();
		this.stopInertia();
		if (event.ctrlKey || event.shiftKey || event.altKey) return;
		let delta: number | undefined;
		if (typeof event.deltaY === "number") {
			// DOM_DELTA_LINE = 1, DOM_DELTA_PAGE = 2; numeric constants keep this
			// identical to ScreenSpaceEventHandler outside a DOM global.
			delta =
				event.deltaMode === 1
					? -event.deltaY * 40
					: event.deltaMode === 2
						? -event.deltaY * 120
						: -event.deltaY;
		}
		if (delta === undefined || !Number.isFinite(delta) || delta === 0) return;
		const anchor = this.canvasPoint(event.clientX, event.clientY);
		if (!anchor) return;
		// Same conversion and sign as ScreenSpaceEventHandler -> camera zoom3D.
		const diff = WHEEL_ARC_PER_DEGREE * CesiumMath.toRadians(delta);
		if (!Number.isFinite(diff)) return;
		this.applyDistance(diff, anchor);
		this.beginInertia(diff * 0.5, anchor, 0);
	};

	private onPointerDown = (event: PointerEvent): void => {
		if (!this.enabled || this.destroyed) return;
		this.stopInertia();
		if (event.pointerType === "touch") {
			this.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
			if (this.touches.size !== 2) return;
			const entries = [...this.touches.entries()];
			const first = entries[0];
			const second = entries[1];
			if (!first || !second) return;
			const anchor = midpoint(first[1], second[1]);
			this.drag = undefined;
			this.pinch = {
				ids: [first[0], second[0]],
				lastDistance: separation(first[1], second[1]) * PINCH_SEPARATION_SCALE,
				anchor,
				lastDiff: 0,
				startedAt: performance.now(),
			};
			return;
		}
		if (
			event.button !== 2 ||
			event.ctrlKey ||
			event.shiftKey ||
			event.altKey ||
			!event.isPrimary
		) {
			return;
		}
		const anchor = this.canvasPoint(event.clientX, event.clientY);
		if (!anchor) return;
		this.drag = {
			id: event.pointerId,
			lastY: event.clientY,
			anchor,
			lastDiff: 0,
			startedAt: performance.now(),
		};
	};

	private onPointerMove = (event: PointerEvent): void => {
		if (!this.enabled || this.destroyed) return;
		if (event.pointerType === "touch") {
			if (!this.touches.has(event.pointerId)) return;
			this.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
			const pinch = this.pinch;
			if (!pinch) return;
			const first = this.touches.get(pinch.ids[0]);
			const second = this.touches.get(pinch.ids[1]);
			if (!first || !second) return;
			const distance = separation(first, second) * PINCH_SEPARATION_SCALE;
			const diff = distance - pinch.lastDistance;
			pinch.lastDistance = distance;
			if (!Number.isFinite(diff) || diff === 0) return;
			pinch.lastDiff = diff;
			this.applyDistance(diff, pinch.anchor);
			return;
		}
		const drag = this.drag;
		if (!drag || drag.id !== event.pointerId) return;
		const diff = event.clientY - drag.lastY;
		drag.lastY = event.clientY;
		if (!Number.isFinite(diff) || diff === 0) return;
		drag.lastDiff = diff;
		// Native zoom picks the anchor once per gesture and keeps it, so the
		// cursor's original world point stays fixed while the camera moves.
		this.applyDistance(diff, drag.anchor);
	};

	private onPointerUp = (event: PointerEvent): void => {
		if (!this.enabled || this.destroyed) return;
		const elapsed = performance.now();
		if (event.pointerType === "touch") {
			const pinch = this.pinch;
			this.touches.delete(event.pointerId);
			if (!pinch) return;
			this.pinch = undefined;
			this.beginInertia(pinch.lastDiff * 0.5, pinch.anchor, elapsed - pinch.startedAt);
			return;
		}
		const drag = this.drag;
		if (!drag || drag.id !== event.pointerId) return;
		this.drag = undefined;
		this.beginInertia(drag.lastDiff * 0.5, drag.anchor, elapsed - drag.startedAt);
	};

	private onPointerCancel = (): void => {
		this.clearGestures();
	};

	private onWindowBlur = (): void => {
		this.stopInertia();
		this.clearGestures();
	};

	private clearGestures(): void {
		this.drag = undefined;
		this.pinch = undefined;
		this.touches.clear();
	}

	private beginInertia(diff: number, anchor: Cartesian2, gestureMs: number): void {
		if (!Number.isFinite(diff) || Math.abs(diff) < INERTIA_STOP_PIXELS) return;
		if (gestureMs > INERTIA_MAX_GESTURE_MS) return;
		if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
		this.stopInertia();
		let residual = diff;
		let frames = 0;
		const step = (): void => {
			this.inertiaFrame = undefined;
			if (!this.enabled || this.destroyed) return;
			residual *= ZOOM_INERTIA;
			frames += 1;
			if (Math.abs(residual) < INERTIA_STOP_PIXELS || frames > INERTIA_MAX_FRAMES) return;
			this.applyDistance(residual, anchor);
			this.inertiaFrame = window.requestAnimationFrame(step);
		};
		this.inertiaFrame = window.requestAnimationFrame(step);
	}

	private stopInertia(): void {
		if (this.inertiaFrame !== undefined) {
			window.cancelAnimationFrame(this.inertiaFrame);
			this.inertiaFrame = undefined;
		}
	}

	/**
	 * One zoom step: the native handleZoom domain/clamp math, then a guarded
	 * anchor compensation rotation followed by the real camera translation.
	 */
	private applyDistance(diffPixels: number, anchor: Cartesian2): void {
		if (!Number.isFinite(diffPixels) || diffPixels === 0) return;
		// The owner is routed by mode, but a stale flag must never run globe zoom
		// math against a flat scene.
		if (this.viewer.scene.mode !== SceneMode.SCENE3D) return;
		const camera = this.viewer.camera;
		if (!finitePose(camera)) return;
		const height = camera.positionCartographic?.height;
		if (height === undefined || !Number.isFinite(height) || height <= 0) return;
		const canvasHeight = Math.max(1, this.canvas.clientHeight);
		if (!Number.isFinite(canvasHeight)) return;

		const zoomFactor =
			Number.isFinite(this.controller.zoomFactor) && this.controller.zoomFactor > 0
				? this.controller.zoomFactor
				: 5;
		const maximumMovementRatio =
			Number.isFinite(this.controller.maximumMovementRatio) &&
			this.controller.maximumMovementRatio > 0
				? this.controller.maximumMovementRatio
				: 0.08;
		const minimumZoomDistance = Number.isFinite(this.controller.minimumZoomDistance)
			? Math.max(0, this.controller.minimumZoomDistance)
			: 0;
		const maximumZoomDistance = Number.isFinite(this.controller.maximumZoomDistance)
			? Math.max(minimumZoomDistance, this.controller.maximumZoomDistance)
			: height;

		// Native handleZoom: the approaching-surface percentage scales the minimum
		// height, so zooming in stops further away when the view is oblique.
		const positionNormal = Cartesian3.normalize(camera.positionWC, new Cartesian3());
		const dotDirection = Cartesian3.dot(positionNormal, camera.directionWC);
		const percentage = Number.isFinite(dotDirection)
			? Math.min(1, Math.max(0.25, Math.abs(dotDirection)))
			: 0.25;
		const approaching = diffPixels > 0;
		const minHeight = approaching ? minimumZoomDistance * percentage : 0;
		if (approaching && height <= minHeight) return;
		const minDistance = height - minHeight;
		const zoomRate = Math.max(zoomFactor * minDistance, MINIMUM_ZOOM_RATE);
		const ratio = Math.min(diffPixels / canvasHeight, maximumMovementRatio);
		let distance = zoomRate * ratio;
		if (!Number.isFinite(distance)) return;

		// Bounded translation in the same height domain the controller declares.
		// The native distance caps are bypassed while enableCollisionDetection is
		// false; this owner enforces the configured public bounds itself.
		const resultingHeight = height - distance;
		if (resultingHeight < minHeight) distance = height - minHeight;
		else if (resultingHeight > maximumZoomDistance) distance = height - maximumZoomDistance;
		if (!Number.isFinite(distance) || distance === 0) return;
		if (distance > 0 && height - distance <= 0) return;

		const anchorPoint = this.pick(anchor);
		if (anchorPoint) {
			const center = new Cartesian2(this.canvas.clientWidth / 2, this.canvas.clientHeight / 2);
			const centerPoint = this.pick(center);
			if (centerPoint) {
				this.compensateAnchor(anchorPoint, centerPoint, height, distance);
			}
		}
		camera.zoomIn(distance);
		this.viewer.scene.requestRender();
	}

	/**
	 * Rotate the camera so the picked anchor reaches the screen centre, exactly
	 * like the native height >= 1e6 branch. A zero or non-finite axis is the
	 * documented defect: identical normals need no compensation at all, so the
	 * step is skipped and the caller still performs the valid translation.
	 */
	private compensateAnchor(
		anchorPoint: Cartesian3,
		centerPoint: Cartesian3,
		height: number,
		distance: number,
	): void {
		const pickedNormal = Cartesian3.normalize(anchorPoint, new Cartesian3());
		const positionNormal = Cartesian3.normalize(centerPoint, new Cartesian3());
		if (!finiteCartesian3(pickedNormal) || !finiteCartesian3(positionNormal)) return;
		const dot = Math.max(-1, Math.min(1, Cartesian3.dot(pickedNormal, positionNormal)));
		const axis = Cartesian3.cross(pickedNormal, positionNormal, new Cartesian3());
		const axisMagnitude = Cartesian3.magnitude(axis);
		if (!Number.isFinite(dot) || !Number.isFinite(axisMagnitude)) return;
		if (!(axisMagnitude > AXIS_EPSILON)) return;
		// atan2(sin, cos) is the stable form of acos(dot) near dot = 1.
		const angle = Math.atan2(axisMagnitude, dot);
		if (!Number.isFinite(angle) || angle === 0) return;
		const denominator =
			Math.abs(angle) > CesiumMath.toRadians(20) ? height * 0.75 : height - distance;
		if (!Number.isFinite(denominator) || Math.abs(denominator) <= 1e-9) return;
		const rotation = (angle * distance) / denominator;
		if (!Number.isFinite(rotation) || rotation === 0) return;
		const unitAxis = Cartesian3.divideByScalar(axis, axisMagnitude, new Cartesian3());
		if (!finiteCartesian3(unitAxis)) return;
		const position = Cartesian3.clone(this.viewer.camera.positionWC);
		const direction = Cartesian3.clone(this.viewer.camera.directionWC);
		const up = Cartesian3.clone(this.viewer.camera.upWC);
		try {
			this.viewer.camera.rotate(unitAxis, rotation);
		} catch {
			this.restorePose(position, direction, up);
			return;
		}
		// Defense in depth: a corrupt compensation never reaches the render loop.
		if (!finitePose(this.viewer.camera)) this.restorePose(position, direction, up);
	}

	private restorePose(position: Cartesian3, direction: Cartesian3, up: Cartesian3): void {
		this.viewer.camera.setView({ destination: position, orientation: { direction, up } });
	}

	private pick(windowPosition: Cartesian2): Cartesian3 | undefined {
		const ellipsoid = this.viewer.scene.globe?.ellipsoid;
		if (!ellipsoid) return undefined;
		const picked = this.viewer.camera.pickEllipsoid(
			windowPosition,
			ellipsoid,
			new Cartesian3(),
		);
		return picked && finiteCartesian3(picked) ? picked : undefined;
	}
}
