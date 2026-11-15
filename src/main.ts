import {
  Cartesian2,
  Cartesian3,
  Color,
  GeographicProjection,
  MapMode2D,
  Matrix4,
  SceneMode,
  Viewer,
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { createApp, nextTick } from "vue";

import AppShell from "./AppShell.vue";
import "./style.css";
import {
	isFeatureValidAtTime,
	parseGpmlPlatePolygons,
	parsePlatesRotationFile,
	RotationModel,
	type GpmlParseResult,
	type PlateFeature,
	type Quaternion,
	type RotationParseResult,
} from "@timemachine/reconstruction-core";
import {
	EARTH_RADIUS_METRES,
	PlateRenderer,
	SPHERICAL_EARTH,
	type PlatePick,
	type RenderTimeState,
} from "@timemachine/cesium-runtime";
import {
	DEFAULT_POINT_STYLE,
	GpuPointRenderer,
	MAX_PICKABLE_POINT_COUNT,
	normalizePointStyleExpression,
	POINT_SIZE_MAX_PIXELS,
	POINT_SIZE_MIN_PIXELS,
	PointPicker,
	readPointRecord,
	type LoadedPointDataset,
	type PointDatasetManifestEntry,
	type PointFixtureManifest,
	type PointRecord,
	type PointStyleExpression,
} from "@timemachine/point-runtime";
import {
	AtlasFrameResolver,
	PaleoAtlasLayerController,
	parsePaleoAtlasManifest,
	parseSingleRasterManifest,
	SingleRasterLayerController,
	type PaleoAtlasManifest,
	type PaleoAtlasRuntimeState,
	type SingleRasterEntry,
	type SingleRasterManifest,
	type SingleRasterRuntimeState,
} from "@timemachine/raster-runtime";
import { GeologicalTimeline } from "./ui/geological-timeline";
import { PerformanceMonitor } from "./ui/performance-monitor";
import { CameraResetCompletion } from "./projection/camera-reset-completion";
import { withRpcDiagnostics } from "./diagnostics/rpc-options";
import { installRuntimeErrorDiagnostics } from "./diagnostics/runtime-errors";
import { resolveStartupResources } from "./startup/resolve-startup-resources";
import { confirmStartupView } from "./startup/confirm-startup-view";
import { attachOptionalLayer } from "./startup/attach-optional-layer";
import { executeRasterSelection } from "./layers/raster-selection-operation";
import { prepareAtlasTimeGroup, type AtlasTimeGroup } from "./layers/atlas-time-group";
import { executeAtlasTime } from "./layers/atlas-time-operation";
import { requestStartupManifest } from "./startup/request-startup-manifest";
import { bootstrapTimeMachinePlatform } from "./platform-bootstrap";
import { phase1BCloudClient, CloudProjectSaveError } from "./phase1b/cloud-client";
import { convertPlateModelContent } from "./plate-model/plate-model-adapter";
import { SharedPlateModelClient } from "./plate-model/shared-plate-client";
import {
	TIME_MACHINE_ACCESS_TOKEN_KEY,
} from "./platform-bootstrap";
import {
	AGENT_ACTIONS,
	AGENT_DECLARATIONS,
	agentActions,
	installAgentActions,
} from "./agent-actions";
import {
	AgentActionAuthError,
	AgentActionBusyError,
	AgentActionUnsupportedError,
	AgentActionValidationError,
} from "./agent-actions/registry";
import type { AgentActionOutcome } from "./agent-actions/types";
import { OperationInterruptedError } from "./agent-actions/operation";
import { ProjectSession, RUNTIME_LAYER_IDS } from "./project/project-session";
import { registerProjectLocalActions } from "./project/project-actions";
import { PROJECT_STATE_EVENT, type ProjectCloudSaveState, type ProjectStateDetail } from "./project/project-events";
import { LayerController } from "./layers/layer-controller";
import { preparePointLayer, disposePointLayer } from "./layers/point-layer-preparation";
import { waitForPointLayerFrame } from "./layers/point-layer-frame";
import { registerLayerGroupActions } from "./layers/group-actions";
import { registerLayerInstanceActions, SINGLE_RASTER_SOURCE, PALEO_ATLAS_SOURCE, type LayerInstanceInput } from "./layers/instance-actions";
import { loadSyntheticVectorSource } from "./layers/synthetic-point-source";
import { NativePointLayerRuntime } from "./layers/native-point-layer-runtime";
import { NATIVE_VECTOR_DISPLAY_OFFSET_METRES } from "./layers/vector-bindings";
import { registerLayerStyleAction } from "./layers/style-action";
import { readNativePointStyle } from "./layers/native-point-style";
import { readNativeLineStyle } from "./layers/native-line-style";
import { readNativePolygonStyle } from "./layers/native-polygon-style";
import { FeatureSelection, type SelectionKey } from "./layers/selection";
import { clearFeatureSelection, registerSelectionActions, selectFeature, type SelectionFeature } from "./layers/selection-actions";
import { summarizeFeatureAttributes } from "./layers/feature-attributes";
import { createPointFeatureId, parsePointFeatureId, readPointFeatureAttributes, projectPlateFeatureAttributes } from "./layers/feature-source-records";
import {
	applyPointRuntimeState,
	parsePointSizePixels,
} from "./layers/point-runtime-state";
import {
	plateModelSourceRef,
	resolvePlateModelSource,
	type PlateModelSource,
} from "./plate-model/plate-source";
import { requireV2Workspace } from "./phase1b/v2-availability";
import {
  ProjectionController,
  type ProjectionModeId,
  type ProjectionSnapshot,
  type ProjectionTimeCounts,
} from "./projection";
import { ProjectLayerType, SystemOpenAPIInvoker } from "@timemachine/generated-api";
import {
	LAYER_GROUP_COLLAPSE_CHANGE_EVENT,
	LAYER_GROUP_OPACITY_CHANGE_EVENT,
	LAYER_GROUP_VISIBILITY_CHANGE_EVENT,
	LAYER_OPACITY_CHANGE_EVENT,
	LAYER_ORDER_CHANGE_EVENT,
	LAYER_STATE_EVENT,
	LAYER_VISIBILITY_CHANGE_EVENT,
	POINT_STYLE_CHANGE_EVENT,
	type LayerGroupCollapseChangeDetail,
	type LayerGroupOpacityChangeDetail,
	type LayerGroupVisibilityChangeDetail,
	type LayerOpacityChangeDetail,
	type LayerOrderChangeDetail,
	type LayerVisibilityChangeDetail,
	type PointStyleChangeDetail,
	type LayerStateDetail,
} from "./layers/layer-events";

const DEFAULT_DATA_URLS = {
	rotations:
		import.meta.env.VITE_ROTATION_MODEL_URL ??
		`${import.meta.env.BASE_URL}PALEOMAP_PlateModel.rot`,
	polygons:
		import.meta.env.VITE_PLATE_POLYGONS_URL ??
		`${import.meta.env.BASE_URL}PALEOMAP_PlatePolygons.gpml`,
	pointManifest:
		import.meta.env.VITE_POINT_DATA_MANIFEST_URL ??
		`${import.meta.env.BASE_URL}point-data/manifest.json`,
	atlasManifest:
		import.meta.env.VITE_PALEOATLAS_MANIFEST_URL ??
		`${import.meta.env.BASE_URL}atlas-data/manifest.json`,
	singleRasterManifest:
		import.meta.env.VITE_SINGLE_RASTER_MANIFEST_URL ??
		`${import.meta.env.BASE_URL}single-raster-data/manifest.json`,
};

function requiredElement<T extends Element>(
	selector: string,
	constructor: { new (): T },
): T {
	const element = document.querySelector(selector);
	if (!(element instanceof constructor)) {
		throw new Error(`Required UI element ${selector} was not found.`);
	}
	return element;
}

/**
 * Globe-only spin inertia switch. The custom momentum below is a 3D-globe
 * behaviour; the native 2D pan/zoom of the Rectangle projection must not be
 * polluted by it. The projection controller flips this on every mode change.
 */
let globeSpinInertiaEnabled = true;
const cancelGlobeMomentum = new WeakMap<Viewer, () => void>();

function formatTimeBoundary(timeMa: number): string {
	if (timeMa === Number.POSITIVE_INFINITY) {
		return "远古";
	}
	if (timeMa === Number.NEGATIVE_INFINITY) {
		return "未来";
	}
	return `${timeMa.toFixed(timeMa % 1 === 0 ? 0 : 1)} Ma`;
}

function eraForAge(ageMa: number): string {
	if (ageMa < 0.05) return "现在 · Present day";
	if (ageMa < 2.58) return "第四纪 · Quaternary";
	if (ageMa < 23.03) return "新近纪 · Neogene";
	if (ageMa < 66) return "古近纪 · Paleogene";
	if (ageMa < 145) return "白垩纪 · Cretaceous";
	if (ageMa < 201.4) return "侏罗纪 · Jurassic";
	if (ageMa < 251.9) return "三叠纪 · Triassic";
	if (ageMa < 298.9) return "二叠纪 · Permian";
	if (ageMa < 358.9) return "石炭纪 · Carboniferous";
	if (ageMa < 419.2) return "泥盆纪 · Devonian";
	if (ageMa < 443.8) return "志留纪 · Silurian";
	if (ageMa < 485.4) return "奥陶纪 · Ordovician";
	if (ageMa < 538.8) return "寒武纪 · Cambrian";
	return "前寒武纪 · Precambrian";
}

function formatQuaternion(quaternion: Quaternion | undefined): string {
	if (!quaternion) {
		return "无可用旋转";
	}
	return [quaternion.w, quaternion.x, quaternion.y, quaternion.z]
		.map((component) => component.toFixed(5))
		.join("  ");
}

function emptyGpmlResult(): GpmlParseResult {
	return {
		features: [],
		polygonCount: 0,
		unsupportedGeometryCount: 0,
		warnings: [],
	};
}

function emptyRotationResult(): RotationParseResult {
	return {
		diagnostics: [],
		disabledSampleCount: 0,
		parsedLineCount: 0,
		sequences: [],
	};
}

function setCameraHome(viewer: Viewer, callbacks?: { complete: () => void; cancel: () => void }): void {
	const destination = new Cartesian3(
		-EARTH_RADIUS_METRES * 0.55,
		-EARTH_RADIUS_METRES * 3.9,
		EARTH_RADIUS_METRES * 1.7,
	);
	const direction = Cartesian3.normalize(
		Cartesian3.negate(destination, new Cartesian3()),
		new Cartesian3(),
	);
	const right = Cartesian3.normalize(
		Cartesian3.cross(direction, Cartesian3.UNIT_Z, new Cartesian3()),
		new Cartesian3(),
	);
	const up = Cartesian3.normalize(
		Cartesian3.cross(right, direction, new Cartesian3()),
		new Cartesian3(),
	);
	viewer.camera.flyTo({
		destination,
		orientation: { direction, up },
		duration: 0.8,
		...callbacks,
	});
}

function configureSmoothCameraInteraction(viewer: Viewer): void {
	const scene = viewer.scene;
	const controller = scene.screenSpaceCameraController;

	// Cesium's built-in spin inertia only applies to very short clicks/drags.
	// Rotation momentum below makes the release behavior deterministic for the
	// normal-length globe drags used by this product.
	controller.inertiaSpin = 0;
	controller.inertiaTranslate = 0.93;
	controller.inertiaZoom = 0.88;
	controller.maximumMovementRatio = 0.08;
	viewer.targetFrameRate = 60;

	const canvas = scene.canvas;
	let settleTimer: number | undefined;
	let momentumFrame: number | undefined;
	let activePointerId: number | undefined;
	let lastPointerX = 0;
	let lastPointerY = 0;
	let lastPointerTime = 0;
	let lastPointerMoveAt = 0;
	let velocityX = 0;
	let velocityY = 0;

	const beginInteraction = (): void => {
		window.clearTimeout(settleTimer);
		scene.requestRenderMode = false;
	};
	const settleInteraction = (delayMs: number): void => {
		beginInteraction();
		settleTimer = window.setTimeout(() => {
			scene.requestRenderMode = true;
			scene.requestRender();
		}, delayMs);
	};

	const stopMomentum = (): void => {
		if (momentumFrame !== undefined) {
			window.cancelAnimationFrame(momentumFrame);
			momentumFrame = undefined;
		}
	};

	cancelGlobeMomentum.set(viewer, () => {
		stopMomentum();
		activePointerId = undefined;
		velocityX = 0;
		velocityY = 0;
	});

	const startMomentum = (): void => {
		stopMomentum();
		// The custom spin momentum is a globe-only behaviour. In the Rectangle
		// (2D) projection the native screen-space pan/zoom takes over, so a
		// release just settles instead of flinging a spin.
		if (!globeSpinInertiaEnabled) {
			settleInteraction(250);
			return;
		}
		const maximumVelocity = 1.6;
		velocityX = Math.max(
			-maximumVelocity,
			Math.min(maximumVelocity, velocityX),
		);
		velocityY = Math.max(
			-maximumVelocity,
			Math.min(maximumVelocity, velocityY),
		);
		if (Math.hypot(velocityX, velocityY) < 0.04) {
			settleInteraction(250);
			return;
		}

		beginInteraction();
		let previousFrameTime = performance.now();
		const animate = (frameTime: number): void => {
			if (!globeSpinInertiaEnabled) { stopMomentum(); return; }
			const elapsedMs = Math.min(34, frameTime - previousFrameTime);
			previousFrameTime = frameTime;
			const decay = Math.exp(-elapsedMs / 430);
			velocityX *= decay;
			velocityY *= decay;

			viewer.camera.rotateRight(-velocityX * elapsedMs * 0.0022);
			viewer.camera.rotateUp(-velocityY * elapsedMs * 0.0017);
			scene.requestRender();

			if (Math.hypot(velocityX, velocityY) > 0.015) {
				momentumFrame = window.requestAnimationFrame(animate);
			} else {
				momentumFrame = undefined;
				settleInteraction(180);
			}
		};
		momentumFrame = window.requestAnimationFrame(animate);
	};

	const handlePointerDown = (event: PointerEvent): void => {
		stopMomentum();
		beginInteraction();
		if (!globeSpinInertiaEnabled || event.button !== 0 || !event.isPrimary) {
			return;
		}
		activePointerId = event.pointerId;
		lastPointerX = event.clientX;
		lastPointerY = event.clientY;
		lastPointerTime = event.timeStamp;
		lastPointerMoveAt = performance.now();
		velocityX = 0;
		velocityY = 0;
	};

	const handlePointerMove = (event: PointerEvent): void => {
		if (event.pointerId !== activePointerId) {
			return;
		}
		const elapsedMs = event.timeStamp - lastPointerTime;
		if (elapsedMs > 0 && elapsedMs < 500) {
			const instantVelocityX = (event.clientX - lastPointerX) / elapsedMs;
			const instantVelocityY = (event.clientY - lastPointerY) / elapsedMs;
			velocityX = velocityX * 0.35 + instantVelocityX * 0.65;
			velocityY = velocityY * 0.35 + instantVelocityY * 0.65;
		}
		lastPointerX = event.clientX;
		lastPointerY = event.clientY;
		lastPointerTime = event.timeStamp;
		lastPointerMoveAt = performance.now();
	};

	const handlePointerUp = (event: PointerEvent): void => {
		if (event.pointerId !== activePointerId) {
			settleInteraction(600);
			return;
		}
		activePointerId = undefined;
		if (performance.now() - lastPointerMoveAt <= 450) {
			startMomentum();
		} else {
			settleInteraction(250);
		}
	};
	const handlePointerCancel = (): void => {
		activePointerId = undefined;
		stopMomentum();
		settleInteraction(250);
	};
	const handleWheel = (): void => {
		stopMomentum();
		settleInteraction(900);
	};

	canvas.addEventListener("pointerdown", handlePointerDown);
	canvas.addEventListener("wheel", handleWheel, { passive: true });
	window.addEventListener("pointermove", handlePointerMove);
	window.addEventListener("pointerup", handlePointerUp);
	window.addEventListener("pointercancel", handlePointerCancel);
	window.addEventListener(
		"pagehide",
		function releaseCameraInteraction(event) {
			if (event.persisted) return;
			window.removeEventListener("pagehide", releaseCameraInteraction);
			window.clearTimeout(settleTimer);
			stopMomentum();
			cancelGlobeMomentum.delete(viewer);
			canvas.removeEventListener("pointerdown", handlePointerDown);
			canvas.removeEventListener("wheel", handleWheel);
			window.removeEventListener("pointermove", handlePointerMove);
			window.removeEventListener("pointerup", handlePointerUp);
			window.removeEventListener("pointercancel", handlePointerCancel);
		},
	);
}

function createViewer(): Viewer {
	const viewer = new Viewer("cesium-container", {
		animation: false,
		baseLayer: false,
		baseLayerPicker: false,
		ellipsoid: SPHERICAL_EARTH,
		fullscreenButton: false,
		geocoder: false,
		homeButton: false,
		infoBox: false,
		// Explicit Geographic (Plate Carree) projection for the native 2D scene the
		// Rectangle mode morphs into. It matches the SPHERICAL_EARTH ellipsoid, so
		// it never affects the 3D globe.
		mapProjection: new GeographicProjection(SPHERICAL_EARTH),
		mapMode2D: MapMode2D.ROTATE,
		navigationHelpButton: false,
		sceneModePicker: false,
		selectionIndicator: false,
		skyAtmosphere: false,
		skyBox: false,
		timeline: false,
		vrButton: false,
		requestRenderMode: true,
		maximumRenderTimeChange: Number.POSITIVE_INFINITY,
		shouldAnimate: false,
	});

	viewer.scene.backgroundColor = Color.fromCssColorString("#02090d");
	if (viewer.scene.sun) {
		viewer.scene.sun.show = false;
	}
	if (viewer.scene.moon) {
		viewer.scene.moon.show = false;
	}
	viewer.scene.fog.enabled = false;
	viewer.scene.highDynamicRange = false;
	viewer.scene.postProcessStages.fxaa.enabled = true;
	if (viewer.scene.globe) {
		viewer.scene.globe.baseColor = Color.fromCssColorString("#071b24");
		viewer.scene.globe.enableLighting = false;
		viewer.scene.globe.showGroundAtmosphere = false;
		viewer.scene.globe.showWaterEffect = false;
		viewer.scene.globe.depthTestAgainstTerrain = false;
		viewer.scene.globe.maximumScreenSpaceError = 1.5;
		viewer.scene.globe.tileCacheSize = 180;
	}
	viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;
	viewer.scene.screenSpaceCameraController.minimumZoomDistance =
		EARTH_RADIUS_METRES * 1.04;
	viewer.scene.screenSpaceCameraController.maximumZoomDistance =
		EARTH_RADIUS_METRES * 8;
	viewer.resolutionScale = Math.min(window.devicePixelRatio, 1.25);
	configureSmoothCameraInteraction(viewer);
	viewer.camera.lookAtTransform(Matrix4.IDENTITY);
	setCameraHome(viewer);
	return viewer;
}

async function fetchText(url: string): Promise<string> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`${url} 加载失败（HTTP ${response.status}）`);
	}
	return response.text();
}

function formatBytes(bytes: number | undefined): string {
	if (bytes === undefined) {
		return "—";
	}
	if (bytes < 1_024) {
		return `${bytes} B`;
	}
	if (bytes < 1_024 ** 2) {
		return `${(bytes / 1_024).toFixed(1)} KiB`;
	}
	return `${(bytes / 1_024 ** 2).toFixed(1)} MiB`;
}

function formatDuration(milliseconds: number | undefined): string {
	if (milliseconds === undefined) {
		return "—";
	}
	if (milliseconds >= 1_000) {
		return `${(milliseconds / 1_000).toFixed(2)} s`;
	}
	return `${milliseconds.toFixed(1)} ms`;
}

async function resolvePointDatasetUrl(
	datasetUrl: string,
	manifestUrl: string,
	manifestAccessToken?: string,
): Promise<string> {
	if (manifestAccessToken) {
		// Manifest assets store stable relative paths; the server exchanges them for
		// short-lived URLs so a published manifest never embeds an expiring link.
		const result = await SystemOpenAPIInvoker.GetManifestAssetURL(
			manifestAccessToken,
			datasetUrl,
		);
		if (result.Code !== 200 || result.Data === undefined) {
			throw new Error(
				`Asset URL exchange failed (${result.Code}): ${result.Message}`
		);
		}
		return result.Data;
	}
	const resolvedManifest = new URL(manifestUrl, document.baseURI);
	return new URL(datasetUrl, resolvedManifest).toString();
}

async function main(): Promise<void> {
	// The facade must exist before anything else so an automated caller can read
	// state and drive actions while the rest of the app is still booting.
	installAgentActions();
	const runtimeErrorDiagnostics = installRuntimeErrorDiagnostics(window, agentActions.diagnostics);
	const stateObserverCleanup: Array<() => void> = [];
	const registerStateSection = (section: string, provider: () => Record<string, unknown>): void => {
		stateObserverCleanup.push(agentActions.registerStateSection(section, provider));
	};
	const manifestAbort = new AbortController();
	const manifestStatus: Record<"points" | "atlas" | "raster", "loading" | "ready" | "error"> = {
		points: "loading", atlas: "loading", raster: "loading",
	};
	const reportManifestFailure = (resource: keyof typeof manifestStatus, error: unknown): void => {
		agentActions.diagnostics.record({
			level: "warn", category: "asset", event: `startup.${resource}-manifest-failed`, outcome: "failed", error,
		});
	};
	registerStateSection("startupResources", () => ({ manifests: { ...manifestStatus } }));
	window.addEventListener("pagehide", (event) => {
		if (event.persisted) return;
		manifestAbort.abort();
		runtimeErrorDiagnostics.dispose();
		stateObserverCleanup.splice(0).forEach(stop => stop());
		agentActions.disposeStateObservers();
	});
	createApp(AppShell).mount("#app");
	await nextTick();

	void bootstrapTimeMachinePlatform().catch((error) => {
		console.warn("TimeMachine platform capability handshake failed.", error);
		return undefined;
	});
	const phase1BInitialization = phase1BCloudClient
		.initialize()
		.catch((error) => {
			console.warn("TimeMachine Phase 1B initialization failed.", error);
			return phase1BCloudClient.snapshot;
		});
	const startupResources = await resolveStartupResources(phase1BCloudClient, phase1BInitialization);
	const { runtimeUrlOverrides } = startupResources;
	if ("runtimeUrlError" in startupResources) {
		const error = startupResources.runtimeUrlError;
		console.warn("Selected versioned resource could not be loaded.", error);
		window.dispatchEvent(new CustomEvent("timemachine:project-save-error", {
			detail: { message: error instanceof Error ? error.message : String(error) },
		}));
	}
	const DATA_URLS = {
		...DEFAULT_DATA_URLS,
		...runtimeUrlOverrides,
	};

	const loadingOverlay = requiredElement("#loading-overlay", HTMLDivElement);
	const loadingTitle = requiredElement("#loading-title", HTMLHeadingElement);
	const loadingDetail = requiredElement(
		"#loading-detail",
		HTMLParagraphElement,
	);
	const loadingProgress = requiredElement("#loading-progress", HTMLSpanElement);
	const ageValue = requiredElement("#age-value", HTMLElement);
	const eraLabel = requiredElement("#era-label", HTMLParagraphElement);
	const activePlates = requiredElement("#active-plates", HTMLElement);
	const activeFeatures = requiredElement("#active-features", HTMLElement);
	const meshStat = requiredElement("#mesh-stat", HTMLElement);
	const inspectorEmpty = requiredElement("#inspector-empty", HTMLDivElement);
	const inspectorContent = requiredElement(
		"#inspector-content",
		HTMLDivElement,
	);
	const selectedName = requiredElement("#selected-name", HTMLElement);
	const selectedId = requiredElement("#selected-id", HTMLElement);
	const selectedValidity = requiredElement("#selected-validity", HTMLElement);
	const selectedState = requiredElement("#selected-state", HTMLElement);
	const selectedQuaternion = requiredElement(
		"#selected-quaternion",
		HTMLElement,
	);
	const pointDatasetSelect = requiredElement(
		"#point-dataset-select",
		HTMLSelectElement,
	);
	const loadPointsButton = requiredElement("#load-points", HTMLButtonElement);
	const unloadPointsButton = requiredElement(
		"#unload-points",
		HTMLButtonElement,
	);
	const pointVisibility = requiredElement(
		"#point-visibility",
		HTMLInputElement,
	);
	const plateVisibility = requiredElement(
		"#plate-visibility",
		HTMLInputElement,
	);
	const pointSize = requiredElement("#point-size", HTMLInputElement);
	const pointSizeValue = requiredElement("#point-size-value", HTMLElement);
	const pointStateChip = requiredElement("#point-state-chip", HTMLElement);
	const pointStatus = requiredElement("#point-status", HTMLParagraphElement);
	const pointCount = requiredElement("#point-count", HTMLElement);
	const visiblePointCount = requiredElement(
		"#visible-point-count",
		HTMLElement,
	);
	const pointMemory = requiredElement("#point-memory", HTMLElement);
	const pointLoadTime = requiredElement("#point-load-time", HTMLElement);
	const pointFps = requiredElement("#point-fps", HTMLElement);
	const pointFrameP95 = requiredElement("#point-frame-p95", HTMLElement);
	const pointLatency = requiredElement("#point-latency", HTMLElement);
	const pointJsHeap = requiredElement("#point-js-heap", HTMLElement);
	const atlasVisibility = requiredElement(
		"#atlas-visibility",
		HTMLInputElement,
	);
	const atlasFrameValue = requiredElement("#atlas-frame-value", HTMLElement);
	const atlasStatus = requiredElement("#atlas-status", HTMLElement);
	const singleRasterSelect = requiredElement(
		"#single-raster-select",
		HTMLSelectElement,
	);
	const singleRasterVisibility = requiredElement(
		"#single-raster-visibility",
		HTMLInputElement,
	);
	const singleRasterOpacity = requiredElement(
		"#single-raster-opacity",
		HTMLInputElement,
	);
	const singleRasterOpacityValue = requiredElement(
		"#single-raster-opacity-value",
		HTMLElement,
	);
	const singleRasterState = requiredElement(
		"#single-raster-state",
		HTMLElement,
	);
	const singleRasterStatus = requiredElement(
		"#single-raster-status",
		HTMLParagraphElement,
	);
	const singleRasterLegend = requiredElement(
		"#single-raster-legend",
		HTMLDivElement,
	);
	const singleRasterColorbarName = requiredElement(
		"#single-raster-colorbar-name",
		HTMLElement,
	);
	const singleRasterColorbarUnit = requiredElement(
		"#single-raster-colorbar-unit",
		HTMLElement,
	);
	const singleRasterGradient = requiredElement(
		"#single-raster-gradient",
		HTMLElement,
	);
	const singleRasterMinimum = requiredElement(
		"#single-raster-minimum",
		HTMLElement,
	);
	const singleRasterMaximum = requiredElement(
		"#single-raster-maximum",
		HTMLElement,
	);
	const projectName = requiredElement("#project-name", HTMLInputElement);
	const playbackAgeMirror = requiredElement(
		"#playback-age-mirror",
		HTMLElement,
	);
	const timelineAgeMirror = requiredElement(
		"#timeline-age-mirror",
		HTMLElement,
	);

	const restoredProject = ProjectSession.restoreWithReport(window.localStorage);
	const restoredSession = restoredProject.status === "empty" ? new ProjectSession() : restoredProject.session;
	const projectTimeRange = { minAgeMa: 0, maxAgeMa: Math.max(538.8, restoredSession?.timeMa ?? 0) };
	let captureCurrentProject: (() => void) | undefined;
	let reviewedProject: { name: string; compatibility: ProjectStateDetail["compatibility"]; original: string } | undefined;
	let cloudSaveState: ProjectCloudSaveState = { status: restoredSession && !restoredSession.isReadOnly ? "idle" : "readonly" };
	const readProjectState = (): ProjectStateDetail => {
		const localSave = restoredSession?.localSaveState ?? { status: "readonly" as const, revision: 0 };
		return {
			timeRange: projectTimeRange,
			restoreStatus: restoredProject.status,
			compatibility: restoredSession?.compatibilityReport ?? restoredProject.compatibility,
			localSave,
			cloudSave: cloudSaveState.status === "saved" && cloudSaveState.revision !== localSave.revision
				? { ...cloudSaveState, status: "dirty" } : { ...cloudSaveState },
			originalAvailable: restoredProject.original !== undefined,
			...(reviewedProject ? { review: { name: reviewedProject.name, compatibility: reviewedProject.compatibility, originalAvailable: true } } : {}),
		};
	};
	const publishProjectState = (): void => {
		window.dispatchEvent(new CustomEvent(PROJECT_STATE_EVENT, { detail: readProjectState() }));
		agentActions.notifyStateChanged("project");
	};
	registerStateSection("project", () => ({
		...readProjectState(),
		schemaVersion: restoredSession?.compatibilityReport.schemaVersion ?? restoredProject.compatibility.schemaVersion,
		name: restoredSession?.projectName ?? null,
		currentTimeMa: restoredSession?.timeMa ?? null,
		groups: restoredSession?.groupList ?? [], layers: restoredSession?.layerList ?? [],
		camera: restoredSession?.cameraSnapshot ?? null,
	}));
	const localProjectActions = registerProjectLocalActions(restoredSession, {
		storage: window.localStorage,
		capture: () => {
			if (!captureCurrentProject) throw new AgentActionBusyError("Wait for the project view to finish initializing before saving.");
			captureCurrentProject();
		},
		publish: publishProjectState,
		original: restoredProject.original,
		reviewOriginal: () => reviewedProject?.original,
		downloadOriginal: original => {
			const url = URL.createObjectURL(new Blob([original], { type: "text/plain;charset=utf-8" }));
			const link = document.createElement("a");
			link.href = url; link.download = "timemachine-original.txt"; link.click();
			window.setTimeout(() => URL.revokeObjectURL(url), 0);
		},
	});
	projectName.value = restoredSession?.projectName ?? "Project requires review";
	publishProjectState();
	if (!restoredSession || restoredSession.isReadOnly) {
		projectName.readOnly = true;
		window.dispatchEvent(new CustomEvent(LAYER_STATE_EVENT, { detail: {
			groups: restoredSession?.groupList ?? [], layers: restoredSession?.layerList ?? [],
		} }));
		loadingOverlay.classList.add("is-complete");
		agentActions.diagnostics.record({ level: "error", category: "app", event: "project.restore-requires-review", outcome: "failed",
			errorCode: `PROJECT_${restoredProject.status.toUpperCase()}`, error: new Error("Project compatibility requires review before editing or rendering.") });
		return;
	}
	const projectSession = restoredSession;
	const initialAgeMa = projectSession.timeMa;
	atlasVisibility.checked =
		projectSession.getLayer(RUNTIME_LAYER_IDS.atlas)?.active ?? true;
	pointVisibility.checked =
		projectSession.getLayer(RUNTIME_LAYER_IDS.points)?.active ?? true;
	singleRasterVisibility.checked =
		projectSession.getLayer(RUNTIME_LAYER_IDS.raster)?.active ?? true;
	plateVisibility.checked =
		projectSession.getLayer(RUNTIME_LAYER_IDS.plateModel)?.active ?? true;
	const initialRasterOpacity =
		projectSession.getLayer(RUNTIME_LAYER_IDS.raster)?.alpha ?? 0.9;
	singleRasterOpacity.value = String(initialRasterOpacity);
	singleRasterOpacityValue.textContent = `${Math.round(initialRasterOpacity * 100)}%`;
	const initialPointStyle = projectSession.getLayer(
		RUNTIME_LAYER_IDS.points,
	)?.pointStyle;
	if (initialPointStyle) {
		pointSize.value = String(initialPointStyle.pointSize);
		pointSizeValue.textContent = `${initialPointStyle.pointSize.toFixed(1)} px`;
	}
	let nativePointRuntime: NativePointLayerRuntime | undefined;
	let isLayerRetrying = (_layerId: number): boolean => false;
	const nativePointSourceErrors = new Map<number, string>();
	const nativePointSourceLoads = new Map<number, { abort: AbortController; promise: Promise<void> }>();
	const nativeSelectionOwners = new Map<number, { sourceRef: string }>();
	let rasterManifest: SingleRasterManifest | undefined;
	const rasterControllers = new Map<number, SingleRasterLayerController>();
	const rasterStates = new Map<number, SingleRasterRuntimeState>();
	const rasterErrors = new Map<number, string>();
	const rasterLoads = new Map<number, { abort: AbortController; promise: Promise<void> }>();
	const rasterRemovals = new Map<number, Promise<void>>();
	const rasterSelectionGenerations = new Map<number, number>();
	const rasterSelectionOwners = new Map<number, { rasterId: string; generation: number; waiters: number; committed: boolean }>();
	const rasterRemovalRequested = new Set<number>();
	const rasterCleanupPending = new Set<number>();
	let atlasManifest: PaleoAtlasManifest | undefined;
	const atlasControllers = new Map<number, PaleoAtlasLayerController>();
	const atlasStates = new Map<number, PaleoAtlasRuntimeState>();
	const atlasErrors = new Map<number, string>();
	const atlasLoads = new Map<number, { abort: AbortController; promise: Promise<void> }>();
	const atlasRemovals = new Map<number, Promise<void>>();
	const atlasCleanupPending = new Set<number>();
	const atlasStateSummary = (id: number) => {
		const state = atlasStates.get(id);
		if (!state) return undefined;
		const brief = (frame?: { sourceId: string; timeMa: number; label: string }) => frame
			? { sourceId: frame.sourceId, timeMa: frame.timeMa, label: frame.label } : null;
		return { status: atlasErrors.has(id) ? "error" as const : state.status, requestedAgeMa: state.requestedAgeMa,
			frame: brief("frame" in state ? state.frame : undefined), committedFrame: brief(atlasControllers.get(id)?.getCommittedFrame()),
			...(state.status === "hidden" ? { reason: state.reason } : {}) };
	};
	const instanceRuntimeState = (id: number): Pick<LayerStateDetail["layers"][number], "runtimeStatus" | "runtimeError"> => {
		if ((Object.values(RUNTIME_LAYER_IDS) as number[]).includes(id) && id !== RUNTIME_LAYER_IDS.raster && id !== RUNTIME_LAYER_IDS.atlas) return {};
		if (projectSession.getLayer(id)?.type === ProjectLayerType.Atlas) {
			if (atlasRemovals.has(id)) return { runtimeStatus: "removing" };
			if (atlasErrors.has(id)) return { runtimeStatus: "error", runtimeError: atlasErrors.get(id)! };
			if (atlasLoads.has(id)) return { runtimeStatus: "loading" };
			const state = atlasStates.get(id);
			return { runtimeStatus: state?.status === "hidden" ? "ready" : state?.status ?? "unloaded",
				...(state?.status === "error" ? { runtimeError: state.message } : {}) };
		}
		if (projectSession.getLayer(id)?.type === ProjectLayerType.Raster) {
			if (rasterRemovals.has(id)) return { runtimeStatus: "removing" };
			if (rasterErrors.has(id)) return { runtimeStatus: "error", runtimeError: rasterErrors.get(id)! };
			if (rasterLoads.has(id)) return { runtimeStatus: "loading" };
			const state = rasterStates.get(id);
			return { runtimeStatus: state?.status === "hidden" ? "ready" : state?.status ?? "unloaded",
				...(state?.status === "error" ? { runtimeError: state.message } : {}) };
		}
		const native = nativePointRuntime?.get(id);
		if (native) return { runtimeStatus: native.runtimeStatus, ...(native.runtimeError ? { runtimeError: native.runtimeError } : {}) };
		if (nativePointSourceErrors.has(id)) return { runtimeStatus: "error", runtimeError: nativePointSourceErrors.get(id)! };
		return { runtimeStatus: nativePointSourceLoads.has(id) ? "loading" : "unloaded" };
	};
	const applyLayerState = (): void => {
		window.dispatchEvent(
			new CustomEvent(LAYER_STATE_EVENT, {
				detail: {
					groups: projectSession.groupList,
					layers: projectSession.layerList.map(layer => ({ ...layer, ...instanceRuntimeState(layer.id),
						...(layer.type === ProjectLayerType.Atlas ? { atlasState: atlasStateSummary(layer.id) } : {}) })),
					atlasSource: atlasManifest ? { sourceRef: PALEO_ATLAS_SOURCE, label: atlasManifest.label } : undefined,
					rasterOptions: rasterManifest?.rasters.map(raster => ({ id: raster.id, label: raster.label })),
					defaultRasterId: rasterManifest?.defaultRasterId,
				},
			}),
		);
	};
	applyLayerState();

	loadingProgress.style.width = "8%";
	const pointManifestPromise = requestStartupManifest<PointFixtureManifest>(
		DATA_URLS.pointManifest, manifestAbort.signal,
	);
	const atlasManifestPromise = requestStartupManifest<unknown>(
		DATA_URLS.atlasManifest, manifestAbort.signal,
	);
	const singleRasterManifestPromise = requestStartupManifest<unknown>(
		DATA_URLS.singleRasterManifest, manifestAbort.signal,
	);

	// ---------------------------------------------------------------------------
	// Plate model source.
	//
	// Three explicit sources and no implicit fallback between them: a shared
	// (V1) model that fails to load surfaces its own error, an unselected model
	// yields an empty but fully usable globe, and the local PALEOMAP demo is
	// reachable only after the user explicitly picks it in the Plate Model tab.
	// ---------------------------------------------------------------------------
	const plateModelStatus = requiredElement("#plate-model-status", HTMLElement);
	const sharedSelection = startupResources.selection;
	const serverUrl = startupResources.serverUrl;
	const sharedPlateClient = new SharedPlateModelClient(withRpcDiagnostics({
		baseUrl: serverUrl,
		getAccessToken: () =>
			window.sessionStorage.getItem(TIME_MACHINE_ACCESS_TOKEN_KEY),
	}));

	const plateModelSource: PlateModelSource =
		resolvePlateModelSource(sharedSelection);

	let gpmlParseResult: GpmlParseResult;
	let rotationParseResult: RotationParseResult;
	let loadedPlateModelLabel = "未选择板块模型";
	let plateModelLoadError = "";

	const setPlateModelStatus = (message: string, isError = false): void => {
		plateModelStatus.textContent = message;
		plateModelStatus.classList.toggle("is-error", isError);
	};
	const dispatchPlateModelError = (message: string): void => {
		window.dispatchEvent(
			new CustomEvent("timemachine:project-save-error", {
				detail: { message },
			}),
		);
	};

	if (plateModelSource.kind === "shared") {
		const { plateModelId } = plateModelSource;
		loadingTitle.textContent = "读取共享板块模型";
		loadingDetail.textContent = `正在从 Server 获取板块模型 #${plateModelId}…`;
		loadingProgress.style.width = "18%";
		if (!serverUrl) {
			plateModelLoadError =
				"未配置 Server 地址（VITE_TIMEMACHINE_SERVER_URL），无法读取共享板块模型。";
			gpmlParseResult = emptyGpmlResult();
			rotationParseResult = emptyRotationResult();
			setPlateModelStatus(`板块模型加载失败：${plateModelLoadError}`, true);
			dispatchPlateModelError(plateModelLoadError);
		} else {
			try {
				const detail = await sharedPlateClient.getDetail(plateModelId);
				const runtime = convertPlateModelContent(detail.Content);
				gpmlParseResult = runtime.gpmlParseResult;
				rotationParseResult = runtime.rotationParseResult;
				loadedPlateModelLabel = `${detail.Name || "(未命名)"} · Server #${plateModelId}`;
				setPlateModelStatus(
					`板块模型：${detail.Name || "(未命名)"}（Server ID ${plateModelId}，非本地数据）`,
				);
			} catch (error) {
				// A failed Server read must never fall back to the local files.
				plateModelLoadError =
					error instanceof Error ? error.message : String(error);
				gpmlParseResult = emptyGpmlResult();
				rotationParseResult = emptyRotationResult();
				setPlateModelStatus(`板块模型加载失败：${plateModelLoadError}`, true);
				dispatchPlateModelError(plateModelLoadError);
			}
		}
	} else if (plateModelSource.kind === "v2") {
		const { versionId } = plateModelSource;
		loadingTitle.textContent = "读取版本化板块模型";
		loadingDetail.textContent = `正在加载版本化板块模型 #${versionId}…`;
		loadingProgress.style.width = "18%";
		// The V2 manifest is the only source of these URLs. When it did not
		// supply them the version cannot be loaded, and there is no local
		// fallback for a versioned selection.
		if (!runtimeUrlOverrides.polygons || !runtimeUrlOverrides.rotations) {
			plateModelLoadError = `版本化板块模型 #${versionId} 的清单未提供 rotationModelUrl / platePolygonsUrl。`;
			gpmlParseResult = emptyGpmlResult();
			rotationParseResult = emptyRotationResult();
			setPlateModelStatus(`板块模型加载失败：${plateModelLoadError}`, true);
			dispatchPlateModelError(plateModelLoadError);
		} else {
			try {
				const [rotationText, gpmlText] = await Promise.all([
					fetchText(runtimeUrlOverrides.rotations),
					fetchText(runtimeUrlOverrides.polygons),
				]);
				gpmlParseResult = parseGpmlPlatePolygons(gpmlText);
				rotationParseResult = parsePlatesRotationFile(rotationText);
				loadedPlateModelLabel = `版本化板块模型 #${versionId}`;
				setPlateModelStatus(
					`板块模型：版本化板块模型 #${versionId}（Server 版本资源）`,
				);
			} catch (error) {
				plateModelLoadError =
					error instanceof Error ? error.message : String(error);
				gpmlParseResult = emptyGpmlResult();
				rotationParseResult = emptyRotationResult();
				setPlateModelStatus(`板块模型加载失败：${plateModelLoadError}`, true);
				dispatchPlateModelError(plateModelLoadError);
			}
		}
	} else if (plateModelSource.kind === "local-demo") {
		loadingDetail.textContent = "加载本地 PALEOMAP 演示数据…";
		const [rotationText, gpmlText] = await Promise.all([
			fetchText(DATA_URLS.rotations),
			fetchText(DATA_URLS.polygons),
		]);
		gpmlParseResult = parseGpmlPlatePolygons(gpmlText);
		rotationParseResult = parsePlatesRotationFile(rotationText);
		loadedPlateModelLabel = "本地 PALEOMAP 演示数据";
		setPlateModelStatus("板块模型：本地 PALEOMAP 演示数据（已显式选择）");
	} else {
		gpmlParseResult = emptyGpmlResult();
		rotationParseResult = emptyRotationResult();
		setPlateModelStatus(
			phase1BCloudClient.snapshot.account
				? "未选择板块模型：请在侧栏 Plate Model 中选择"
				: "未选择板块模型：请在侧栏 Plate Model 中选择或登录",
		);
	}

	loadingTitle.textContent = "构建重建树";
	loadingDetail.textContent = "解析旋转序列、参考板块交叉与 GPML 有效时间…";
	loadingProgress.style.width = "24%";
	await new Promise((resolve) => requestAnimationFrame(resolve));

	const rotationModel = new RotationModel(rotationParseResult.sequences);

	loadingTitle.textContent = "球面三角剖分";
	loadingDetail.textContent = "Cesium 正在生成板块网格…";
	loadingProgress.style.width = "36%";
	const viewer = createViewer();
	const startupFrameAbort = new AbortController();
	runtimeErrorDiagnostics.observeRenderErrors(viewer.scene, "main");
	const cameraResetCompletion = new CameraResetCompletion(viewer);
	const restoredCamera = projectSession.cameraSnapshot;
	if (restoredCamera) {
		viewer.camera.cancelFlight();
		viewer.camera.setView({
			destination: Cartesian3.fromArray([...restoredCamera.position]),
			orientation: {
				direction: Cartesian3.fromArray([...restoredCamera.direction]),
				up: Cartesian3.fromArray([...restoredCamera.up]),
			},
		});
	}
	const renderer = await PlateRenderer.create(
		viewer,
		gpmlParseResult.features,
		(completed, total) => {
			const progress = 36 + (completed / total) * 57;
			loadingProgress.style.width = `${progress}%`;
			loadingDetail.textContent = `正在剖分第 ${completed} / ${total} 个板块…`;
		},
	);

	const stats = renderer.buildStats;
	meshStat.textContent = `${stats.polygonCount.toLocaleString()} polygons · ${Math.round(
		stats.triangleCount,
	).toLocaleString()} triangles`;

	renderer.setPlateGeometryVisible(
		projectSession.getEffectiveLayerVisibility(RUNTIME_LAYER_IDS.plateModel),
	);
	renderer.setPlateGeometryOpacity(
		projectSession.getEffectiveLayerOpacity(RUNTIME_LAYER_IDS.plateModel),
	);
	let selectedFeature: PlateFeature | undefined;
	let selectedPointRecord: PointRecord | undefined;
	let selectedNativeAttributes: Record<string, unknown> | null | undefined;
	let selectedNativeKey: SelectionKey | undefined;
	let featureSelection: FeatureSelection | undefined;
	const plateFeaturesById = new Map<string, PlateFeature>();
	const ambiguousPlateFeatureIds = new Set<string>();
	for (const feature of gpmlParseResult.features) {
		if (plateFeaturesById.has(feature.id)) ambiguousPlateFeatureIds.add(feature.id);
		else plateFeaturesById.set(feature.id, feature);
	}
	let currentTimeState: RenderTimeState = renderer.updateTime(
		initialAgeMa,
		rotationModel,
	);
	let pointRenderer: GpuPointRenderer | undefined;
	let pointPicker: PointPicker | undefined;
	let invalidateActiveTimeLayers: (() => void) | undefined;
	let appliedGlobeTimeMa = initialAgeMa;
	type PointResources = { renderer?: GpuPointRenderer; picker?: PointPicker };
	type PointReleaseResources = { renderer?: { destroy(): void }; picker?: { destroy(): void } };
	// Only failed releases remain here. New loads are blocked until unload
	// retries them, so a failed retirement cannot lose an owned GPU handle.
	const pointResourcesToRelease = new Set<PointReleaseResources>();
	function hasPendingPointRelease(): boolean {
		return pointResourcesToRelease.size > 0;
	}
	let loadedPointDataset: LoadedPointDataset | undefined;
	let loadedPointEntry: PointDatasetManifestEntry | undefined;
	let pointLoadGeneration = 0;
	let pointLoadAbortController: AbortController | undefined;
	let rollbackPointLoad: (() => void) | undefined;
	let pointLoadInFlight = false;
	let pointPickGeneration = 0;
	let pointDisposed = false;
	function cancelPointLoad(reason: "cancelled" | "superseded" = "cancelled"): void {
		featureSelection?.invalidatePending();
		invalidateActiveTimeLayers?.();
		// Restore synchronously before handing ownership to unload or a new
		// selection. A stale async catch must never reinstall its old instance.
		rollbackPointLoad?.();
		rollbackPointLoad = undefined;
		pointLoadGeneration += 1;
		pointPickGeneration += 1;
		pointLoadInFlight = false;
		const active = pointLoadAbortController;
		pointLoadAbortController = undefined;
		active?.abort(new OperationInterruptedError(reason));
		if (active && !pointDisposed) {
			loadPointsButton.disabled = false;
			pointDatasetSelect.disabled = false;
			unloadPointsButton.disabled = !loadedPointEntry && !hasPendingPointRelease();
			setPointPanelState("ready", "已取消", "点数据加载已取消，可重新选择并加载。");
		}
	}
	let atlasController: PaleoAtlasLayerController | undefined;
	let atlasRuntimeState: PaleoAtlasRuntimeState | undefined;
	let atlasInitializationError = "";
	let singleRasterController: SingleRasterLayerController | undefined;
	let singleRasterRuntimeState: SingleRasterRuntimeState | undefined;
	let singleRasterInitializationError = "";
	const pendingLayerAttachments = new Set<() => void>();
	const optionalLayerBoundary = {
		isPreparing: () => projectionController?.getSnapshot().status === "preparing",
		onSettled: (listener: () => void) => {
			pendingLayerAttachments.add(listener);
			return () => { pendingLayerAttachments.delete(listener); };
		},
		signal: manifestAbort.signal,
	};
	const attachPendingLayers = (): void => {
		for (const attach of [...pendingLayerAttachments]) attach();
	};
	const performanceMonitor = new PerformanceMonitor(viewer);

	const applyImageryOrder = (): void => {
		for (const layer of [...projectSession.layerList].reverse()) {
			if (layer.type === ProjectLayerType.Atlas) {
				atlasControllers.get(layer.id)?.raiseToTop();
			} else if (layer.type === ProjectLayerType.Raster) {
				rasterControllers.get(layer.id)?.raiseToTop();
			}
		}
		viewer.scene.requestRender();
	};

	const updateAtlasState = (state: PaleoAtlasRuntimeState): void => {
		atlasRuntimeState = state;
		atlasStatus.dataset.state = state.status;
		if (state.status === "loading") {
			atlasFrameValue.textContent = `${state.frame.timeMa} Ma`;
			atlasStatus.textContent = `正在加载 ${state.frame.label}…`;
		} else if (state.status === "ready") {
			atlasFrameValue.textContent = `${state.frame.timeMa} Ma`;
			const offset = Math.abs(state.requestedAgeMa - state.frame.timeMa);
			atlasStatus.textContent =
				offset < 0.05
					? `${state.frame.label} · Martin raster tiles`
					: `邻近帧 · ${state.frame.label}`;
		} else if (state.status === "error") {
			atlasFrameValue.textContent = state.frame ? `${state.frame.timeMa} Ma` : "—";
			atlasStatus.textContent = `图集瓦片不可用：${state.message}`;
		} else {
			atlasFrameValue.textContent = "—";
			atlasStatus.textContent =
				state.reason === "disabled"
					? "古地理图集已关闭"
					: "该时间超出图集 0–750 Ma 范围";
		}
		applyImageryOrder();
		agentActions.notifyStateChanged("atlas");
	};

	const initializeAtlas = async (): Promise<void> => {
		try {
			const result = await atlasManifestPromise;
			if (manifestAbort.signal.aborted) return;
			if (!result.ok) throw result.error;
			const parsed = parsePaleoAtlasManifest(result.value);
			await attachOptionalLayer(optionalLayerBoundary, () => {
				atlasManifest = parsed;
				const restoringLayers = projectSession.layerList.filter(layer => layer.type === ProjectLayerType.Atlas);
				atlasVisibility.disabled = false;
				manifestStatus.atlas = "ready";
				publishAtlasState();
				for (const layer of restoringLayers) {
					if (projectSession.getLayer(layer.id)?.sourceRef !== layer.sourceRef) continue;
					void loadAtlasInstance(layer.id, layer.sourceRef).catch(() => undefined);
				}
			});
		} catch (error) {
			if (manifestAbort.signal.aborted) return;
			manifestStatus.atlas = "error";
			reportManifestFailure("atlas", error);
			atlasVisibility.checked = false;
			atlasVisibility.disabled = true;
			atlasFrameValue.textContent = "—";
			atlasStatus.dataset.state = "error";
			atlasInitializationError = error instanceof Error ? error.message : String(error);
			atlasStatus.textContent = atlasInitializationError;
		} finally {
			if (!manifestAbort.signal.aborted) {
				agentActions.notifyStateChanged("startupResources");
				agentActions.notifyStateChanged("atlas");
			}
		}
	};

	const formatRasterValue = (value: number, units: string): string => {
		const formatted =
			Math.abs(value) >= 1_000
				? Math.round(value).toLocaleString()
				: Number.isInteger(value)
					? value.toFixed(0)
					: value.toFixed(1);
		return units ? `${formatted} ${units}` : formatted;
	};

	const updateSingleRasterLegend = (raster: SingleRasterEntry): void => {
		const colorbar = raster.colorbar;
		if (!colorbar) {
			singleRasterLegend.hidden = true;
			return;
		}
		singleRasterLegend.hidden = false;
		singleRasterColorbarName.textContent = colorbar.label;
		singleRasterColorbarUnit.textContent = colorbar.units;
		singleRasterGradient.style.background = `linear-gradient(90deg, ${colorbar.stops
			.map((stop) => `${stop.color} ${(stop.offset * 100).toFixed(2)}%`)
			.join(", ")})`;
		singleRasterMinimum.textContent = formatRasterValue(
			colorbar.minimum,
			colorbar.units,
		);
		singleRasterMaximum.textContent = formatRasterValue(
			colorbar.maximum,
			colorbar.units,
		);
	};

	const updateSingleRasterState = (state: SingleRasterRuntimeState): void => {
		singleRasterRuntimeState = state;
		const retainCommittedLegend = (): void => {
			const committed = singleRasterController?.getCommittedRaster();
			if (committed) updateSingleRasterLegend(committed);
			else singleRasterLegend.hidden = true;
		};
		singleRasterStatus.dataset.state = state.status;
		singleRasterStatus.dataset.rasterId = state.raster?.id ?? "";
		singleRasterState.dataset.state = state.status;
		if (state.status === "loading") {
			singleRasterState.textContent = "加载中";
			singleRasterStatus.textContent = `正在加载 ${state.raster.label}…`;
			retainCommittedLegend();
		} else if (state.status === "ready") {
			singleRasterState.textContent = "已显示";
			singleRasterStatus.textContent = `${state.raster.sourceFile} · Martin PNG tiles`;
			updateSingleRasterLegend(state.raster);
		} else if (state.status === "hidden") {
			singleRasterState.textContent = "已隐藏";
			singleRasterStatus.textContent = "栅格图层已关闭";
			singleRasterLegend.hidden = true;
		} else {
			singleRasterState.textContent = "失败";
			singleRasterStatus.textContent = `${state.raster.label}：${state.message}`;
			retainCommittedLegend();
		}
		applyImageryOrder();
		agentActions.notifyStateChanged("raster");
	};

	const initializeSingleRaster = async (): Promise<void> => {
		try {
			const result = await singleRasterManifestPromise;
			if (manifestAbort.signal.aborted) return;
			if (!result.ok) throw result.error;
			const singleRasterManifest = parseSingleRasterManifest(result.value);
			await attachOptionalLayer(optionalLayerBoundary, () => {
				const restoringLayers = projectSession.layerList.filter(layer => layer.type === ProjectLayerType.Raster);
				singleRasterSelect.replaceChildren(
					...singleRasterManifest.rasters.map((raster) => {
						const option = document.createElement("option");
						option.value = raster.id;
						option.textContent = raster.label;
						return option;
					}),
				);
				rasterManifest = singleRasterManifest;
				// Invalid restored IDs must not visually fall back to the first option.
				singleRasterSelect.value = "";
				singleRasterSelect.disabled = false;
				singleRasterVisibility.disabled = false;
				singleRasterOpacity.disabled = false;
				manifestStatus.raster = "ready";
				publishRasterState();
				for (const layer of restoringLayers) {
					if (projectSession.getLayer(layer.id)?.sourceRef !== layer.sourceRef) continue;
					void loadRasterInstance(layer.id, layer.sourceRef).catch(() => undefined);
				}
			});
		} catch (error) {
			if (manifestAbort.signal.aborted) return;
			manifestStatus.raster = "error";
			reportManifestFailure("raster", error);
			singleRasterVisibility.checked = false;
			singleRasterSelect.disabled = true;
			singleRasterVisibility.disabled = true;
			singleRasterOpacity.disabled = true;
			singleRasterState.dataset.state = "error";
			singleRasterState.textContent = "数据缺失";
			singleRasterStatus.dataset.state = "error";
			singleRasterInitializationError = error instanceof Error ? error.message : "Raster manifest could not be loaded.";
			singleRasterStatus.textContent = singleRasterInitializationError;
		} finally {
			if (!manifestAbort.signal.aborted) {
				agentActions.notifyStateChanged("startupResources");
				agentActions.notifyStateChanged("raster");
			}
		}
	};

	const setPointPanelState = (
		state: "ready" | "busy" | "error",
		label: string,
		message: string,
	): void => {
		pointStateChip.dataset.state = state;
		pointStateChip.textContent = label;
		pointStatus.dataset.state = state;
		pointStatus.textContent = message;
		agentActions.notifyStateChanged("points");
	};

	const updateVisiblePointCount = (ageMa: number): void => {
		if (!loadedPointEntry) {
			visiblePointCount.textContent = "—";
			return;
		}
		const index = Math.min(
			loadedPointEntry.activeCountsByIntegerMa.length - 1,
			Math.max(0, Math.round(ageMa)),
		);
		const activeCount = loadedPointEntry.activeCountsByIntegerMa[index];
		visiblePointCount.textContent =
			activeCount === undefined ? "—" : activeCount.toLocaleString();
	};

	const updateInspector = (): void => {
		if (selectedNativeKey) {
			inspectorEmpty.hidden = true;
			inspectorContent.hidden = false;
			const summary = summarizeFeatureAttributes(selectedNativeAttributes ?? null);
			const name = summary.attributes?.name;
			selectedName.textContent = typeof name === "string" ? name : selectedNativeKey.featureId;
			selectedId.textContent = `Layer ${selectedNativeKey.layerId} · ${selectedNativeKey.featureId}`;
			selectedValidity.textContent = "Source coordinates · not reconstructed";
			selectedState.textContent = summary.attributes === null ? "No source attributes" : "Source attribute preview";
			selectedQuaternion.textContent = Object.entries(summary.attributes ?? {}).slice(0, 6)
				.map(([key, value]) => `${key}: ${String(typeof value === "string" ? value : JSON.stringify(value)).slice(0, 160)}`).join("\n");
			return;
		}
		if (selectedPointRecord) {
			const record = selectedPointRecord;
			inspectorEmpty.hidden = true;
			inspectorContent.hidden = false;
			selectedName.textContent = `PBDB row ${record.rowId.toLocaleString()}`;
			selectedId.textContent = `Plate ID ${record.plateId}`;
			selectedValidity.textContent = `${record.validFromMa} → ${record.validToMa} Ma`;
			const currentAgeMa = projectionController?.getSnapshot().committedTimeMa ?? initialAgeMa;
			const visible =
				currentAgeMa <= record.validFromMa && currentAgeMa >= record.validToMa;
			selectedState.textContent = `${visible ? "Visible" : "Outside valid time"} · ${record.occurrenceCount.toLocaleString()} occurrences`;
			const [x, y, z] = record.unitPosition;
			const longitude = Math.atan2(y, x) * (180 / Math.PI);
			const latitude = Math.atan2(z, Math.hypot(x, y)) * (180 / Math.PI);
			selectedQuaternion.textContent = `${longitude.toFixed(2)}°, ${latitude.toFixed(2)}° · row ID ${record.rowId}`;
			return;
		}
		if (!selectedFeature) {
			inspectorContent.hidden = true;
			inspectorEmpty.hidden = false;
			for (const field of [selectedName, selectedId, selectedValidity, selectedState, selectedQuaternion]) field.textContent = "—";
			return;
		}
		inspectorEmpty.hidden = true;
		inspectorContent.hidden = false;
		selectedName.textContent = selectedFeature.name;
		selectedId.textContent = `ID ${selectedFeature.plateId}`;
		selectedValidity.textContent = `${formatTimeBoundary(
			selectedFeature.validFromMa,
		)} → ${formatTimeBoundary(selectedFeature.validToMa)}`;
		const valid = isFeatureValidAtTime(
			selectedFeature,
			projectionController?.getSnapshot().committedTimeMa ?? initialAgeMa,
		);
		const rotation = currentTimeState.rotationMap.get(selectedFeature.plateId);
		selectedState.textContent = valid
			? rotation
				? "有效 · 已重建"
				: "有效 · 旋转链断开"
			: "当前时间不可见";
		selectedQuaternion.textContent = formatQuaternion(rotation);
	};

	function assertSelectionViewport(viewportId: string): void {
		if (viewportId !== "main") throw new AgentActionValidationError("Unknown viewport.");
		if (pointDisposed || viewer.scene.isDestroyed()) throw new AgentActionBusyError("The viewport is being disposed.");
	}
	function readSelectionFeature(key: SelectionKey): SelectionFeature {
		assertSelectionViewport(key.viewportId);
		const layer = projectSession.getLayer(key.layerId);
		if (!layer) throw new AgentActionValidationError("Unknown feature layer.");
		const frame = projectionController?.getSnapshot();
		const timeMa = frame?.committedTimeMa ?? initialAgeMa;
		const committedRotations = rotationModel.getRotationMap(timeMa, 0);
		const visible = projectSession.getEffectiveLayerVisibility(key.layerId) && projectSession.getEffectiveLayerOpacity(key.layerId) > 0;
		if (key.layerId === RUNTIME_LAYER_IDS.plateModel) {
			if (ambiguousPlateFeatureIds.has(key.featureId)) throw new AgentActionUnsupportedError("This source has ambiguous feature IDs.");
			const feature = plateFeaturesById.get(key.featureId);
			if (!feature) throw new AgentActionValidationError("Unknown plate feature.");
			return { owner: renderer, sourceRef: loadedPlateSourceRef, attributes: projectPlateFeatureAttributes(feature),
				selectable: visible && isFeatureValidAtTime(feature, timeMa) && committedRotations.has(feature.plateId) };
		}
		if (key.layerId === RUNTIME_LAYER_IDS.points) {
			if (!loadedPointDataset || !pointRenderer || hasPendingPointRelease()) throw new AgentActionBusyError("The point source is not ready.");
			const attributes = readPointFeatureAttributes(loadedPointDataset, key.featureId);
			const style = projectSession.getLayer(key.layerId)?.pointStyle;
			return { owner: loadedPointDataset, sourceRef: `wgp1:${encodeURIComponent(loadedPointDataset.datasetId)}`, attributes,
				selectable: visible && frame?.committedId === "globe" && !!style &&
					timeMa <= attributes.validFromMa && timeMa >= attributes.validToMa &&
					(style.filter.plateId === null || style.filter.plateId === attributes.plateId) &&
					attributes.occurrenceCount >= style.filter.minimumOccurrence && attributes.occurrenceCount <= style.filter.maximumOccurrence &&
					committedRotations.has(attributes.plateId) };
		}
		if (![ProjectLayerType.Point, ProjectLayerType.Line, ProjectLayerType.Polygon].includes(layer.type)) {
			throw new AgentActionUnsupportedError("This layer does not expose vector feature attributes.");
		}
		const owner = nativeSelectionOwners.get(key.layerId);
		if (!owner || nativePointRuntime?.get(key.layerId)?.runtimeStatus !== "ready") throw new AgentActionBusyError("The vector source is not ready.");
		const attributes = nativePointRuntime.getAttributes(key.layerId, key.featureId);
		if (attributes === undefined) throw new AgentActionValidationError("Unknown vector feature.");
		return { owner, sourceRef: owner.sourceRef, attributes, selectable: visible && frame?.committedId === "globe" };
	}
	function reconcileFeatureSelection(): void {
		featureSelection?.invalidatePending();
		featureSelection?.reconcile(key => {
			try { const feature = readSelectionFeature(key); return feature.selectable ? feature.owner : undefined; }
			catch { return undefined; }
		});
	}
	featureSelection = new FeatureSelection(snapshot => {
		selectedFeature = undefined; selectedPointRecord = undefined;
		selectedNativeKey = undefined; selectedNativeAttributes = undefined;
		if (snapshot.key) {
			const key = snapshot.key;
			if (key.layerId === RUNTIME_LAYER_IDS.plateModel) selectedFeature = plateFeaturesById.get(key.featureId);
			else if (key.layerId === RUNTIME_LAYER_IDS.points && loadedPointDataset) selectedPointRecord = readPointRecord(loadedPointDataset.buffer, parsePointFeatureId(key.featureId, loadedPointDataset));
			else { selectedNativeKey = key; selectedNativeAttributes = nativePointRuntime?.getAttributes(key.layerId, key.featureId); }
		}
		updateInspector();
		agentActions.diagnostics.record({ level: "info", category: "app", event: `selection.${snapshot.source}.changed`, outcome: "completed" },
			{ viewportId: snapshot.key?.viewportId ?? "main", layerId: snapshot.key?.layerId, featureId: snapshot.key?.featureId });
		agentActions.notifyStateChanged("selection");
	});
	const selectionPorts = { assertViewport: assertSelectionViewport, readFeature: readSelectionFeature };
	requiredElement("#clear-feature-selection", HTMLButtonElement).addEventListener("click", () => {
		try { clearFeatureSelection(featureSelection!, selectionPorts, "main", "ui"); }
		catch (error) { agentActions.diagnostics.record({ level: "warn", category: "app", event: "selection.clear-failed", outcome: "failed", error }); }
	});
	renderer.setPickCallback((pick: PlatePick) => {
		const key = { viewportId: "main", layerId: RUNTIME_LAYER_IDS.plateModel, featureId: pick.feature.id };
		try { selectFeature(featureSelection!, selectionPorts, key, "ui"); }
		catch (error) { agentActions.diagnostics.record({ level: "warn", category: "app", event: "selection.pick-failed", outcome: "failed", error }); }
	});

	let projectionController: ProjectionController | undefined;
	let timelineFrame: Promise<void> = Promise.resolve();
	const timeline = new GeologicalTimeline(
		{
			slider: requiredElement("#timeline-slider", HTMLInputElement),
			needle: requiredElement("#timeline-needle", HTMLDivElement),
			ticks: requiredElement("#timeline-ticks", HTMLDivElement),
			playButton: requiredElement("#play-button", HTMLButtonElement),
			speedButton: requiredElement("#speed-button", HTMLButtonElement),
			todayButton: requiredElement("#today-button", HTMLButtonElement),
			quickAgeButtons:
				document.querySelectorAll<HTMLButtonElement>("[data-age]"),
		},
		{
			minAgeMa: 0,
			maxAgeMa: projectTimeRange.maxAgeMa,
			initialAgeMa,
			reverse: true,
			onStateChange: () => agentActions.notifyStateChanged("time"),
			onChange: (ageMa, signal) => {
				performanceMonitor.markInteraction();
				// The active request prepares every participating layer before displaying
				// its age. Pending inputs must not independently switch the Atlas.
				if (projectionController) {
					timelineFrame = projectionController.setTime(ageMa, { signal });
					void timelineFrame.catch(() => {
						// A superseded or failed time change keeps the committed view; the
						// projection status line already reports it.
					});
				}
				const ageLabel = ageMa.toFixed(1);
				ageValue.textContent = ageLabel;
				playbackAgeMirror.textContent = ageLabel;
				timelineAgeMirror.textContent = ageLabel;
				eraLabel.textContent = eraForAge(ageMa);
				projectSession.setTime(ageMa);
				publishProjectState();
				updateVisiblePointCount(projectionController?.getSnapshot().committedTimeMa ?? initialAgeMa);
				updateInspector();
				agentActions.notifyStateChanged("time");
			},
		},
	);

	// -----------------------------------------------------------------------
	// Projection runtime. One controller decides which projection is shown and
	// owns the latest-request-wins policy for both the UI select and the
	// `projection.select` / `time.set` agent actions. Globe keeps its fast path;
	// Rectangle stages a CPU frame, warms it on the GPU and commits only a
	// verified frame. Mollweide has no runtime and answers unsupported.
	// -----------------------------------------------------------------------
	const PROJECTION_INCOMPATIBLE_LAYER_IDS = [
		RUNTIME_LAYER_IDS.atlas,
		RUNTIME_LAYER_IDS.points,
		RUNTIME_LAYER_IDS.raster,
	];
	const describeProjectionLayer = (layerId: number): string => {
		switch (layerId) {
			case RUNTIME_LAYER_IDS.atlas:
				return "Paleogeographic atlas";
			case RUNTIME_LAYER_IDS.points:
				return "PBDB points";
			case RUNTIME_LAYER_IDS.raster:
				return "Single raster";
			default:
				return `layer ${layerId}`;
		}
	};
	const projectionModeLabel = (mode: ProjectionModeId): string => {
		switch (mode) {
			case "rectangle":
				return "Rectangle";
			case "mollweide":
				return "Mollweide";
			default:
				return "Globe";
		}
	};
	const projectionSelect = requiredElement(
		"#projection-select",
		HTMLSelectElement,
	);
	const projectionStatus = requiredElement(
		"#projection-status",
		HTMLParagraphElement,
	);
	let savedGlobeCamera:
		| { position: number[]; direction: number[]; up: number[] }
		| undefined;

	/**
	 * When Rectangle is unavailable the option's tooltip alone leaves the user
	 * without feedback, so the status line also states the blocking layers and
	 * the fix. Preparing/error lines keep their own actionable text, and once the
	 * blocking layers are hidden the note disappears by itself.
	 */
	const projectionUnavailableNote = (snapshot: ProjectionSnapshot): string => {
		if (snapshot.status === "preparing" || snapshot.status === "error") {
			return "";
		}
		const rectangleMode = snapshot.availableModes.find(
			(mode) => mode.projectionId === "rectangle",
		);
		if (!rectangleMode || rectangleMode.available) {
			return "";
		}
		const reason = rectangleMode.reason ?? "Incompatible visible layers.";
		return ` · Rectangle unavailable: ${reason} Only the plate model is supported; turn those layers off.`;
	};

	const projectionStatusText = (snapshot: ProjectionSnapshot): string => {
		const committedLabel = projectionModeLabel(snapshot.committedId);
		if (
			snapshot.status === "preparing" &&
			snapshot.requestedId !== snapshot.committedId
		) {
			return `Switching to ${projectionModeLabel(
				snapshot.requestedId,
			)}… Current: ${committedLabel}`;
		}
		if (snapshot.status === "error" && snapshot.lastError) {
			return `${committedLabel} · ${snapshot.lastError.message}`;
		}
		const committedTime = `${snapshot.committedTimeMa.toFixed(1)} Ma`;
		const unavailableNote = projectionUnavailableNote(snapshot);
		if (Math.abs(snapshot.requestedTimeMa - snapshot.committedTimeMa) > 0.05) {
			return `${committedLabel} · ${committedTime} (→ ${snapshot.requestedTimeMa.toFixed(
				1,
			)} Ma)${unavailableNote}`;
		}
		return `${committedLabel} · ${committedTime}${unavailableNote}`;
	};

	const applyProjectionStateToUI = (snapshot: ProjectionSnapshot): void => {
		reconcileFeatureSelection();
		projectionSelect.disabled = false;
		projectionSelect.value =
			snapshot.status === "preparing"
				? snapshot.requestedId
				: snapshot.committedId;
		for (const mode of snapshot.availableModes) {
			const option = projectionSelect.querySelector<HTMLOptionElement>(`option[value="${mode.projectionId}"]`);
			if (option) { option.disabled = !mode.available; option.title = mode.reason ?? ""; }
		}
		projectionStatus.dataset.state = snapshot.status;
		projectionStatus.textContent = projectionStatusText(snapshot);
		activePlates.textContent =
			snapshot.committedTimeState.activePlateCount.toLocaleString();
		activeFeatures.textContent =
			snapshot.committedTimeState.activeFeatureCount.toLocaleString();
		if (snapshot.status !== "preparing") attachPendingLayers();
		agentActions.notifyStateChanged("projection");
	};

	// The inspector and point picker read `currentTimeState`. In globe the
	// synchronous updateTime supplies it; in rectangle it must be rebuilt from the
	// *committed* age's rotation map and the committed frame's connectivity, so a
	// selected feature never shows a stale quaternion from an older age.
	const refreshRectangleTimeState = (): void => {
		const snapshot = projectionController?.getSnapshot();
		if (!snapshot) {
			return;
		}
		const ageMa = snapshot.committedTimeMa;
		currentTimeState = {
			activeFeatureCount: snapshot.committedTimeState.activeFeatureCount,
			activePlateCount: snapshot.committedTimeState.activePlateCount,
			disconnectedFeatureCount: snapshot.committedTimeState.disconnectedFeatureCount,
			rotationMap: rotationModel.getRotationMap(ageMa, 0),
		};
	};

	projectionController = new ProjectionController({
		viewer,
		plateRenderer: renderer,
		rotationModel,
		get incompatibleLayerIds() {
			// Until their P3 projection paths are integrated, new native instances
			// obey the same honest capability guard as the existing data layers.
			return projectSession.layerList.filter(layer => layer.id !== RUNTIME_LAYER_IDS.plateModel).map(layer => layer.id);
		},
		getCurrentTimeMa: () => timeline.currentAgeMa,
		isLayerVisible: (layerId) =>
			projectSession.getEffectiveLayerVisibility(layerId),
		describeLayer: describeProjectionLayer,
		onCommittedTimeChange: () => {
			// The accepted frame has released its layer owner. Install late optional
			// resources now, before the next queued time captures its participants.
			attachPendingLayers();
			// In rectangle, refresh the committed-age rotation map so the inspector
			// reflects the frame actually shown; in globe applyGlobeFrame already did.
			if (projectionController?.activeMode !== "globe") {
				refreshRectangleTimeState();
			}
			updateVisiblePointCount(projectionController?.getSnapshot().committedTimeMa ?? initialAgeMa);
			updateInspector();
		},
		onStateChange: applyProjectionStateToUI,
		setGlobeInertiaEnabled: (enabled) => {
			globeSpinInertiaEnabled = enabled;
			if (!enabled) {
				cameraResetCompletion.cancel("superseded");
				cancelGlobeMomentum.get(viewer)?.();
			}
		},
		captureGlobeCamera: () => {
			savedGlobeCamera = {
				position: [
					viewer.camera.positionWC.x,
					viewer.camera.positionWC.y,
					viewer.camera.positionWC.z,
				],
				direction: [
					viewer.camera.directionWC.x,
					viewer.camera.directionWC.y,
					viewer.camera.directionWC.z,
				],
				up: [
					viewer.camera.upWC.x,
					viewer.camera.upWC.y,
					viewer.camera.upWC.z,
				],
			};
		},
		restoreGlobeCamera: () => {
			if (!savedGlobeCamera) {
				setCameraHome(viewer);
				return;
			}
			viewer.camera.setView({
				destination: Cartesian3.fromArray(savedGlobeCamera.position),
				orientation: {
					direction: Cartesian3.fromArray(savedGlobeCamera.direction),
					up: Cartesian3.fromArray(savedGlobeCamera.up),
				},
			});
		},
		applyGlobeFrame: (timeMa) => {
			currentTimeState = renderer.updateTime(timeMa, rotationModel);
			appliedGlobeTimeMa = timeMa;
			return {
				activeFeatureCount: currentTimeState.activeFeatureCount,
				activePlateCount: currentTimeState.activePlateCount,
				disconnectedFeatureCount: currentTimeState.disconnectedFeatureCount,
			};
		},
		captureTimeLayers: (context) => {
			// Flat modes still exclude these visible layers. Their support is P3 work.
			if (context.mode !== "globe") return {
				ready: Promise.resolve(), activate() {}, canConfirm: () => true,
				accept() {}, rollback() {}, retire() {},
			};
			const visibility = PROJECTION_INCOMPATIBLE_LAYER_IDS.map(id => projectSession.getEffectiveLayerVisibility(id));
			if (visibility[1] && pointLoadInFlight) throw new AgentActionBusyError("Wait for the point dataset to finish loading before changing time.");
			if (visibility[1] && hasPendingPointRelease()) throw new AgentActionBusyError("Retry point unloading before changing time.");
			const capturedPoint = pointRenderer;
			const capturedPointGeneration = pointLoadGeneration;
			if (projectSession.layerList.some(layer => isLayerRetrying(layer.id))) throw new AgentActionBusyError("Wait for layer retry to finish before changing time.");
			if (atlasRemovals.size || atlasCleanupPending.size) throw new AgentActionBusyError("Finish Atlas cleanup before changing time.");
			for (const layer of projectSession.layerList) {
				if (layer.type !== ProjectLayerType.Atlas || !projectSession.getEffectiveLayerVisibility(layer.id)) continue;
				if (layer.id === RUNTIME_LAYER_IDS.atlas && manifestStatus.atlas !== "ready") continue;
				if (!atlasControllers.has(layer.id) || atlasErrors.has(layer.id)) {
					throw new AgentActionUnsupportedError(`Visible Atlas layer ${layer.id} is unavailable. Retry its load or hide it before changing time.`);
				}
			}
			const capturedAtlases = [...atlasControllers].map(([id, controller]) => ({
				id, controller, visible: projectSession.getEffectiveLayerVisibility(id), sourceRef: projectSession.getLayer(id)?.sourceRef,
			}));
			if (rasterRemovals.size || rasterCleanupPending.size) throw new AgentActionBusyError("Finish raster cleanup before changing time.");
			for (const layer of projectSession.layerList) {
				if (layer.type !== ProjectLayerType.Raster || !projectSession.getEffectiveLayerVisibility(layer.id)) continue;
				// The built-in raster manifest is optional for the core view. Its
				// failure stays explicit, without locking plate/time interaction.
				if (layer.id === RUNTIME_LAYER_IDS.raster && manifestStatus.raster !== "ready") continue;
				if (!rasterControllers.has(layer.id) || rasterErrors.has(layer.id) || rasterStates.get(layer.id)?.status === "error") {
					throw new AgentActionUnsupportedError(`Visible Raster layer ${layer.id} is unavailable. Retry its load or hide it before changing time.`);
				}
			}
			const capturedRasters = [...rasterControllers].map(([id, controller]) => ({
				id, controller, visible: projectSession.getEffectiveLayerVisibility(id), rasterId: rasterStates.get(id)?.raster?.id,
			}));
			const previousTimeMa = projectionController?.getSnapshot().committedTimeMa ?? initialAgeMa;
			const previousRotations = rotationModel.getRotationMap(previousTimeMa, 0);
			const targetRotations = rotationModel.getRotationMap(context.ageMa, 0);
			let atlasTicket: AtlasTimeGroup | undefined;
			let invalidated = false;
			let activated = false;
			let accepted = false;
			let finished = false;
			const invalidate = (): void => {
				if (finished || accepted || invalidated) return;
				invalidated = true;
				context.onFailure(new OperationInterruptedError("superseded", "A participating layer changed during time preparation."));
			};
			const validate = (): void => {
				if (finished || invalidated || context.signal.aborted || pointDisposed ||
					capturedPoint !== pointRenderer || capturedPointGeneration !== pointLoadGeneration ||
					capturedAtlases.length !== atlasControllers.size ||
					capturedAtlases.some(item => atlasControllers.get(item.id) !== item.controller ||
						item.sourceRef !== projectSession.getLayer(item.id)?.sourceRef || item.visible !== projectSession.getEffectiveLayerVisibility(item.id)) ||
					capturedRasters.length !== rasterControllers.size ||
					capturedRasters.some(item => rasterControllers.get(item.id) !== item.controller ||
						item.rasterId !== rasterStates.get(item.id)?.raster?.id || item.visible !== projectSession.getEffectiveLayerVisibility(item.id)) ||
					visibility.some((visible, index) => visible !== projectSession.getEffectiveLayerVisibility(PROJECTION_INCOMPATIBLE_LAYER_IDS[index]!))) {
					throw new OperationInterruptedError("superseded");
				}
			};
			const detach = (): void => {
				if (invalidateActiveTimeLayers === invalidate) invalidateActiveTimeLayers = undefined;
			};
			invalidateActiveTimeLayers = invalidate;
			// A static raster selection is a separate operation. Finish that captured
			// selection before preparing a time frame; never select it again per age.
			const rasterReady = Promise.all(capturedRasters.filter(item => item.visible)
				.map(item => item.controller.whenReady({ signal: context.signal })));
			// Initial attachment/visibility can have its own standalone Atlas load.
			// Join that exact requested frame before claiming the coordinated owner.
			const atlasReady = Promise.all(capturedAtlases.map(item => {
				const loading = atlasLoads.get(item.id);
				if (loading) return loading.promise;
				const state = atlasStates.get(item.id);
				return state?.status === "loading" ? executeAtlasTime(item.controller, state.requestedAgeMa, context.signal) : Promise.resolve();
			}));
			const ready = Promise.all([rasterReady, atlasReady]).then(() => {
				validate();
				if (capturedRasters.some(item => item.visible && item.controller.getCommittedRaster()?.id !== item.rasterId)) {
					throw new OperationInterruptedError("superseded", "The captured raster selection did not commit.");
				}
				atlasTicket = prepareAtlasTimeGroup(capturedAtlases.map(item => item.controller), context.ageMa, {
					owner: context.owner, signal: context.signal, onFailure: context.onFailure,
				});
				return atlasTicket?.ready;
			});
			return {
				ready,
				activate() {
					validate();
					activated = true;
					if (visibility[1]) capturedPoint?.setTime(context.ageMa, targetRotations);
					atlasTicket?.activate();
				},
				canConfirm() { validate(); return atlasTicket?.canConfirm() ?? true; },
				accept() {
					validate();
					atlasTicket?.accept();
					accepted = true;
				},
				rollback() {
					if (finished || accepted) return;
					finished = true;
					detach();
					const failures: unknown[] = [];
					try { atlasTicket?.rollback(); } catch (error) { failures.push(error); }
					if (activated && visibility[1] && capturedPoint === pointRenderer && !pointDisposed) {
						try { capturedPoint?.setTime(previousTimeMa, previousRotations); } catch (error) { failures.push(error); }
					}
					if (failures.length) throw new AggregateError(failures, "Time layer rollback failed.");
				},
				retire() {
					if (finished) return;
					finished = true;
					detach();
					atlasTicket?.retire();
				},
			};
		},
		onTimeLayerCleanupError: (error) => agentActions.diagnostics.record({
			level: "error", category: "render", event: "time.layers.cleanup-failed", outcome: "failed", error,
		}),
		globeHome: () => setCameraHome(viewer),
	});
	projectionController.initialize(initialAgeMa, {
		activeFeatureCount: currentTimeState.activeFeatureCount,
		activePlateCount: currentTimeState.activePlateCount,
		disconnectedFeatureCount: currentTimeState.disconnectedFeatureCount,
	});
	const readCommittedPointFrame = () => {
		const timeMa = projectionController?.getSnapshot().committedTimeMa ?? initialAgeMa;
		return { timeMa, rotationMap: rotationModel.getRotationMap(timeMa, 0) };
	};
	const notifyCameraState = (): void => {
		featureSelection?.invalidatePending();
		if (projectionController?.sceneMode === "globe") {
			projectSession.setCamera({
				position: [viewer.camera.positionWC.x, viewer.camera.positionWC.y, viewer.camera.positionWC.z],
				direction: [viewer.camera.directionWC.x, viewer.camera.directionWC.y, viewer.camera.directionWC.z],
				up: [viewer.camera.upWC.x, viewer.camera.upWC.y, viewer.camera.upWC.z],
			});
			publishProjectState();
		}
		agentActions.notifyStateChanged("projection");
	};
	stateObserverCleanup.push(viewer.camera.changed.addEventListener(notifyCameraState));
	stateObserverCleanup.push(viewer.camera.moveEnd.addEventListener(notifyCameraState));
	const loadedPlateSourceRef = plateModelSourceRef(resolvePlateModelSource(sharedSelection));
	const unsubscribeProjectionSource = phase1BCloudClient.subscribe((state) => {
		if (plateModelSourceRef(resolvePlateModelSource(state.selection)) !== loadedPlateSourceRef) {
			featureSelection?.clear("runtime");
			cancelPointLoad("superseded");
			cameraResetCompletion.cancel("superseded");
			projectionController?.invalidateSource();
		}
	});
	window.addEventListener("pagehide", function releaseProjection(event) {
		if (event.persisted) return;
		window.removeEventListener("pagehide", releaseProjection);
		startupFrameAbort.abort();
		featureSelection?.clear("runtime");
		unsubscribeProjectionSource();
		for (const owner of nativePointSourceLoads.values()) owner.abort.abort(new OperationInterruptedError("cancelled"));
		for (const owner of rasterLoads.values()) owner.abort.abort(new OperationInterruptedError("cancelled"));
		for (const owner of atlasLoads.values()) owner.abort.abort(new OperationInterruptedError("cancelled"));
		void nativePointRuntime?.dispose().catch(error => {
			agentActions.diagnostics.record({ level: "error", category: "app", event: "native-points.cleanup-failed", outcome: "failed", error });
		});
		for (const release of [
			() => {
				pointDisposed = true;
				cancelPointLoad();
				clearPointRuntime();
			},
			...[...atlasControllers.values()].map(controller => () => controller.destroy()),
			...[...rasterControllers.values()].map(controller => () => controller.destroy()),
			() => cameraResetCompletion.destroy(), () => projectionController?.destroy(),
		]) {
			try { release(); }
			catch (error) {
				agentActions.diagnostics.record({ level: "error", category: "app", event: "app.cleanup-failed", outcome: "failed", error });
			}
		}
	});
	projectionSelect.addEventListener("change", () => {
		void agentActions.execute(AGENT_ACTIONS.projectionSelect, { projectionId: projectionSelect.value }).then(result => {
			if (!result.ok) {
				projectionSelect.value = projectionController?.getSnapshot().committedId ?? "globe";
				projectionStatus.textContent = result.error.message;
			}
		});
	});

	viewer.scene.canvas.addEventListener("click", async (event) => {
		const bounds = viewer.scene.canvas.getBoundingClientRect();
		const screen = new Cartesian2(event.clientX - bounds.left, event.clientY - bounds.top);
		const picked = viewer.scene.pick(screen);
		const native = nativePointRuntime?.resolvePick(picked);
		if (native) {
			const key = { viewportId: "main", layerId: native.layerId, featureId: native.featureId };
			try { selectFeature(featureSelection!, selectionPorts, key, "ui"); }
			catch (error) { agentActions.diagnostics.record({ level: "warn", category: "app", event: "selection.pick-failed", outcome: "failed", error }); }
			return;
		}
		const plateHit = picked?.id?.kind === "plate-feature";
		const activePicker = pointPicker;
		const dataset = loadedPointDataset;
		if (
			!activePicker ||
			!dataset ||
			!projectSession.getEffectiveLayerVisibility(RUNTIME_LAYER_IDS.points) ||
			projectSession.getEffectiveLayerOpacity(RUNTIME_LAYER_IDS.points) <= 0 ||
			projectionController?.getSnapshot().committedId !== "globe"
		) {
			if (!plateHit) featureSelection?.clear("ui");
			return;
		}
		const pickedSurface = viewer.camera.pickEllipsoid(screen, SPHERICAL_EARTH);
		if (!pickedSurface) {
			// Raised plate surfaces can be visible beyond the base sphere's limb.
			if (!plateHit) featureSelection?.clear("ui");
			return;
		}
		const target = Cartesian3.normalize(pickedSurface, new Cartesian3());
		const neighbourSurface = viewer.camera.pickEllipsoid(
			new Cartesian2(screen.x + 8, screen.y),
			SPHERICAL_EARTH,
		);
		const maximumAngularDistance = neighbourSurface
			? Math.max(
					0.0015,
					Cartesian3.angleBetween(
						target,
						Cartesian3.normalize(neighbourSurface, new Cartesian3()),
					) * 1.8,
				)
			: 0.006;
		const style = projectSession.getLayer(RUNTIME_LAYER_IDS.points)?.pointStyle;
		if (!style) {
			return;
		}
		const generation = ++pointPickGeneration;
		const selectionGeneration = featureSelection!.beginPick();
		const committedFrame = readCommittedPointFrame();
		let rowId: number | undefined;
		try {
			rowId = await activePicker.pick({ maximumAngularDistance, rotationMap: committedFrame.rotationMap,
				style, target: [target.x, target.y, target.z], timeMa: committedFrame.timeMa });
		} catch (error) {
			agentActions.diagnostics.record({ level: "warn", category: "app", event: "selection.pick-failed", outcome: "failed", error });
			return;
		}
		if (
			generation !== pointPickGeneration ||
			dataset !== loadedPointDataset
		) {
			return;
		}
		if (rowId === undefined) {
			if (!plateHit) featureSelection!.commitPick(selectionGeneration, null);
			return;
		}
		const key = { viewportId: "main", layerId: RUNTIME_LAYER_IDS.points, featureId: createPointFeatureId(dataset.datasetId, rowId) };
		try {
			const feature = readSelectionFeature(key);
			if (feature.selectable) featureSelection!.commitPick(selectionGeneration, key, feature.owner);
			else if (!plateHit) featureSelection!.commitPick(selectionGeneration, null);
		}
		catch (error) { agentActions.diagnostics.record({ level: "warn", category: "app", event: "selection.pick-failed", outcome: "failed", error }); }
	});

	requiredElement("#home-camera", HTMLButtonElement).addEventListener(
		"click",
		() => { void agentActions.execute(AGENT_ACTIONS.cameraReset).then(result => {
			if (!result.ok) projectionStatus.textContent = result.error.message;
		}); },
	);

	/**
	 * Shared setters for the native sidebar controls. The DOM listener and the
	 * action handler call the same function, so a programmatic change behaves
	 * exactly like a user dragging the control.
	 */
	const selectSingleRaster = async (rasterId: string, signal?: AbortSignal, layerId: number = RUNTIME_LAYER_IDS.raster) => {
		validateRasterSelection(layerId, rasterId);
		if (isLayerRetrying(layerId)) throw new AgentActionBusyError("Wait for this raster retry to finish before selecting a source.");
		if (rasterLoads.has(layerId) || rasterRemovals.has(layerId) || rasterRemovalRequested.has(layerId)) throw new AgentActionBusyError("Wait for this raster instance to finish loading, or retry its requested removal.");
		if (rasterCleanupPending.has(layerId) && layerId !== RUNTIME_LAYER_IDS.raster) throw new AgentActionBusyError("Finish removing this failed raster instance before selecting another source.");
		if (signal?.aborted) throw new OperationInterruptedError("cancelled");
		// Default layer removal is not exposed. Its explicit select retry owns
		// cleanup; a failed removal of an ordinary instance must finish removal.
		if (rasterCleanupPending.has(layerId)) await removeRasterInstance(layerId);
		if (signal?.aborted) throw new OperationInterruptedError("cancelled");
		invalidateActiveTimeLayers?.();
		const controller = ensureRasterController(layerId);
		const currentOwner = rasterSelectionOwners.get(layerId);
		const owner = currentOwner?.rasterId === rasterId ? currentOwner : {
			rasterId, generation: (rasterSelectionGenerations.get(layerId) ?? 0) + 1, waiters: 0, committed: false,
		};
		rasterSelectionOwners.set(layerId, owner);
		rasterSelectionGenerations.set(layerId, owner.generation);
		owner.waiters++;
		const storedId = projectSession.getLayer(layerId)?.rasterId;
		const previousId = controller.getCommittedRaster()?.id ?? (typeof storedId === "string" && rasterManifest?.rasters.some(entry => entry.id === storedId) ? storedId : undefined);
		if (layerId === RUNTIME_LAYER_IDS.raster) singleRasterSelect.value = rasterId;
		rasterErrors.delete(layerId);
		try {
			const result = await executeRasterSelection(controller, rasterId, signal);
			if (rasterControllers.get(layerId) !== controller || rasterSelectionGenerations.get(layerId) !== owner.generation || rasterRemovalRequested.has(layerId) || !projectSession.getLayer(layerId)) throw new OperationInterruptedError("superseded");
			if (signal?.aborted) {
				if (owner.waiters === 1 && !owner.committed) {
					if (previousId) await executeRasterSelection(controller, previousId);
					else await removeRasterInstance(layerId, true);
				}
				throw new OperationInterruptedError("cancelled");
			}
			if (!owner.committed) {
				projectSession.setRasterId(layerId, rasterId);
				persistLayerEdit();
				owner.committed = true;
				publishRasterState();
			}
			return result;
		} catch (error) {
			if (rasterSelectionGenerations.get(layerId) === owner.generation && owner.waiters === 1 && !owner.committed) {
				if (layerId === RUNTIME_LAYER_IDS.raster) singleRasterSelect.value = controller.getCommittedRaster()?.id ?? "";
				publishRasterState();
			}
			throw error;
		} finally {
			owner.waiters--;
			if (owner.waiters === 0 && rasterSelectionOwners.get(layerId) === owner) rasterSelectionOwners.delete(layerId);
		}
	};

	const setPointSizePixels = (pointSizePx: number): number => {
		// Out-of-range sizes are rejected instead of clamped: the session and the
		// GPU clamp to the style expression range, so accepting one here would
		// answer `ok` while storing a different size than the caller asked for.
		const pixels = parsePointSizePixels(pointSizePx);
		if (pixels === undefined) {
			throw new AgentActionValidationError(
				`pointSize must be a number between ${POINT_SIZE_MIN_PIXELS} and ${POINT_SIZE_MAX_PIXELS}.`,
			);
		}
		pointSize.value = String(pixels);
		pointSizeValue.textContent = `${pixels.toFixed(1)} px`;
		// The same setter the style panel and `points.setStyle` use, so the
		// pixel size lands in the stored style (and therefore on the GPU and in
		// the persisted session) instead of only in this input.
		layerController.setPointStyle(RUNTIME_LAYER_IDS.points, {
			...normalizePointStyleExpression(
				projectSession.getLayer(RUNTIME_LAYER_IDS.points)?.pointStyle,
			),
			pointSize: pixels,
		});
		return pixels;
	};

	const setProjectName = (name: string): void => {
		projectName.value = name;
		projectSession.setName(name);
		persistLayerEdit();
	};

	const assertPointLoadAvailable = (): void => {
		if (pointDisposed) throw new OperationInterruptedError("cancelled", "The point runtime has been disposed.");
		if (hasPendingPointRelease()) {
			throw new AgentActionBusyError("Point resource cleanup failed. Retry unloading before loading another dataset.");
		}
		if (pointLoadInFlight) {
			throw new AgentActionBusyError("A point dataset is already loading.");
		}
		projectionController?.assertGlobeRuntimeAvailable();
	};

	const selectLocalPointDataset = async (
		datasetId: string,
		load: boolean,
		signal?: AbortSignal,
	): Promise<void> => {
		if (signal?.aborted) throw new OperationInterruptedError("cancelled");
		const manifest = pointManifestRef;
		if (!manifest) {
			throw new AgentActionUnsupportedError(
				"The point dataset manifest is not available in this build.",
			);
		}
		if (!manifest.datasets.some((entry) => entry.id === datasetId)) {
			throw new AgentActionValidationError(
				`Unknown point dataset "${datasetId}".`,
			);
		}
		if (load) {
			assertPointLoadAvailable();
			if (!loadSelectedPointDataset) {
				throw new AgentActionUnsupportedError(
					"The point dataset manifest is not ready yet.",
				);
			}
		}
		if (pointDatasetSelect.value !== datasetId && pointLoadInFlight) {
			cancelPointLoad("superseded");
			loadPointsButton.disabled = false;
			pointDatasetSelect.disabled = false;
			setPointPanelState("ready", "已选择", "已取消旧点数据加载；可加载当前选择。");
		}
		pointDatasetSelect.value = datasetId;
		if (load) await loadSelectedPointDataset!(signal);
	};

	singleRasterSelect.addEventListener("change", () => {
		// Use the same action/trace and owner as programmatic selection. The
		// controller publishes UI state only for the operation it still owns.
		void agentActions.execute(AGENT_ACTIONS.rasterSelect, { rasterId: singleRasterSelect.value });
	});
	singleRasterOpacity.addEventListener("input", () => {
		const opacity = Number(singleRasterOpacity.value);
		singleRasterOpacityValue.textContent = `${Math.round(opacity * 100)}%`;
		layerController.setLayerOpacity(RUNTIME_LAYER_IDS.raster, opacity);
	});

	pointSize.addEventListener("input", () => {
		setPointSizePixels(Number(pointSize.value));
	});
	projectName.addEventListener("input", () => {
		setProjectName(projectName.value);
	});

	const captureProjectState = (): void => {
		projectSession.setName(projectName.value);
		projectSession.setTime(timeline.currentAgeMa);
		// The persisted camera snapshot is an ECEF globe view. The Rectangle
		// (2D) camera has no ECEF position, so it must never be written here; the
		// last globe snapshot is left untouched and a reload starts on the globe.
		// `sceneMode` is the mode the scene is actually morphed to, so a mid-switch
		// window never writes a flat camera.
		if (projectionController?.sceneMode === "globe") {
			projectSession.setCamera({
				direction: [
					viewer.camera.directionWC.x,
					viewer.camera.directionWC.y,
					viewer.camera.directionWC.z,
				],
				position: [
					viewer.camera.positionWC.x,
					viewer.camera.positionWC.y,
					viewer.camera.positionWC.z,
				],
				up: [viewer.camera.upWC.x, viewer.camera.upWC.y, viewer.camera.upWC.z],
			});
		}
		const selection = phase1BCloudClient.snapshot.selection;
		const plateSource = resolvePlateModelSource(selection);
		// Always written, including for "none": leaving the built-in default in
			// place would make a saved project claim the local demo was used, and a
			// V1 id must never be written into the versioned field.
		if (projectSession.getLayer(RUNTIME_LAYER_IDS.plateModel)) projectSession.setLayerSourceRef(
			RUNTIME_LAYER_IDS.plateModel, plateModelSourceRef(plateSource),
		);
		if (selection.datasetVersionId > 0 && projectSession.getLayer(RUNTIME_LAYER_IDS.points)) {
			projectSession.setLayerSourceRef(
				RUNTIME_LAYER_IDS.points,
				`resource:dataset-version:${selection.datasetVersionId}`
		);
		}
	};
	captureCurrentProject = captureProjectState;

	let cloudAutosaveTimer: number | undefined;
	const scheduleCloudLayerAutosave = (): void => {
		window.clearTimeout(cloudAutosaveTimer);
		if (
			!phase1BCloudClient.snapshot.account ||
			!phase1BCloudClient.getCloudReference()
		) {
			return;
		}
		cloudAutosaveTimer = window.setTimeout(async () => {
			try {
				await saveProjectToCloud();
			} catch (error) {
				window.dispatchEvent(
					new CustomEvent("timemachine:project-save-error", {
						detail: {
							message: error instanceof Error ? error.message : String(error),
						},
					}),
				);
			}
		}, 900);
	};

	const persistLayerEdit = (): void => {
		localProjectActions.saveLocal();
		scheduleCloudLayerAutosave();
	};
	const publishAtlasState = (): void => {
		const error = atlasErrors.get(RUNTIME_LAYER_IDS.atlas);
		if (error) {
			atlasStatus.dataset.state = "error";
			atlasStatus.textContent = error;
			const frame = atlasControllers.get(RUNTIME_LAYER_IDS.atlas)?.getCommittedFrame();
			atlasFrameValue.textContent = frame ? `${frame.timeMa} Ma` : "—";
		}
		applyLayerState();
		projectionController?.refreshCapabilities();
		agentActions.notifyStateChanged("layers");
		agentActions.notifyStateChanged("atlas");
	};
	const ensureAtlasController = (layerId: number): PaleoAtlasLayerController => {
		const existing = atlasControllers.get(layerId);
		if (existing) return existing;
		if (!atlasManifest) throw new AgentActionUnsupportedError("The Atlas manifest is unavailable.");
		const controller = new PaleoAtlasLayerController(viewer, new AtlasFrameResolver(atlasManifest), state => {
			atlasStates.set(layerId, state);
			if (state.status === "error") agentActions.diagnostics.record({
				level: "error", category: "asset", event: "atlas.frame-failed", outcome: "failed", error: new Error(state.message),
			}, { layerId });
			if (layerId === RUNTIME_LAYER_IDS.atlas) updateAtlasState(state);
			else applyImageryOrder();
			publishAtlasState();
		});
		atlasControllers.set(layerId, controller);
		if (layerId === RUNTIME_LAYER_IDS.atlas) atlasController = controller;
		controller.setOpacity(projectSession.getEffectiveLayerOpacity(layerId));
		controller.setVisible(projectSession.getEffectiveLayerVisibility(layerId));
		return controller;
	};
	const releaseAtlasController = async (layerId: number, controller?: PaleoAtlasLayerController): Promise<void> => {
		try {
			controller?.destroy();
			await waitForPointLayerFrame(viewer, undefined, {
				timeMa: projectionController?.getSnapshot().committedTimeMa ?? initialAgeMa, show: false,
				isCurrent: () => atlasControllers.get(layerId) === controller,
			});
		} catch (error) { atlasCleanupPending.add(layerId); throw error; }
		atlasCleanupPending.delete(layerId);
		if (atlasControllers.get(layerId) === controller) atlasControllers.delete(layerId);
		if (layerId === RUNTIME_LAYER_IDS.atlas && atlasController === controller) atlasController = undefined;
		atlasStates.delete(layerId);
	};
	const loadAtlasInstance = (layerId: number, sourceRef: string, signal?: AbortSignal): Promise<void> => {
		const loading = atlasLoads.get(layerId);
		if (loading) return loading.promise;
		const abort = new AbortController();
		const owner = { abort, promise: Promise.resolve() as Promise<void> };
		const forward = (): void => abort.abort(signal?.reason);
		signal?.addEventListener("abort", forward, { once: true });
		if (signal?.aborted) forward();
		atlasLoads.set(layerId, owner);
		atlasErrors.delete(layerId);
		owner.promise = (async () => {
			let controller: PaleoAtlasLayerController | undefined;
			try {
				if (abort.signal.aborted || manifestAbort.signal.aborted) throw new OperationInterruptedError("cancelled");
				if (sourceRef !== PALEO_ATLAS_SOURCE) throw new AgentActionUnsupportedError("The stored Atlas source is not implemented.");
				invalidateActiveTimeLayers?.();
				controller = ensureAtlasController(layerId);
				const timeMa = projectionController?.getSnapshot().committedTimeMa ?? initialAgeMa;
				const result = await executeAtlasTime(controller, timeMa, abort.signal);
				const current = (): boolean => {
					const state = atlasStates.get(layerId);
					return atlasControllers.get(layerId) === controller && atlasLoads.get(layerId) === owner &&
						projectSession.getLayer(layerId)?.sourceRef === sourceRef && !atlasRemovals.has(layerId) &&
						state?.requestedAgeMa === timeMa && (result.status === "hidden"
							? state.status === "hidden" && state.reason === result.reason && (result.reason === "out-of-range" || !projectSession.getEffectiveLayerVisibility(layerId))
							: state.status === "ready" && controller?.getCommittedFrame()?.sourceId === result.sourceId);
				};
				// Hidden/out-of-range standalone Atlas requests do not themselves wait
				// for rendering. The layer.add completion still needs an absence frame.
				if (result.status === "hidden") await waitForPointLayerFrame(viewer, undefined, { signal: abort.signal, timeMa, show: false, isCurrent: current });
				if (abort.signal.aborted || manifestAbort.signal.aborted) throw new OperationInterruptedError("cancelled");
				if (!current()) throw new OperationInterruptedError("superseded");
			} catch (error) {
				if (atlasLoads.get(layerId) !== owner) throw error;
				let failure = error;
				controller ??= atlasControllers.get(layerId);
				if (controller) {
					try { await releaseAtlasController(layerId, controller); }
					catch (cleanup) { failure = new AggregateError([error, cleanup], "Atlas loading and cleanup failed; retry removal."); }
				}
				atlasErrors.set(layerId, "Atlas loading failed; inspect diagnostics or retry removal.");
				if (layerId === RUNTIME_LAYER_IDS.atlas) {
					atlasStatus.dataset.state = "error";
					atlasStatus.textContent = "Stored Atlas source could not be loaded. Reload after checking its source.";
				}
				agentActions.diagnostics.record({ level: "error", category: "asset", event: "atlas.load-failed", outcome: "failed", error: failure }, { layerId });
				throw failure;
			} finally {
				signal?.removeEventListener("abort", forward);
				if (atlasLoads.get(layerId) === owner) atlasLoads.delete(layerId);
				publishAtlasState();
			}
		})();
		return owner.promise;
	};
	const removeAtlasInstance = (layerId: number, cancelledLoad = false): Promise<void> => {
		const pending = atlasRemovals.get(layerId);
		if (pending) return pending;
		invalidateActiveTimeLayers?.();
		const removal = Promise.resolve().then(async () => {
			const loading = atlasLoads.get(layerId);
			if (loading) { loading.abort.abort(new OperationInterruptedError("superseded")); await loading.promise.catch(() => undefined); }
			await releaseAtlasController(layerId, atlasControllers.get(layerId));
			if (cancelledLoad) atlasErrors.set(layerId, "Atlas loading was cancelled after its frame; resources were released.");
			else atlasErrors.delete(layerId);
		}).catch(error => {
			atlasErrors.set(layerId, "Atlas cleanup failed; retry removal.");
			throw error;
		}).finally(() => { atlasRemovals.delete(layerId); publishAtlasState(); });
		atlasRemovals.set(layerId, removal);
		publishAtlasState();
		return removal;
	};
	const publishRasterState = (): void => {
		for (const id of rasterRemovalRequested) if (!projectSession.getLayer(id)) rasterRemovalRequested.delete(id);
		const error = rasterErrors.get(RUNTIME_LAYER_IDS.raster);
		if (error) {
			singleRasterState.textContent = "失败";
			singleRasterState.dataset.state = "error";
			singleRasterStatus.dataset.state = "error";
			singleRasterStatus.textContent = error;
			const raster = rasterControllers.get(RUNTIME_LAYER_IDS.raster)?.getCommittedRaster();
			singleRasterStatus.dataset.rasterId = raster?.id ?? "";
			if (raster) updateSingleRasterLegend(raster); else singleRasterLegend.hidden = true;
		}
		applyLayerState();
		projectionController?.refreshCapabilities();
		agentActions.notifyStateChanged("layers");
		agentActions.notifyStateChanged("raster");
	};
	const validateRasterSelection = (layerId: number, rasterId: string): void => {
		const layer = projectSession.getLayer(layerId);
		if (!layer || layer.type !== ProjectLayerType.Raster) throw new AgentActionValidationError("An existing Raster layer is required.");
		if (layer.sourceRef !== SINGLE_RASTER_SOURCE) throw new AgentActionUnsupportedError("This raster source is not implemented; no default source is substituted.");
		if (!rasterManifest) throw new AgentActionUnsupportedError("The raster manifest is not available.");
		if (!rasterManifest.rasters.some(entry => entry.id === rasterId)) throw new AgentActionValidationError(`Unknown raster "${rasterId}".`);
	};
	const ensureRasterController = (layerId: number): SingleRasterLayerController => {
		const existing = rasterControllers.get(layerId);
		if (existing) return existing;
		if (!rasterManifest) throw new AgentActionUnsupportedError("The raster manifest is not available.");
		const controller = new SingleRasterLayerController(viewer, rasterManifest, state => {
			rasterStates.set(layerId, state);
			if (layerId === RUNTIME_LAYER_IDS.raster) updateSingleRasterState(state);
			else applyImageryOrder();
			publishRasterState();
		}, (error, context) => {
			agentActions.diagnostics.record({ level: "error", category: "render", event: `raster.${context.phase}-failed`, outcome: "failed",
				error, errorCode: `RASTER_${error.kind.toUpperCase()}` }, { layerId, generation: context.generation });
		});
		rasterControllers.set(layerId, controller);
		if (layerId === RUNTIME_LAYER_IDS.raster) singleRasterController = controller;
		controller.setOpacity(projectSession.getEffectiveLayerOpacity(layerId));
		controller.setVisible(projectSession.getEffectiveLayerVisibility(layerId));
		return controller;
	};
	const releaseRasterController = async (layerId: number, controller: SingleRasterLayerController | undefined): Promise<void> => {
		try {
			controller?.destroy();
			await waitForPointLayerFrame(viewer, undefined, {
				timeMa: projectionController?.getSnapshot().committedTimeMa ?? initialAgeMa, show: false,
				isCurrent: () => rasterControllers.get(layerId) === controller,
			});
		} catch (error) { rasterCleanupPending.add(layerId); throw error; }
		rasterCleanupPending.delete(layerId);
		if (rasterControllers.get(layerId) === controller) rasterControllers.delete(layerId);
		if (layerId === RUNTIME_LAYER_IDS.raster && singleRasterController === controller) singleRasterController = undefined;
		rasterStates.delete(layerId);
	};
	const loadRasterInstance = (layerId: number, sourceRef: string, signal?: AbortSignal): Promise<void> => {
		const loading = rasterLoads.get(layerId);
		if (loading) return loading.promise;
		const abort = new AbortController();
		const owner = { abort, promise: Promise.resolve() as Promise<void> };
		const forward = (): void => abort.abort(signal?.reason);
		signal?.addEventListener("abort", forward, { once: true });
		if (signal?.aborted) forward();
		rasterLoads.set(layerId, owner);
		rasterErrors.delete(layerId);
		owner.promise = (async () => {
			let controller: SingleRasterLayerController | undefined;
			try {
				if (abort.signal.aborted || manifestAbort.signal.aborted) throw new OperationInterruptedError("cancelled");
				if (sourceRef !== SINGLE_RASTER_SOURCE) throw new AgentActionUnsupportedError("The stored raster source is not implemented.");
				const rasterId = projectSession.getRasterId(layerId) ?? rasterManifest?.defaultRasterId;
				validateRasterSelection(layerId, rasterId!);
				invalidateActiveTimeLayers?.();
				controller = ensureRasterController(layerId);
				if (layerId === RUNTIME_LAYER_IDS.raster) singleRasterSelect.value = rasterId!;
				await executeRasterSelection(controller, rasterId!, abort.signal);
				if (abort.signal.aborted || manifestAbort.signal.aborted) throw new OperationInterruptedError("cancelled");
				if (rasterLoads.get(layerId) !== owner || !projectSession.getLayer(layerId)) throw new OperationInterruptedError("superseded");
				projectSession.setRasterId(layerId, rasterId!);
				persistLayerEdit();
			} catch (error) {
				if (rasterLoads.get(layerId) !== owner) throw error;
				let failure = error;
				controller ??= rasterControllers.get(layerId);
				if (controller) {
					try { await releaseRasterController(layerId, controller); }
					catch (cleanup) { failure = new AggregateError([error, cleanup], "Raster loading and cleanup failed; retry removal."); }
				}
				rasterErrors.set(layerId, "Raster loading failed; inspect diagnostics or retry removal.");
				if (layerId === RUNTIME_LAYER_IDS.raster) {
					singleRasterState.textContent = "失败";
					singleRasterState.dataset.state = "error";
					singleRasterStatus.textContent = "Stored raster selection could not be loaded. Choose an available raster to retry.";
				}
				agentActions.diagnostics.record({ level: "error", category: "asset", event: "raster.load-failed", outcome: "failed", error: failure }, { layerId });
				throw failure;
			} finally {
				signal?.removeEventListener("abort", forward);
				if (rasterLoads.get(layerId) === owner) rasterLoads.delete(layerId);
				publishRasterState();
			}
		})();
		return owner.promise;
	};
	const removeRasterInstance = (layerId: number, cancelledLoad = false): Promise<void> => {
		if (layerId !== RUNTIME_LAYER_IDS.raster) rasterRemovalRequested.add(layerId);
		const pending = rasterRemovals.get(layerId);
		if (pending) return pending;
		invalidateActiveTimeLayers?.();
		rasterSelectionGenerations.set(layerId, (rasterSelectionGenerations.get(layerId) ?? 0) + 1);
		// Defer to a microtask so reentrant state observers see the removal owner.
		const removal = Promise.resolve().then(async () => {
			const loading = rasterLoads.get(layerId);
			if (loading) { loading.abort.abort(new OperationInterruptedError("superseded")); await loading.promise.catch(() => undefined); }
			await releaseRasterController(layerId, rasterControllers.get(layerId));
			if (cancelledLoad) rasterErrors.set(layerId, "Raster loading was cancelled after its frame; resources were released.");
			else rasterErrors.delete(layerId);
		}).catch(error => {
			rasterErrors.set(layerId, "Raster cleanup failed; retry removal.");
			throw error;
		}).finally(() => { rasterRemovals.delete(layerId); publishRasterState(); });
		rasterRemovals.set(layerId, removal);
		publishRasterState();
		return removal;
	};
	const publishNativePointState = (): void => {
		reconcileFeatureSelection();
		applyLayerState();
		projectionController?.refreshCapabilities();
		agentActions.notifyStateChanged("layers");
	};
	nativePointRuntime = new NativePointLayerRuntime(viewer, {
		readEffectiveState: id => projectSession.getLayer(id) ? {
			visible: projectSession.getEffectiveLayerVisibility(id),
			opacity: projectSession.getEffectiveLayerOpacity(id),
			style: projectSession.getLayer(id)?.type === ProjectLayerType.Polygon
				? readNativePolygonStyle(projectSession.getLayer(id)?.polygonStyle)
				: projectSession.getLayer(id)?.type === ProjectLayerType.Line
					? readNativeLineStyle(projectSession.getLayer(id)?.lineStyle)
					: readNativePointStyle(projectSession.getLayer(id)?.pointStyle),
		} : undefined,
		onStateChange: publishNativePointState,
		onDiagnostic: (error, context) => {
			agentActions.diagnostics.record({
				level: "error", category: "render", event: `native-vectors.${context.phase}-failed`, outcome: "failed", error,
			}, { layerId: context.layerId, featureId: context.featureId });
		},
	});
	const assertNativePointAddAllowed = (_input: Pick<LayerInstanceInput, "type"> & { rasterId?: unknown }): void => {
		projectionController?.assertGlobeRuntimeAvailable();
		const state = projectionController?.getSnapshot();
		if (!state || state.status === "preparing" || state.requestedId !== "globe" || state.committedId !== "globe") {
			throw new AgentActionUnsupportedError("Native vector instance creation currently requires a committed Globe view. Its other projection paths are not implemented yet.");
		}
		if (_input.type === ProjectLayerType.Raster) {
			if (!rasterManifest) throw new AgentActionUnsupportedError("Wait for the raster manifest before adding a raster instance.");
			const id = _input.rasterId ?? rasterManifest.defaultRasterId;
			if (!rasterManifest.rasters.some(entry => entry.id === id)) throw new AgentActionValidationError(`Unknown raster "${id}".`);
		}
		if (_input.type === ProjectLayerType.Atlas && !atlasManifest) throw new AgentActionUnsupportedError("Wait for the Atlas manifest before adding an Atlas instance.");
	};
	const loadNativePointInstance = (layerId: number, sourceRef: string, signal?: AbortSignal): Promise<void> => {
		const abort = new AbortController();
		const owner = { abort, promise: Promise.resolve() as Promise<void>, sourceRef };
		const forwardAbort = (): void => abort.abort(signal?.reason);
		signal?.addEventListener("abort", forwardAbort, { once: true });
		if (signal?.aborted) forwardAbort();
		nativePointSourceErrors.delete(layerId);
		nativePointSourceLoads.set(layerId, owner);
		nativeSelectionOwners.set(layerId, owner);
		publishNativePointState();
		owner.promise = (async () => {
			try {
				const source = await loadSyntheticVectorSource(sourceRef, abort.signal);
				if (manifestAbort.signal.aborted || abort.signal.aborted) throw abort.signal.reason instanceof OperationInterruptedError
					? abort.signal.reason : new OperationInterruptedError("cancelled");
				if (!projectSession.getLayer(layerId) || nativePointSourceLoads.get(layerId) !== owner) throw new OperationInterruptedError("superseded");
				const expectedType = source.kind === "polygon" ? ProjectLayerType.Polygon : source.kind === "line" ? ProjectLayerType.Line : ProjectLayerType.Point;
				if (projectSession.getLayer(layerId)!.type !== expectedType) throw new AgentActionUnsupportedError("The stored vector layer type does not match its source geometry.");
				await nativePointRuntime!.add(layerId, source, abort.signal);
			} catch (error) {
				if (projectSession.getLayer(layerId)) nativePointSourceErrors.set(layerId,
					error instanceof OperationInterruptedError ? "Vector layer loading was cancelled or superseded." : "Vector layer loading failed. Inspect diagnostics for details.");
				agentActions.diagnostics.record({ level: "error", category: "asset", event: "native-vectors.load-failed", outcome: "failed", error }, { layerId });
				throw error;
			} finally {
				signal?.removeEventListener("abort", forwardAbort);
				if (nativePointSourceLoads.get(layerId) === owner) nativePointSourceLoads.delete(layerId);
				publishNativePointState();
			}
		})();
		return owner.promise;
	};
	const removeNativePointInstance = async (layerId: number, cancelledLoad = false): Promise<void> => {
		const pending = nativePointSourceLoads.get(layerId);
		if (pending) {
			pending.abort.abort(new OperationInterruptedError("superseded"));
			await pending.promise.catch(() => undefined);
		}
		if (nativePointRuntime?.get(layerId)) await nativePointRuntime.remove(layerId);
		else await waitForPointLayerFrame(viewer, undefined, {
			timeMa: projectionController?.getSnapshot().committedTimeMa ?? initialAgeMa,
			show: false,
			isCurrent: () => !nativePointRuntime?.get(layerId) && !nativePointSourceLoads.has(layerId),
		});
		if (cancelledLoad) nativePointSourceErrors.set(layerId, "Vector layer loading was cancelled after its frame. Its resources have been released.");
		else nativePointSourceErrors.delete(layerId);
		nativeSelectionOwners.delete(layerId);
		publishNativePointState();
	};
	const retryLayerInstance = async (layerId: number, signal?: AbortSignal): Promise<void> => {
		const layer = projectSession.getLayer(layerId);
		if (!layer) throw new AgentActionValidationError(`Unknown layer ${layerId}.`);
		assertNativePointAddAllowed(layer);
		if (atlasLoads.has(layerId) || rasterLoads.has(layerId) || nativePointSourceLoads.has(layerId) ||
			atlasRemovals.has(layerId) || rasterRemovals.has(layerId) || rasterSelectionOwners.has(layerId) ||
			nativePointRuntime?.get(layerId)?.runtimeStatus === "removing") {
			throw new AgentActionBusyError("Wait for this layer's current operation to finish before retrying.");
		}
		if (instanceRuntimeState(layerId).runtimeStatus !== "error") throw new AgentActionValidationError("Only a failed layer can be retried.");
		if (signal?.aborted) throw new OperationInterruptedError("cancelled");
		invalidateActiveTimeLayers?.();
		const remove = layer.type === ProjectLayerType.Raster ? removeRasterInstance
			: layer.type === ProjectLayerType.Atlas ? removeAtlasInstance : removeNativePointInstance;
		const load = layer.type === ProjectLayerType.Raster ? loadRasterInstance
			: layer.type === ProjectLayerType.Atlas ? loadAtlasInstance : loadNativePointInstance;
		// Retain an explicit failed record during the gap between cleanup and
		// replacement. Cancellation here must not appear as a successful unload.
		await remove(layerId, true);
		if (signal?.aborted) throw new OperationInterruptedError("cancelled");
		assertNativePointAddAllowed(layer);
		// The action owns the retry lock until late cancellation cleanup finishes;
		// neither layer.remove nor raster.select can resurrect this removal intent.
		if (layer.type === ProjectLayerType.Raster) rasterRemovalRequested.delete(layerId);
		await load(layerId, layer.sourceRef, signal);
	};

	/**
	 * Mirrors the project session onto the native sidebar controls, so a change
	 * made through the action facade is visible in the UI too.
	 */
	const syncNativeControls = (): void => {
		atlasVisibility.checked = projectSession.getEffectiveLayerVisibility(
			RUNTIME_LAYER_IDS.atlas,
		);
		pointVisibility.checked = projectSession.getEffectiveLayerVisibility(
			RUNTIME_LAYER_IDS.points,
		);
		singleRasterVisibility.checked = projectSession.getEffectiveLayerVisibility(
			RUNTIME_LAYER_IDS.raster,
		);
		plateVisibility.checked = projectSession.getEffectiveLayerVisibility(
			RUNTIME_LAYER_IDS.plateModel,
		);
		const rasterAlpha = projectSession.getLayer(RUNTIME_LAYER_IDS.raster)?.alpha;
		if (rasterAlpha !== undefined) {
			singleRasterOpacity.value = String(rasterAlpha);
			singleRasterOpacityValue.textContent = `${Math.round(rasterAlpha * 100)}%`;
		}
		const pointStyle = projectSession.getLayer(RUNTIME_LAYER_IDS.points)
			?.pointStyle;
		if (pointStyle) {
			pointSize.value = String(pointStyle.pointSize);
			pointSizeValue.textContent = `${pointStyle.pointSize.toFixed(1)} px`;
		}
	};

	const applyLayerRuntimeState = (id: number): void => {
		invalidateActiveTimeLayers?.();
		const visible = projectSession.getEffectiveLayerVisibility(id);
		const opacity = projectSession.getEffectiveLayerOpacity(id);
		if (nativePointRuntime?.get(id)) {
			nativePointRuntime.apply(id);
		} else if (projectSession.getLayer(id)?.type === ProjectLayerType.Atlas) {
			const controller = atlasControllers.get(id);
			if (atlasRemovals.has(id) || atlasCleanupPending.has(id)) return;
			controller?.setVisible(visible);
			controller?.setOpacity(opacity);
			const timeMa = projectionController?.getSnapshot().committedTimeMa ?? initialAgeMa;
			if (visible && atlasStates.get(id)?.requestedAgeMa !== timeMa) controller?.setTime(timeMa);
		} else if (projectSession.getLayer(id)?.type === ProjectLayerType.Raster) {
			const controller = rasterControllers.get(id);
			controller?.setVisible(visible);
			controller?.setOpacity(opacity);
		} else if (id === RUNTIME_LAYER_IDS.points) {
			if (visible && projectionController?.activeMode === "globe") {
				const frame = readCommittedPointFrame();
				pointRenderer?.setTime(frame.timeMa, frame.rotationMap);
			}
			// Style too, not just visibility/opacity: the stored pointStyle is the
			// single source of truth for what the GPU draws.
			applyPointRuntimeState(
				pointRenderer,
				projectSession.getLayer(id)?.pointStyle,
				visible,
				opacity,
			);
		} else if (id === RUNTIME_LAYER_IDS.plateModel) {
			renderer.setPlateGeometryVisible(visible);
			renderer.setPlateGeometryOpacity(opacity);
			if (projectionController?.activeMode !== "globe") {
				// Flat style path: setPlateGeometry* already synced the committed
				// rectangle frame. Running the globe updateTime here would re-show the
				// hidden globe bundles (two copies of the plates), so the time state is
				// refreshed for the committed rectangle age instead.
				refreshRectangleTimeState();
				updateInspector();
			} else {
				currentTimeState = renderer.updateTime(
					appliedGlobeTimeMa,
					rotationModel
				);
			}
		}
	};

	const layerController = new LayerController(projectSession, {
		applyImageryOrder,
		applyRuntime: applyLayerRuntimeState,
		persist: persistLayerEdit,
		publishState: () => {
			reconcileFeatureSelection();
			applyLayerState();
			// Every layer/group/order mutation lands here, and each one can flip a
			// rectangle-incompatible layer's effective visibility. Republishing the
			// projection capabilities keeps the select option and the status line
			// honest without a reload; only availability is recomputed (no
			// mode/time/revision change, no frame). This adapter is installed after
			// the ProjectionController is constructed, so it never touches the
			// controller binding before initialization.
			projectionController?.refreshCapabilities();
			agentActions.notifyStateChanged("layers");
		},
		syncNativeControls,
	});

	// Projection-aware layer guards. Each simulates the layer/group state the
	// mutation would produce and refuses it - before anything is applied - if it
	// would make a rectangle-incompatible layer effective-visible while rectangle
	// is active or pending. Both the sidebar events and the action handlers call
	// these, so a GUI gesture and an agent call behave identically and a rejection
	// leaves runtime and persistence untouched. Opacity and collapse never change
	// visibility, so they are not guarded.
	const guardLayerVisibility = (id: number, active: boolean): void => {
		projectionController?.assertLayerMutationAllowed(
			projectSession.layerList.map((layer) =>
				layer.id === id ? { ...layer, active } : layer,
			),
			projectSession.groupList,
		);
	};
	const guardGroupVisibility = (id: number, active: boolean): void => {
		projectionController?.assertLayerMutationAllowed(
			projectSession.layerList,
			projectSession.groupList.map((group) =>
				group.id === id ? { ...group, active } : group,
			),
		);
	};
	const guardLayerGroup = (layerId: number, groupId: number): void => {
		projectionController?.assertLayerMutationAllowed(
			projectSession.layerList.map((layer) =>
				layer.id === layerId ? { ...layer, groupId } : layer,
			),
			projectSession.groupList,
		);
	};
	const guardOrder = (groupIdByLayer?: Record<string, number>): void => {
		const layers = groupIdByLayer
			? projectSession.layerList.map((layer) => {
					const next = groupIdByLayer[layer.id];
					return next !== undefined ? { ...layer, groupId: next } : layer;
				})
			: projectSession.layerList;
		projectionController?.assertLayerMutationAllowed(
			layers,
			projectSession.groupList,
		);
	};

	window.addEventListener(LAYER_VISIBILITY_CHANGE_EVENT, (event: Event) => {
		const { active, id } = (event as CustomEvent<LayerVisibilityChangeDetail>)
			.detail;
		guardLayerVisibility(id, active);
		layerController.setLayerVisibility(id, active);
	});

	window.addEventListener(LAYER_OPACITY_CHANGE_EVENT, (event: Event) => {
		const { alpha, id } = (event as CustomEvent<LayerOpacityChangeDetail>)
			.detail;
		layerController.setLayerOpacity(id, alpha);
	});

	window.addEventListener(LAYER_ORDER_CHANGE_EVENT, (event: Event) => {
		const { groupIdByLayer, orderedIds } = (
			event as CustomEvent<LayerOrderChangeDetail>
		).detail;
		guardOrder(groupIdByLayer);
		layerController.setOrder(orderedIds, groupIdByLayer);
	});

	window.addEventListener(
		LAYER_GROUP_VISIBILITY_CHANGE_EVENT,
		(event: Event) => {
			const { active, id } = (
				event as CustomEvent<LayerGroupVisibilityChangeDetail>
			).detail;
			guardGroupVisibility(id, active);
			layerController.setGroupVisibility(id, active);
		},
	);

	window.addEventListener(LAYER_GROUP_OPACITY_CHANGE_EVENT, (event: Event) => {
		const { alpha, id } = (event as CustomEvent<LayerGroupOpacityChangeDetail>)
			.detail;
		layerController.setGroupOpacity(id, alpha);
	});

	window.addEventListener(LAYER_GROUP_COLLAPSE_CHANGE_EVENT, (event: Event) => {
		const { collapsed, id } = (
			event as CustomEvent<LayerGroupCollapseChangeDetail>
		).detail;
		layerController.setGroupCollapsed(id, collapsed);
	});

	window.addEventListener(POINT_STYLE_CHANGE_EVENT, (event: Event) => {
		const { id, style } = (event as CustomEvent<PointStyleChangeDetail>).detail;
		layerController.setPointStyle(id, style);
	});

	/**
	 * The one real cloud save. The action facade registers it directly and the
	 * legacy window event is a thin wrapper around it, so the Save button and an
	 * automated caller can never diverge.
	 */
	const saveProjectToCloud = async (): Promise<AgentActionOutcome> => {
		if (cloudSaveState.status === "saving") throw new AgentActionBusyError("A cloud save is already running.");
		requireV2Workspace(
			phase1BCloudClient.snapshot.v2WorkspaceAvailable,
			"cloud projects",
		);
		window.clearTimeout(cloudAutosaveTimer);
		try {
			const snapshot = localProjectActions.saveLocal();
			const document = projectSession.toDocument();
			cloudSaveState = { status: "saving", revision: snapshot.revision };
			publishProjectState();
			const cloudReference = await phase1BCloudClient.saveProject(document);
			cloudSaveState = { status: "saved", revision: snapshot.revision,
				revisionId: cloudReference.revisionId, revisionNumber: cloudReference.revisionNumber };
			window.dispatchEvent(new CustomEvent("timemachine:project-saved", { detail: {
				message: `Cloud revision ${cloudReference.revisionNumber} saved at ${new Date(snapshot.savedAt).toLocaleTimeString()}.`,
			} }));
			return { data: { revisionId: cloudReference.revisionId, revisionNumber: cloudReference.revisionNumber } };
		} catch (error) {
			cloudSaveState = error instanceof CloudProjectSaveError
				? { ...cloudSaveState, status: "error", remoteCommitted: true,
					revisionId: error.reference.revisionId, revisionNumber: error.reference.revisionNumber,
					message: error.phase === "local-reference"
						? `Cloud revision ${error.reference.revisionNumber} was saved. Its local reference could not be stored; open that revision before saving again.`
						: `Cloud revision ${error.reference.revisionNumber} was saved. Refresh the workspace catalog to view it.` }
				: { status: "error", revision: projectSession.localSaveState.revision,
					message: "Cloud save failed. Current edits remain available; inspect the operation error for details." };
			throw error;
		} finally { publishProjectState(); }
	};

	window.addEventListener("timemachine:project-save-request", () => {
		void saveProjectToCloud().catch((error: unknown) => {
			window.dispatchEvent(
				new CustomEvent("timemachine:project-save-error", {
					detail: {
						message: error instanceof Error ? error.message : String(error),
					},
				})
			);
		});
	});

	const clearPointMetrics = (): void => {
		pointCount.textContent = "—";
		visiblePointCount.textContent = "—";
		pointMemory.textContent = "—";
		pointLoadTime.textContent = "—";
		pointFps.textContent = "—";
		pointFrameP95.textContent = "—";
		pointLatency.textContent = "—";
		pointJsHeap.textContent = "—";
	};

	function reportPointCleanupError(error: unknown): void {
		agentActions.diagnostics.record({ level: "error", category: "app", event: "points.cleanup-failed", outcome: "failed", error });
	}
	function releasePointResources(resources: PointReleaseResources): boolean {
		pointResourcesToRelease.add(resources);
		const released = disposePointLayer(resources, reportPointCleanupError);
		if (released) pointResourcesToRelease.delete(resources);
		return released;
	}
	function clearPointRuntime(): boolean {
		pointPickGeneration += 1;
		if (pointRenderer || pointPicker) pointResourcesToRelease.add({ renderer: pointRenderer, picker: pointPicker });
		pointRenderer = undefined;
		pointPicker = undefined;
		loadedPointDataset = undefined;
		loadedPointEntry = undefined;
		reconcileFeatureSelection();
		for (const resources of [...pointResourcesToRelease]) releasePointResources(resources);
		const released = !hasPendingPointRelease();
		if (!viewer.scene.isDestroyed()) viewer.scene.requestRender();
		return released;
	}

	const unloadPointDataset = (): boolean => {
		cancelPointLoad();
		const released = clearPointRuntime();
		performanceMonitor.resetFrameSamples();
		clearPointMetrics();
		unloadPointsButton.disabled = released || pointDisposed;
		loadPointsButton.disabled = !released || !pointManifestRef || pointDisposed;
		pointDatasetSelect.disabled = !pointManifestRef || pointDisposed;
		setPointPanelState(
			released ? "ready" : "error",
			released ? "未加载" : "释放失败",
			released ? "点数据加载已取消，已有点图层资源已释放。" : "部分点资源释放失败，请再次卸载以重试；详情见诊断日志。",
		);
		return released;
	};
	unloadPointsButton.addEventListener("click", unloadPointDataset);

	// Assigned once the point manifest resolves, so the action facade can select a
	// dataset by id without touching the DOM.
	let pointManifestRef: PointFixtureManifest | undefined;
	let loadSelectedPointDataset: ((signal?: AbortSignal) => Promise<void>) | undefined;
	const initializePoints = async (): Promise<void> => {
		try {
			const result = await pointManifestPromise;
			if (manifestAbort.signal.aborted) return;
			if (!result.ok) throw result.error;
			const pointManifest = result.value;
			if (
				pointManifest.format.magic !== "WGP1" ||
				pointManifest.format.recordStrideBytes !== 20 ||
				pointManifest.datasets.length === 0
			) {
				throw new Error("点数据清单格式不受支持。");
			}
			pointManifestRef = pointManifest;
			pointDatasetSelect.replaceChildren(
				...pointManifest.datasets.map((entry) => {
					const option = document.createElement("option");
					option.value = entry.id;
					option.textContent = `${entry.label} · ${entry.pointCount.toLocaleString()} points`;
					return option;
				}),
			);
			pointDatasetSelect.disabled = false;
			loadPointsButton.disabled = false;
			const validityLabel =
				pointManifest.validityPolicy === "permanent_0_1100_ma"
					? "0–1100 Ma 常驻"
					: "按来源年龄过滤";
			setPointPanelState(
				"ready",
				"可测试",
				`已准备 ${pointManifest.datasets.length} 组${validityLabel}数据；真实 PBDB ${pointManifest.basePointCount.toLocaleString()} 点。`,
			);

			loadSelectedPointDataset = async (signal?: AbortSignal): Promise<void> => {
				assertPointLoadAvailable();
				if (signal?.aborted) throw new OperationInterruptedError("cancelled");
				const selectedEntry = pointManifest.datasets.find(
					(entry) => entry.id === pointDatasetSelect.value
			);
				if (!selectedEntry) {
					throw new AgentActionValidationError("No point dataset is selected.");
				}

				invalidateActiveTimeLayers?.();
				const generation = ++pointLoadGeneration;
				pointPickGeneration += 1;
				pointLoadInFlight = true;
				pointLoadAbortController?.abort();
				const abortController = new AbortController();
				pointLoadAbortController = abortController;
				const abort = (): void => abortController.abort(new OperationInterruptedError("cancelled"));
				signal?.addEventListener("abort", abort, { once: true });
				const isCurrent = (): boolean => generation === pointLoadGeneration && !pointDisposed;
				const previous: PointResources = { renderer: pointRenderer, picker: pointPicker };
				const candidate: PointResources = {};
				let activated = false;
				let committed = false;
				let rollbackError: unknown;
				const configurePointFrame = (target: GpuPointRenderer) => {
					const frame = readCommittedPointFrame();
					target.setTime(frame.timeMa, frame.rotationMap);
					const style = projectSession.getLayer(RUNTIME_LAYER_IDS.points)?.pointStyle;
					if (style) target.setStyle(style);
					else target.setPointSize(Number(pointSize.value));
					target.setOpacity(projectSession.getEffectiveLayerOpacity(RUNTIME_LAYER_IDS.points));
					const show = projectSession.getEffectiveLayerVisibility(RUNTIME_LAYER_IDS.points);
					target.setShow(show);
					return { timeMa: frame.timeMa, show };
				};
				const rollback = (): void => {
					if (committed) return;
					if (activated) {
						activated = false;
						pointRenderer = previous.renderer;
						pointPicker = previous.picker;
						pointPickGeneration += 1;
						try { if (previous.renderer) configurePointFrame(previous.renderer); }
						catch (error) { rollbackError = error; reportPointCleanupError(error); }
					}
					try { candidate.renderer?.setShow(false); }
					catch (error) { rollbackError = error; reportPointCleanupError(error); }
					if (candidate.renderer || candidate.picker) releasePointResources(candidate);
				};
				rollbackPointLoad = rollback;
				let cleanupFailed = false;
				const reportLoadCleanupError = (error: unknown): void => {
					cleanupFailed = true;
					reportPointCleanupError(error);
					if (generation === pointLoadGeneration && !pointDisposed) {
						setPointPanelState("error", "释放失败", "点资源清理失败，请查看诊断日志。");
					}
				};
				unloadPointsButton.disabled = false;
				loadPointsButton.disabled = true;
				pointDatasetSelect.disabled = true;
				performanceMonitor.resetFrameSamples();
				clearPointMetrics();
				pointCount.textContent = selectedEntry.pointCount.toLocaleString();
				pointMemory.textContent = `${formatBytes(selectedEntry.byteLength)} / —`;
				setPointPanelState(
					"busy",
					"加载中",
					`Worker 正在读取 ${selectedEntry.label}，确认新图层后再替换已有点数据…`
			);

				try {
					const { dataset: loaded, renderer: nextRenderer } = await preparePointLayer({
						viewer,
						entry: selectedEntry,
						signal: abortController.signal,
						resolveUrl: () => resolvePointDatasetUrl(
							selectedEntry.url,
							DATA_URLS.pointManifest,
							DATA_URLS.pointManifestAccessToken,
						),
						readCommittedFrame: readCommittedPointFrame,
						onUploading: () => { if (isCurrent()) setPointPanelState("busy", "上传中", "二进制解析完成，正在创建单个 GPU 顶点缓冲区…"); },
						onCleanupError: reportLoadCleanupError,
						onCleanupPending: resource => {
							pointResourcesToRelease.add({ renderer: resource });
							if (!pointDisposed) {
								loadPointsButton.disabled = true;
								unloadPointsButton.disabled = false;
								if (!pointLoadInFlight) setPointPanelState("error", "释放失败", "部分点资源释放失败，请卸载以重试；详情见诊断日志。");
							}
						},
						releaseRenderer: renderer => { releasePointResources({ renderer }); },
					});
					candidate.renderer = nextRenderer;
					if (generation !== pointLoadGeneration || pointDisposed || abortController.signal.aborted) {
						releasePointResources(candidate);
						throw abortController.signal.reason instanceof OperationInterruptedError
							? abortController.signal.reason : new OperationInterruptedError("superseded");
					}

					invalidateActiveTimeLayers?.();
					activated = true;
					pointRenderer = nextRenderer;
					pointPicker = undefined;
					previous.renderer?.setShow(false);
					if (loaded.header.pointCount <= MAX_PICKABLE_POINT_COUNT) {
						candidate.picker = new PointPicker(loaded);
					}
					const installFrame = configurePointFrame(nextRenderer);
					await waitForPointLayerFrame(viewer, nextRenderer, {
						...installFrame, signal: abortController.signal, isCurrent,
					});
					if (!isCurrent() || abortController.signal.aborted || !nextRenderer.matchesFrameState(installFrame.timeMa, installFrame.show)) {
						throw abortController.signal.reason instanceof OperationInterruptedError
							? abortController.signal.reason : new OperationInterruptedError("superseded");
					}
					// The previous source stays authoritative until the candidate's
					// actual native frame succeeds. Retirement is after this commit.
					committed = true;
					rollbackPointLoad = undefined;
					loadedPointEntry = selectedEntry;
					loadedPointDataset = loaded;
					pointPicker = candidate.picker;
					reconcileFeatureSelection();
					releasePointResources(previous);
					pointCount.textContent = selectedEntry.pointCount.toLocaleString();
					updateVisiblePointCount(projectionController?.getSnapshot().committedTimeMa ?? initialAgeMa);
					pointMemory.textContent = `${formatBytes(
						selectedEntry.byteLength,
					)} / ${formatBytes(nextRenderer.buildStats.gpuVertexBytes)}`;
					pointLoadTime.textContent = `${formatDuration(loaded.timings.totalMs)}${
						loaded.timings.cacheHit ? " cache" : ""
					} / ${formatDuration(nextRenderer.buildStats.uploadMs)}`;
					unloadPointsButton.disabled = false;
					const datasetNote =
						selectedEntry.generation === "deterministic_repeat"
							? `（${selectedEntry.uniqueSourcePointCount.toLocaleString()} 个真实点确定性复用）`
							: "";
					const pickingNote = pointPicker
						? "点击点可按 row ID 查看属性。"
						: `超过 ${MAX_PICKABLE_POINT_COUNT.toLocaleString()} 点，拾取等待空间索引。`;
					setPointPanelState(
						"ready",
						"运行中",
						`${selectedEntry.label} 已加载 ${datasetNote}；${pickingNote}`,
					);
				} catch (error) {
					if (generation !== pointLoadGeneration) {
						throw abortController.signal.reason instanceof OperationInterruptedError
							? abortController.signal.reason : new OperationInterruptedError("superseded");
					}
					const needsRecoveryFrame = activated;
					rollback();
					if (needsRecoveryFrame && isCurrent() && !rollbackError) {
						try {
							const recoveryFrame = previous.renderer ? configurePointFrame(previous.renderer)
								: { timeMa: readCommittedPointFrame().timeMa, show: false };
							await waitForPointLayerFrame(viewer, previous.renderer, {
								...recoveryFrame, isCurrent: () => isCurrent() && pointRenderer === previous.renderer,
							});
						} catch (recoveryError) { rollbackError = recoveryError; }
					}
					if (!isCurrent()) throw new OperationInterruptedError("superseded");
					cleanupFailed = hasPendingPointRelease() || cleanupFailed;
					if (rollbackError) {
						setPointPanelState("error", "恢复失败", "旧点图层未能确认恢复，详情见诊断日志；可卸载后重试。");
						throw new AggregateError([error, rollbackError], "Point layer replacement and recovery failed.");
					}
					if (error instanceof OperationInterruptedError || (error instanceof DOMException && error.name === "AbortError")) {
						setPointPanelState(
							cleanupFailed ? "error" : "ready",
							cleanupFailed ? "释放失败" : "已取消",
							cleanupFailed ? "加载已取消，但部分点资源清理失败，请查看诊断日志。" : "点数据加载已取消。",
						);
						throw error instanceof OperationInterruptedError ? error : new OperationInterruptedError("cancelled");
					}
					setPointPanelState(
						"error",
						"失败",
						error instanceof Error ? error.message : String(error),
					);
					// Re-raised so an automated caller sees the failure instead of a
						// success; the panel above is the human-readable form of it.
					throw error;
				} finally {
					signal?.removeEventListener("abort", abort);
					if (generation === pointLoadGeneration) {
						rollbackPointLoad = undefined;
						pointLoadAbortController = undefined;
						pointLoadInFlight = false;
						unloadPointsButton.disabled = !loadedPointEntry && !hasPendingPointRelease();
						loadPointsButton.disabled = hasPendingPointRelease();
						pointDatasetSelect.disabled = false;
						agentActions.notifyStateChanged("points");
					}
				}
			};
			loadPointsButton.addEventListener("click", () => {
				// The load owner publishes its panel state. An old action's late
				// cancellation must not overwrite a replacement/unload operation.
				void agentActions.execute(AGENT_ACTIONS.pointsLoad);
			});
			manifestStatus.points = "ready";
		} catch (error) {
			if (manifestAbort.signal.aborted) return;
			manifestStatus.points = "error";
			reportManifestFailure("points", error);
			pointDatasetSelect.disabled = true;
			loadPointsButton.disabled = true;
			setPointPanelState(
				"error",
				"数据缺失",
				error instanceof Error ? error.message : String(error),
			);
		} finally {
			if (!manifestAbort.signal.aborted) {
				agentActions.notifyStateChanged("startupResources");
				agentActions.notifyStateChanged("points");
			}
		}
	};

	window.setInterval(() => {
		if (!pointRenderer) {
			return;
		}
		const snapshot = performanceMonitor.snapshot();
		pointFps.textContent =
			snapshot.fps === undefined
				? "等待播放"
				: `${snapshot.fps.toFixed(1)} fps`;
		pointFrameP95.textContent =
			snapshot.frameP95Ms === undefined
				? "—"
				: `${snapshot.frameP95Ms.toFixed(1)} ms`;
		pointLatency.textContent =
			snapshot.interactionLatencyMs === undefined
				? "—"
				: `${snapshot.interactionLatencyMs.toFixed(1)} ms`;
		pointJsHeap.textContent = formatBytes(snapshot.usedJsHeapBytes);
	}, 400);

	// ---------------------------------------------------------------------------
	// Frontend action facade. The buttons above and `window.timeMachineAgent`
	// dispatch through the same handlers, so validation and async completion are
	// defined once. Nothing here synthesizes DOM clicks.
	// ---------------------------------------------------------------------------
	const registerRenderAgentActions = (): void => {
		registerSelectionActions(featureSelection!, selectionPorts);
		registerStateSection("selection", () => ({ ...featureSelection!.snapshot() }));
		registerLayerStyleAction(projectSession, layerController, id => {
			const state = nativePointRuntime?.get(id);
			if (state?.cleanupPending || state?.runtimeStatus === "removing") {
				throw new AgentActionBusyError("Finish or retry point layer removal before editing its style.");
			}
		});
		const layerInstanceActions = registerLayerInstanceActions(projectSession, {
			assertCanAdd: assertNativePointAddAllowed,
			load: (id, sourceRef, signal) => projectSession.getLayer(id)?.type === ProjectLayerType.Raster
				? loadRasterInstance(id, sourceRef, signal) : projectSession.getLayer(id)?.type === ProjectLayerType.Atlas
					? loadAtlasInstance(id, sourceRef, signal) : loadNativePointInstance(id, sourceRef, signal),
			remove: (id, cancelledLoad) => projectSession.getLayer(id)?.type === ProjectLayerType.Raster
				? removeRasterInstance(id, cancelledLoad) : projectSession.getLayer(id)?.type === ProjectLayerType.Atlas
					? removeAtlasInstance(id, cancelledLoad) : removeNativePointInstance(id, cancelledLoad),
			publish: publishNativePointState,
			persist: persistLayerEdit,
			retry: retryLayerInstance,
		});
		isLayerRetrying = layerInstanceActions.isRetrying;
		registerLayerGroupActions(projectSession, layerController, (groupId, parentId) => {
			projectionController?.assertLayerMutationAllowed(
				projectSession.layerList,
				projectSession.groupList.map(group => group.id === groupId ? { ...group, parentId } : group),
			);
		});
		const ready = (
			id: (typeof AGENT_ACTIONS)[keyof typeof AGENT_ACTIONS],
			handler: Parameters<typeof agentActions.register>[1],
		) => {
			agentActions.register(AGENT_DECLARATIONS[id], handler);
		};

		ready(
			AGENT_ACTIONS.timeSet,
			async (params, context) => {
				if (context?.signal?.aborted) throw new OperationInterruptedError("cancelled");
				const ageMa = params.ageMa as number;
				if (ageMa < timeline.minAgeMa || ageMa > timeline.maxAgeMa) {
					throw new AgentActionValidationError(
						`ageMa must be within [${timeline.minAgeMa}, ${timeline.maxAgeMa}].`,
					);
				}
				// Pause first, exactly like the slider and quick-age buttons, so a
					// running animation cannot immediately overwrite the new age.
				timeline.setPlaying(false);
				timeline.setAge(ageMa, context?.signal);
				// The same UI queue now waits for all captured time layers to commit.
				await timelineFrame;
				return {
					data: {
						ageMa,
						committedAgeMa:
						projectionController?.getSnapshot().committedTimeMa ?? ageMa,
					},
				};
			}
		);
		ready(
			AGENT_ACTIONS.timeSetPlaying,
			(params) => {
				timeline.setPlaying(params.playing === true);
				return { data: { playing: timeline.playing } };
			}
		);
		ready(
			AGENT_ACTIONS.timeSetSpeed,
			(params) => {
				const speed = params.speedMaPerSecond as number;
				if (!Number.isFinite(speed) || speed <= 0) {
					throw new AgentActionValidationError(
						"speedMaPerSecond must be a positive number.",
					);
				}
				timeline.setSpeedMaPerSecond(speed);
				// The timeline only offers discrete presets, so the effective value
					// is reported back rather than the requested one.
				return {
					data: {
						speedMaPerSecond: timeline.speedMaPerSecond,
						requestedSpeedMaPerSecond: speed,
					},
				};
			}
		);
		ready(AGENT_ACTIONS.cameraZoom, (params) => {
			if (!projectionController) throw new AgentActionUnsupportedError("Camera runtime unavailable.");
			return { data: projectionController.zoom(params.factor) };
		});
		ready(AGENT_ACTIONS.cameraPan, (params) => {
			if (!projectionController) throw new AgentActionUnsupportedError("Camera runtime unavailable.");
			return { data: projectionController.pan(params.deltaX, params.deltaY) };
		});
		for (const id of [AGENT_ACTIONS.cameraZoom, AGENT_ACTIONS.cameraPan]) {
			agentActions.setAvailability(id, () => {
				if (!projectionController) return "Camera runtime unavailable.";
				return projectionController.sceneMode === "globe"
					? "Programmatic pan/zoom currently support flat projections only."
					: undefined;
			});
		}
		ready(AGENT_ACTIONS.cameraReset, async (_params, context) => {
			if (!projectionController) throw new AgentActionUnsupportedError("Camera runtime unavailable.");
			if (plateModelSourceRef(resolvePlateModelSource(phase1BCloudClient.snapshot.selection)) !== loadedPlateSourceRef) {
				throw new AgentActionUnsupportedError("Reload the selected plate model before resetting its camera.");
			}
			if (projectionController.getSnapshot().status === "preparing") {
				throw new AgentActionBusyError("Wait for the current view to finish before resetting its camera.");
			}
			cancelGlobeMomentum.get(viewer)?.();
			await cameraResetCompletion.run(callbacks => {
				if (projectionController!.sceneMode === "globe") setCameraHome(viewer, callbacks);
				else {
					projectionController!.home();
					callbacks.complete();
				}
			}, { signal: context?.signal });
			return { data: { projectionId: projectionController.sceneMode, camera: {
				position: [viewer.camera.positionWC.x, viewer.camera.positionWC.y, viewer.camera.positionWC.z],
				direction: [viewer.camera.directionWC.x, viewer.camera.directionWC.y, viewer.camera.directionWC.z],
				up: [viewer.camera.upWC.x, viewer.camera.upWC.y, viewer.camera.upWC.z],
			} } };
		});

		// --- Projection ------------------------------------------------------
		// The UI select and this action share one handler, so a programmatic
		// switch behaves exactly like picking the option.
		ready(AGENT_ACTIONS.projectionSelect, async (params, context) => {
			const projectionId = params.projectionId as string;
			if (projectSession.layerList.some(layer => isLayerRetrying(layer.id))) throw new AgentActionBusyError("Wait for layer retry to finish before changing projection.");
			if (!projectionController) {
				throw new AgentActionUnsupportedError(
					"The projection runtime is not initialized yet.",
				);
			}
			const result = await projectionController.select(projectionId, { signal: context?.signal });
			return {
				data: {
					projectionId: result.projectionId,
					revision: result.revision,
				},
			};
		});

		// --- Layer edits -----------------------------------------------------
		// Every one of these goes through the LayerController, which is the same
		// code the sidebar UI events use: native controls, renderers, imagery
		// order, sidebar state and persistence all follow.
		ready(
			AGENT_ACTIONS.layerVisibility,
			(params) => {
				const layerId = params.layerId as number;
				const active = params.active === true;
				// Rectangle cannot render points/raster/atlas, so turning one on while
				// it is committed (or pending) is refused here - the same guard the
				// sidebar path uses - instead of silently showing a mis-projected layer.
				guardLayerVisibility(layerId, active);
				layerController.setLayerVisibility(layerId, active);
				return {
					data: {
						active,
						layerId,
						effective: projectSession.getEffectiveLayerVisibility(layerId),
					},
				};
			}
		);
		ready(
			AGENT_ACTIONS.layerOpacity,
			(params) => {
				const layerId = params.layerId as number;
				const alpha = params.alpha as number;
				layerController.setLayerOpacity(layerId, alpha);
				return {
					data: {
						alpha,
						layerId,
						effective: projectSession.getEffectiveLayerOpacity(layerId),
					},
				};
			}
		);
		ready(
			AGENT_ACTIONS.layerGroupVisibility,
			(params) => {
				const groupId = params.groupId as number;
				const active = params.active === true;
				// Re-showing a group can make an incompatible child effective-visible;
				// refuse before applying, exactly like the sidebar path.
				guardGroupVisibility(groupId, active);
				layerController.setGroupVisibility(groupId, active);
				return { data: { active, groupId, effective: projectSession.getEffectiveGroupVisibility(groupId) } };
			}
		);
		ready(
			AGENT_ACTIONS.layerGroupOpacity,
			(params) => {
				const groupId = params.groupId as number;
				const alpha = params.alpha as number;
				layerController.setGroupOpacity(groupId, alpha);
				return {
					data: {
						alpha,
						groupId,
						effective: projectSession.getEffectiveGroupOpacity(groupId),
					},
				};
			}
		);
		ready(
			AGENT_ACTIONS.layerGroupCollapse,
			(params) => {
				const groupId = params.groupId as number;
				const collapsed = params.collapsed === true;
				layerController.setGroupCollapsed(groupId, collapsed);
				return { data: { collapsed, groupId } };
			}
		);
		ready(
			AGENT_ACTIONS.layerMoveToGroup,
			(params) => {
				const layerId = params.layerId as number;
				const groupId = params.groupId as number;
				// Moving an active incompatible layer into a visible group would show it.
				guardLayerGroup(layerId, groupId);
				layerController.setLayerGroup(layerId, groupId);
				return { data: { groupId, layerId } };
			}
		);
		ready(
			AGENT_ACTIONS.layerOrder,
			(params) => {
				const orderedIds = params.orderedIds;
				if (
					!Array.isArray(orderedIds) ||
					orderedIds.some((id) => typeof id !== "number")
				) {
					throw new AgentActionValidationError(
						"layer.setOrder requires a numeric 'orderedIds' array.",
					);
				}
				const groupIdByLayer = params.groupIdByLayer as
					| Record<string, number>
					| undefined;
				// A reorder that also moves a layer into a visible group can show an
				// incompatible layer; guard the same way before applying.
				guardOrder(groupIdByLayer);
				layerController.setOrder(orderedIds as number[], groupIdByLayer);
				return {
					data: {
						orderedIds: projectSession.layerList.map((layer) => layer.id),
						groupIdByLayer: Object.fromEntries(
							projectSession.layerList.map((layer) => [
								layer.id,
								layer.groupId,
							]),
						),
					},
				};
			}
		);

		// --- Points ----------------------------------------------------------
		ready(
			AGENT_ACTIONS.pointsLoad,
			async (_params, context) => {
				if (!pointManifestRef) {
					throw new AgentActionUnsupportedError(
						"The point dataset manifest is not available in this build.",
					);
				}
				if (!loadSelectedPointDataset) {
					throw new AgentActionUnsupportedError(
						"The point dataset manifest is not ready yet.",
					);
				}
				// Awaited: a network or GPU failure rejects here instead of being
					// reported as a success.
				await loadSelectedPointDataset(context?.signal);
				return {
					data: {
						datasetId: loadedPointEntry?.id ?? "",
						loaded: Boolean(loadedPointEntry),
						selectedDatasetId: pointDatasetSelect.value,
						frameConfirmed: true,
					},
				};
			},
		);
		ready(
			AGENT_ACTIONS.pointsSelectDataset,
			async (params, context) => {
				const datasetId = params.datasetId as string;
				await selectLocalPointDataset(datasetId, params.load === true, context?.signal);
				// `loaded` is about the dataset that was just selected, not about
				// whichever dataset happens to be in GPU memory.
				return {
					data: {
						datasetId,
						loaded: loadedPointEntry?.id === datasetId,
						loadedDatasetId: loadedPointEntry?.id ?? "",
						selectedDatasetId: pointDatasetSelect.value,
						frameConfirmed: params.load === true,
					},
				};
			},
		);
		ready(
			AGENT_ACTIONS.pointsSetSize,
			(params) => {
				const pixels = setPointSizePixels(params.pointSize as number);
				// The stored size, not the requested one, so an accepted call can
				// never report a value the session does not hold.
				return { data: { pointSize: pixels } };
			},
		);
		ready(
			AGENT_ACTIONS.pointsSetStyle,
			(params) => {
				const style = params.style as Record<string, unknown>;
				layerController.setPointStyle(RUNTIME_LAYER_IDS.points, {
					...normalizePointStyleExpression(
						projectSession.getLayer(RUNTIME_LAYER_IDS.points)?.pointStyle,
					),
					...style,
					filter: {
						...normalizePointStyleExpression(
						projectSession.getLayer(RUNTIME_LAYER_IDS.points)?.pointStyle,
						).filter,
						...((style.filter as Record<string, unknown>) ?? {}),
					},
				} as PointStyleExpression);
				return {
					data: {
						style: projectSession.getLayer(RUNTIME_LAYER_IDS.points)
							?.pointStyle ?? null,
					},
				};
			},
		);
		ready(AGENT_ACTIONS.pointsUnload, () => {
			if (!unloadPointDataset()) throw new Error("点资源释放失败，请再次卸载以重试。");
			return {};
		});

		// --- Raster and project metadata -------------------------------------
		ready(
			AGENT_ACTIONS.rasterSelect,
			async (params, context) => {
				const rasterId = params.rasterId as string;
				const layerId = params.layerId === undefined ? RUNTIME_LAYER_IDS.raster : params.layerId as number;
				const result = await selectSingleRaster(rasterId, context?.signal, layerId);
				return { data: { layerId, rasterId, selection: result } };
			},
		);
		ready(
			AGENT_ACTIONS.projectSetName,
			(params) => {
				const name = params.name as string;
				if (!name.trim()) {
					throw new AgentActionValidationError(
						"project.setName requires a non-empty name.",
					);
				}
				setProjectName(name);
				return { data: { name: projectSession.projectName } };
			},
		);
		for (const id of [AGENT_ACTIONS.pointsLoad, AGENT_ACTIONS.pointsSelectDataset]) {
			agentActions.setAvailability(id, () => pointManifestRef
				? undefined : "The point dataset manifest is not available yet.");
		}
		agentActions.setAvailability(AGENT_ACTIONS.rasterSelect, () => rasterManifest
			? undefined : "The raster manifest is not available yet.");

		// --- Cloud projects (V2 only) ----------------------------------------
		ready(AGENT_ACTIONS.projectOpen, async params => {
			requireV2Workspace(phase1BCloudClient.snapshot.v2WorkspaceAvailable, "cloud projects");
			if (!phase1BCloudClient.snapshot.account) throw new AgentActionAuthError("Sign in before opening a cloud project.");
			const revisionId = params.revisionId as number;
			const project = phase1BCloudClient.snapshot.projects.find(item => Number(item.Revision.Value) === revisionId);
			if (!project) throw new AgentActionValidationError(`Unknown project revision ${revisionId}. Refresh the project catalog.`);
			window.clearTimeout(cloudAutosaveTimer);
			const opened = await phase1BCloudClient.openProject(project, (document, original) => {
				const session = ProjectSession.fromDocument(document);
				if (session.isReadOnly) {
					reviewedProject = { name: session.projectName, compatibility: session.compatibilityReport, original };
					publishProjectState();
					throw new AgentActionUnsupportedError("This cloud project requires compatibility review. Review the report and download its original input.");
				}
				return session.serializeLocalDraft();
			});
			reviewedProject = undefined;
			window.setTimeout(() => window.location.reload(), 0);
			return { reloadRequired: true, data: { revisionId: opened.reference.revisionId, contextId: opened.contextId } };
		});
		// Registered here rather than in the sidebar so the handler is the real
			// async save the Save button uses. Availability is evaluated live from
			// the capability handshake, so a V1-only Server answers `unsupported`
			// while a V2 Server whose handshake finished after mount still gets the
			// real save.
		ready(
			AGENT_ACTIONS.projectSave,
			async () => {
				requireV2Workspace(
					phase1BCloudClient.snapshot.v2WorkspaceAvailable,
					"cloud projects",
				);
				if (!phase1BCloudClient.snapshot.account) {
					throw new AgentActionAuthError(
						"Sign in before saving a cloud project.",
					);
				}
				return saveProjectToCloud();
			},
		);
		agentActions.setAvailability(AGENT_ACTIONS.projectSave, () =>
			phase1BCloudClient.snapshot.v2WorkspaceAvailable
				? undefined
				: "This Server does not implement the TimeMachine V2 workspace endpoints, so cloud projects cannot be saved.",
		);
		agentActions.setAvailability(AGENT_ACTIONS.projectOpen, () => phase1BCloudClient.snapshot.v2WorkspaceAvailable
			? undefined : "This Server does not implement the TimeMachine V2 workspace endpoints, so cloud projects cannot be opened.");

		// --- State sections -------------------------------------------------
		// Only bounded scalars: no feature arrays, no GPU objects, no Cesium
		// primitives. `gpmlParseResult.features` can hold tens of thousands of
		// entries and must never be walked into a snapshot.
		registerStateSection("time", () => ({
			ageMa: timeline.currentAgeMa,
			playing: timeline.playing,
			speedMaPerSecond: timeline.speedMaPerSecond,
		}));
		registerStateSection("plateModel", () => ({
			featureCount: gpmlParseResult.features.length,
			loadError: plateModelLoadError,
			loadStatus: plateModelLoadError
				? "error"
				: plateModelSource.kind === "none"
					? "idle"
					: "ready",
			loadedModelId:
				plateModelSource.kind === "shared" ? plateModelSource.plateModelId : 0,
			loadedModelName: loadedPlateModelLabel,
			loadedSource: plateModelSource.kind,
			polygonCount: gpmlParseResult.polygonCount,
			rotationSequenceCount: rotationParseResult.sequences.length,
			unsupportedGeometryCount: gpmlParseResult.unsupportedGeometryCount,
		}));
		registerStateSection("layers", () => ({
			groups: projectSession.groupList.map((group) => ({
				active: group.active,
				alpha: group.alpha,
				collapsed: group.collapsed,
				id: group.id,
				name: group.name,
				...(group.parentId === undefined ? {} : { parentId: group.parentId }),
				effectiveVisible: projectSession.getEffectiveGroupVisibility(group.id),
				effectiveAlpha: projectSession.getEffectiveGroupOpacity(group.id),
			})),
			layers: projectSession.layerList.map((layer) => ({
				active: layer.active,
				alpha: layer.alpha,
				id: layer.id,
				name: layer.name,
				groupId: layer.groupId,
				sourceRef: layer.sourceRef,
				type: layer.type,
				...(layer.type === ProjectLayerType.Atlas ? {
					// Keep frame fields flat within the layer's state: nested frame
					// objects exceed the bounded public snapshot's redaction depth.
					atlasState: (() => {
						const state = atlasStateSummary(layer.id);
						return state ? { status: state.status, requestedAgeMa: state.requestedAgeMa,
							frameTimeMa: state.frame?.timeMa ?? null, frameSourceId: state.frame?.sourceId ?? null,
							frameLabel: state.frame?.label ?? null, committedFrameTimeMa: state.committedFrame?.timeMa ?? null,
							committedSourceId: state.committedFrame?.sourceId ?? null, committedFrameLabel: state.committedFrame?.label ?? null,
							...(state.reason ? { reason: state.reason } : {}) } : undefined;
					})(), effectiveVisible: projectSession.getEffectiveLayerVisibility(layer.id),
					effectiveAlpha: projectSession.getEffectiveLayerOpacity(layer.id),
				} : {}),
				...(layer.type === ProjectLayerType.Raster ? { ...(layer.rasterId === undefined ? {} : { rasterId: layer.rasterId }),
					committedRasterId: rasterControllers.get(layer.id)?.getCommittedRaster()?.id ?? null,
					requestedRasterId: rasterStates.get(layer.id)?.raster?.id ?? null,
					effectiveVisible: projectSession.getEffectiveLayerVisibility(layer.id),
					effectiveAlpha: projectSession.getEffectiveLayerOpacity(layer.id) } : {}),
				...instanceRuntimeState(layer.id),
				...(![ProjectLayerType.Point, ProjectLayerType.Line, ProjectLayerType.Polygon].includes(layer.type) || (Object.values(RUNTIME_LAYER_IDS) as number[]).includes(layer.id) ? {} : {
					positionMode: "source-coordinates", reconstructionSupported: false,
					displayOffsetMetres: NATIVE_VECTOR_DISPLAY_OFFSET_METRES,
					effectiveVisible: projectSession.getEffectiveLayerVisibility(layer.id),
					effectiveAlpha: projectSession.getEffectiveLayerOpacity(layer.id),
				}),
			})),
		}));
		registerStateSection("points", () => ({
			datasetId: loadedPointEntry?.id ?? "",
			loaded: Boolean(loadedPointEntry),
			selectedDatasetId: pointDatasetSelect.value,
			loading: pointLoadInFlight,
			status: pointStatus.dataset.state ?? "idle",
		}));
		registerStateSection("atlas", () => {
			const state = atlasRuntimeState;
			const loadError = atlasErrors.get(RUNTIME_LAYER_IDS.atlas);
			const committed = atlasController?.getCommittedFrame();
			return {
				status: loadError ? "error" : state?.status ?? (atlasInitializationError ? "error" : "idle"),
				requestedAgeMa: state?.requestedAgeMa ?? timeline.currentAgeMa,
				frame: state && "frame" in state && state.frame ? {
					sourceId: state.frame.sourceId,
					timeMa: state.frame.timeMa,
					label: state.frame.label,
				} : null,
				committedFrame: committed ? {
					sourceId: committed.sourceId,
					timeMa: committed.timeMa,
					label: committed.label,
				} : null,
				...(state?.status === "hidden" ? { reason: state.reason } : {}),
				...(loadError ? { message: loadError } : state?.status === "error" ? { message: state.message }
					: atlasInitializationError ? { message: atlasInitializationError } : {}),
			};
		});
		registerStateSection("raster", () => {
			const state = singleRasterRuntimeState;
			const loadError = rasterErrors.get(RUNTIME_LAYER_IDS.raster);
			const committed = singleRasterController?.getCommittedRaster();
			const brief = (entry?: SingleRasterEntry) => entry ? { id: entry.id, sourceId: entry.sourceId, label: entry.label } : null;
			return {
				status: loadError ? "error" : state?.status ?? (singleRasterInitializationError ? "error" : "unavailable"),
				requestedRaster: brief(state?.raster), committedRaster: brief(committed),
				...(loadError ? { message: loadError } : state?.status === "error" ? { message: state.message }
					: singleRasterInitializationError ? { message: singleRasterInitializationError } : {}),
			};
		});
		registerStateSection("projection", () => {
			const snapshot = projectionController?.getSnapshot();
			if (!snapshot) {
				return { status: "idle" };
			}
			return {
				camera: {
					...snapshot.camera,
					position: [viewer.camera.positionWC.x, viewer.camera.positionWC.y, viewer.camera.positionWC.z],
					direction: [viewer.camera.directionWC.x, viewer.camera.directionWC.y, viewer.camera.directionWC.z],
					up: [viewer.camera.upWC.x, viewer.camera.upWC.y, viewer.camera.upWC.z],
				},
				availableModes: snapshot.availableModes,
				committedId: snapshot.committedId,
				committedTimeMa: snapshot.committedTimeMa,
				committedTimeState: snapshot.committedTimeState,
				lastError: snapshot.lastError ?? null,
				requestedId: snapshot.requestedId,
				requestedTimeMa: snapshot.requestedTimeMa,
				revision: snapshot.revision,
				status: snapshot.status,
			};
		});
	};
	// Follow the current view without submitting another time request. Early UI
	// changes may replace a pending request while the startup overlay is visible.
	const initialProjectionController = projectionController;
	await confirmStartupView(viewer.scene, () => initialProjectionController.getSnapshot(), (state) => {
		if (state.committedId !== "globe") return;
		if (viewer.scene.mode !== SceneMode.SCENE3D) throw new Error("The initial committed Globe view does not match the scene mode.");
		currentTimeState = renderer.updateTime(state.committedTimeMa, rotationModel);
		pointRenderer?.setTime(state.committedTimeMa, currentTimeState.rotationMap);
	}, startupFrameAbort.signal);
	registerRenderAgentActions();
	// Restore explicit ordinary-vector references after the core view and API.
	// Unsupported sources stay visible as error records; they never fall back.
	for (const layer of projectSession.layerList) {
		if (![ProjectLayerType.Point, ProjectLayerType.Line, ProjectLayerType.Polygon].includes(layer.type) || (Object.values(RUNTIME_LAYER_IDS) as number[]).includes(layer.id)) continue;
		void loadNativePointInstance(layer.id, layer.sourceRef).catch(() => undefined);
	}
	// Fetches already run in parallel. Attach optional resources only after the
	// core frame: an early pending time must not acquire a new, still-loading
	// Atlas as a prerequisite for registering the core API and finishing startup.
	void initializeAtlas();
	void initializeSingleRaster();
	void initializePoints();

	loadingTitle.textContent = "核心视图就绪";
	loadingDetail.textContent = `${loadedPlateModelLabel} · ${
		gpmlParseResult.features.length
	} 个要素，${rotationParseResult.sequences.length} 条旋转序列${
		plateModelLoadError ? `；加载失败：${plateModelLoadError}` : ""
	}。`;
	loadingProgress.style.width = "100%";
	loadingOverlay.classList.add("is-complete");
	viewer.scene.requestRender();
}

main().catch((error: unknown) => {
	agentActions.diagnostics.record({
		level: "error", category: "app", event: "app.initialization-failed", outcome: "failed",
		error: error instanceof Error ? error : { message: "Application initialization failed." },
	});
	const loadingTitle = document.querySelector("#loading-title");
	const loadingDetail = document.querySelector("#loading-detail");
	const loadingOverlay = document.querySelector("#loading-overlay");
	loadingTitle && (loadingTitle.textContent = "重建初始化失败");
	loadingDetail &&
		(loadingDetail.textContent =
			error instanceof Error ? error.message : String(error));
	loadingOverlay?.classList.add("has-error");
	console.error("TimeMachine initialization failed. Inspect the local diagnostics.");
});
