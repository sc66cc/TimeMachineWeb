// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Cartesian3, SceneMode, type Viewer } from "cesium";
import { cameraPoseIsFinite, GlobeZoomController } from "../ui/globe-zoom-controller";

const EARTH_RADIUS = 6371000;
const MINIMUM_ZOOM_DISTANCE = EARTH_RADIUS * 1.04;
const MAXIMUM_ZOOM_DISTANCE = EARTH_RADIUS * 8;
const CANVAS_WIDTH = 1024;
const CANVAS_HEIGHT = 662;
const HOME_HEIGHT = 20_959_401.90890906;

interface Harness {
	controller: GlobeZoomController;
	canvas: HTMLCanvasElement;
	nativeZoomEventTypes: unknown[];
	state: { height: number; position: Cartesian3; direction: Cartesian3; up: Cartesian3; right: Cartesian3 };
	camera: {
		pickEllipsoid: ReturnType<typeof vi.fn>;
		zoomIn: ReturnType<typeof vi.fn>;
		rotate: ReturnType<typeof vi.fn>;
		setView: ReturnType<typeof vi.fn>;
	};
	requestRender: ReturnType<typeof vi.fn>;
	internals: {
		onPointerDown(event: PointerEvent): void;
		onPointerMove(event: PointerEvent): void;
		onPointerUp(event: PointerEvent): void;
		onWheel(event: WheelEvent): void;
	};
}

function createHarness(options: { height?: number; picks?: Cartesian3[] } = {}): Harness {
	const canvas = document.createElement("canvas");
	Object.defineProperties(canvas, {
		clientWidth: { value: CANVAS_WIDTH, configurable: true },
		clientHeight: { value: CANVAS_HEIGHT, configurable: true },
	});
	canvas.getBoundingClientRect = () =>
		({ left: 0, top: 0, right: CANVAS_WIDTH, bottom: CANVAS_HEIGHT, width: CANVAS_WIDTH, height: CANVAS_HEIGHT, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

	const state = {
		height: options.height ?? HOME_HEIGHT,
		position: new Cartesian3(0, 0, EARTH_RADIUS + (options.height ?? HOME_HEIGHT)),
		direction: new Cartesian3(0, 0, -1),
		up: new Cartesian3(0, 1, 0),
		right: new Cartesian3(1, 0, 0),
	};
	const picks = [...(options.picks ?? [])];
	const nativeZoomEventTypes = ["right-drag", "wheel", "pinch"];
	const controller = {
		zoomFactor: 5,
		maximumMovementRatio: 0.08,
		minimumZoomDistance: MINIMUM_ZOOM_DISTANCE,
		maximumZoomDistance: MAXIMUM_ZOOM_DISTANCE,
		zoomEventTypes: nativeZoomEventTypes as unknown[],
	};
	const requestRender = vi.fn();
	const camera = {
		positionWC: state.position,
		directionWC: state.direction,
		upWC: state.up,
		rightWC: state.right,
		get positionCartographic() {
			return { height: state.height };
		},
		pickEllipsoid: vi.fn(() => (picks.length ? picks.shift() : undefined)),
		zoomIn: vi.fn((amount: number) => {
			state.height -= amount;
			state.position.z += state.direction.z * amount;
		}),
		rotate: vi.fn(),
		setView: vi.fn((view: { destination: Cartesian3; orientation: { direction: Cartesian3; up: Cartesian3 } }) => {
			state.position.x = view.destination.x;
			state.position.y = view.destination.y;
			state.position.z = view.destination.z;
			state.direction.x = view.orientation.direction.x;
			state.direction.y = view.orientation.direction.y;
			state.direction.z = view.orientation.direction.z;
			state.up.x = view.orientation.up.x;
			state.up.y = view.orientation.up.y;
			state.up.z = view.orientation.up.z;
		}),
	};
	const viewer = {
		camera,
		scene: {
			mode: SceneMode.SCENE3D,
			canvas,
			screenSpaceCameraController: controller,
			globe: { ellipsoid: {} },
			requestRender,
		},
	} as unknown as Viewer;
	const zoom = new GlobeZoomController(viewer);
	zoom.setEnabled(true);
	return {
		controller: zoom,
		canvas,
		nativeZoomEventTypes,
		state,
		camera,
		requestRender,
		internals: zoom as unknown as Harness["internals"],
	};
}

function pointerEvent(x: number, y: number, overrides: Partial<{ id: number; button: number; type: string; touch: boolean }> = {}): PointerEvent {
	return {
		clientX: x,
		clientY: y,
		pointerId: overrides.id ?? 1,
		pointerType: overrides.touch ? "touch" : "mouse",
		button: overrides.button ?? 2,
		isPrimary: true,
		ctrlKey: false,
		shiftKey: false,
		altKey: false,
	} as unknown as PointerEvent;
}

function wheelEvent(deltaY: number, x = 500, y = 331): WheelEvent {
	return {
		deltaY,
		deltaMode: 0,
		clientX: x,
		clientY: y,
		ctrlKey: false,
		shiftKey: false,
		altKey: false,
		preventDefault: vi.fn(),
	} as unknown as WheelEvent;
}

const CENTER_NORMAL = Cartesian3.normalize(new Cartesian3(0.1282107, 0.9091304, -0.3962876), new Cartesian3());

beforeEach(() => {
	vi.useRealTimers();
});

describe("GlobeZoomController zero-axis anchor", () => {
	it("skips the compensation rotation for identical normals but still zooms", () => {
		const h = createHarness({
			picks: [Cartesian3.clone(CENTER_NORMAL), Cartesian3.clone(CENTER_NORMAL)],
		});
		h.internals.onPointerDown(pointerEvent(767, 374));
		h.internals.onPointerMove(pointerEvent(767, 352));

		// Identical normals are exactly the measured native defect (dot rounds to
		// 0.9999999999999998 while the cross axis is [0,0,0]).
		expect(h.camera.rotate).not.toHaveBeenCalled();
		expect(h.camera.zoomIn).toHaveBeenCalledOnce();
		const distance = h.camera.zoomIn.mock.calls[0]![0] as number;
		expect(Number.isFinite(distance)).toBe(true);
		expect(distance).toBeCloseTo(-3_482_680.075498484, 3);
		expect(h.state.height).toBeGreaterThan(HOME_HEIGHT);
		expect(cameraPoseIsFinite({ positionWC: h.state.position, directionWC: h.state.direction, upWC: h.state.up, rightWC: h.state.right })).toBe(true);
		expect(h.requestRender).toHaveBeenCalled();
	});

	it("uses a stable finite rotation for a near-zero but non-zero axis, then translates", () => {
		const tangent = Cartesian3.normalize(
			Cartesian3.cross(CENTER_NORMAL, Cartesian3.UNIT_Z, new Cartesian3()),
			new Cartesian3(),
		);
		const anchor = Cartesian3.normalize(
			Cartesian3.add(
				Cartesian3.multiplyByScalar(CENTER_NORMAL, 1, new Cartesian3()),
				Cartesian3.multiplyByScalar(tangent, 1e-7, new Cartesian3()),
				new Cartesian3(),
			),
			new Cartesian3(),
		);
		const h = createHarness({ picks: [anchor, Cartesian3.clone(CENTER_NORMAL)] });
		h.internals.onPointerDown(pointerEvent(767, 374));
		h.internals.onPointerMove(pointerEvent(767, 352));

		expect(h.camera.rotate).toHaveBeenCalledOnce();
		const [axis, angle] = h.camera.rotate.mock.calls[0] as [Cartesian3, number];
		expect(Number.isFinite(angle)).toBe(true);
		expect(Cartesian3.magnitude(axis)).toBeCloseTo(1, 12);
		expect(h.camera.zoomIn).toHaveBeenCalledOnce();
		expect(cameraPoseIsFinite({ positionWC: h.state.position, directionWC: h.state.direction, upWC: h.state.up, rightWC: h.state.right })).toBe(true);
	});

	it("never rotates around a zero axis even from a wheel tick", () => {
		const h = createHarness({
			picks: [Cartesian3.clone(CENTER_NORMAL), Cartesian3.clone(CENTER_NORMAL)],
		});
		const event = wheelEvent(100);
		h.internals.onWheel(event);
		expect(event.preventDefault).toHaveBeenCalledOnce();
		expect(h.camera.rotate).not.toHaveBeenCalled();
		expect(h.camera.zoomIn).toHaveBeenCalledOnce();
	});

	it("does not accept a corrupt native pose", () => {
		const h = createHarness({ picks: [CENTER_NORMAL, CENTER_NORMAL] });
		h.state.position.x = Number.NaN;
		h.internals.onWheel(wheelEvent(100));
		expect(h.camera.zoomIn).not.toHaveBeenCalled();
		expect(h.camera.rotate).not.toHaveBeenCalled();
	});
});

describe("GlobeZoomController bounds and routing", () => {
	it("stops zooming in at the configured minimum height", () => {
		const h = createHarness({
			height: MINIMUM_ZOOM_DISTANCE * 0.5,
			picks: [CENTER_NORMAL, CENTER_NORMAL],
		});
		h.internals.onWheel(wheelEvent(-100));
		expect(h.camera.zoomIn).not.toHaveBeenCalled();
	});

	it("clamps zoom-out to the configured maximum height", () => {
		const h = createHarness({
			height: 45_000_000,
			picks: [CENTER_NORMAL, CENTER_NORMAL],
		});
		h.internals.onPointerDown(pointerEvent(500, 200));
		h.internals.onPointerMove(pointerEvent(500, 0));
		const distance = h.camera.zoomIn.mock.calls[0]![0] as number;
		expect(distance).toBeCloseTo(45_000_000 - MAXIMUM_ZOOM_DISTANCE, 6);
		expect(h.state.height).toBeCloseTo(MAXIMUM_ZOOM_DISTANCE, 6);
	});

	it("rolls a corrupt rotation back to the last finite pose and still zooms", () => {
		const tangent = Cartesian3.normalize(
			Cartesian3.cross(CENTER_NORMAL, Cartesian3.UNIT_Z, new Cartesian3()),
			new Cartesian3(),
		);
		const anchor = Cartesian3.normalize(
			Cartesian3.add(
				CENTER_NORMAL,
				Cartesian3.multiplyByScalar(tangent, 1e-3, new Cartesian3()),
				new Cartesian3(),
			),
			new Cartesian3(),
		);
		const h = createHarness({ picks: [anchor, Cartesian3.clone(CENTER_NORMAL)] });
		h.camera.rotate.mockImplementation(() => {
			h.state.position.x = Number.NaN;
			h.state.direction.y = Number.NaN;
		});
		h.internals.onPointerDown(pointerEvent(767, 374));
		h.internals.onPointerMove(pointerEvent(767, 352));

		expect(h.camera.setView).toHaveBeenCalledOnce();
		expect(h.camera.zoomIn).toHaveBeenCalledOnce();
		expect(cameraPoseIsFinite({ positionWC: h.state.position, directionWC: h.state.direction, upWC: h.state.up, rightWC: h.state.right })).toBe(true);
	});

	it("owns the native zoom inputs only while enabled and releases them on destroy", () => {
		const h = createHarness();
		const controller = (h.controller as unknown as { controller: { zoomEventTypes: unknown[] } }).controller;
		expect(controller.zoomEventTypes).toEqual([]);

		h.controller.setEnabled(false);
		expect(controller.zoomEventTypes).toBe(h.nativeZoomEventTypes);

		h.controller.setEnabled(true);
		expect(controller.zoomEventTypes).toEqual([]);

		const remove = vi.spyOn(h.canvas, "removeEventListener");
		h.controller.destroy();
		expect(controller.zoomEventTypes).toBe(h.nativeZoomEventTypes);
		expect(remove.mock.calls.map(call => call[0])).toEqual([
			"wheel",
			"pointerdown",
			"pointermove",
			"pointerup",
			"pointercancel",
		]);
	});

	it("ignores inputs once disabled so flat projections keep their native camera", () => {
		const h = createHarness();
		h.controller.setEnabled(false);
		h.internals.onWheel(wheelEvent(100));
		expect(h.camera.zoomIn).not.toHaveBeenCalled();
	});
});

describe("cameraPoseIsFinite", () => {
	it("requires every pose vector to be finite", () => {
		const pose = {
			positionWC: new Cartesian3(1, 2, 3),
			directionWC: new Cartesian3(0, 0, -1),
			upWC: new Cartesian3(0, 1, 0),
			rightWC: new Cartesian3(1, 0, 0),
		};
		expect(cameraPoseIsFinite(pose)).toBe(true);
		expect(cameraPoseIsFinite({ ...pose, upWC: new Cartesian3(0, Number.NaN, 0) })).toBe(false);
	});
});
