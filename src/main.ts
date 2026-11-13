import {
  Cartesian2,
  Cartesian3,
  Color,
  GeographicProjection,
  Matrix4,
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
	loadPointDataset,
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
	type PaleoAtlasRuntimeState,
	type SingleRasterEntry,
	type SingleRasterRuntimeState,
} from "@timemachine/raster-runtime";
import { GeologicalTimeline } from "./ui/geological-timeline";
import { PerformanceMonitor } from "./ui/performance-monitor";
import { bootstrapTimeMachinePlatform } from "./platform-bootstrap";
import {
	phase1BCloudClient,
	type RuntimeDataUrlOverrides,
} from "./phase1b/cloud-client";
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
import { ProjectSession, RUNTIME_LAYER_IDS } from "./project/project-session";
import { LayerController } from "./layers/layer-controller";
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
import { SystemOpenAPIInvoker } from "@timemachine/generated-api";
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

function setCameraHome(viewer: Viewer): void {
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
		if (event.button !== 0 || !event.isPrimary) {
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
		() => {
			window.clearTimeout(settleTimer);
			stopMomentum();
			canvas.removeEventListener("pointerdown", handlePointerDown);
			canvas.removeEventListener("wheel", handleWheel);
			window.removeEventListener("pointermove", handlePointerMove);
			window.removeEventListener("pointerup", handlePointerUp);
			window.removeEventListener("pointercancel", handlePointerCancel);
		},
		{ once: true },
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

async function fetchJson<T>(url: string): Promise<T> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`${url} 加载失败（HTTP ${response.status}）`);
	}
	return response.json() as Promise<T>;
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
	createApp(AppShell).mount("#app");
	await nextTick();

	const platformBootstrap = bootstrapTimeMachinePlatform().catch((error) => {
		console.warn("TimeMachine platform capability handshake failed.", error);
		return undefined;
	});
	const phase1BInitialization = phase1BCloudClient
		.initialize()
		.catch((error) => {
			console.warn("TimeMachine Phase 1B initialization failed.", error);
			return phase1BCloudClient.snapshot;
		});
	await phase1BInitialization;

	// Only the V2 manifest overrides are resolved, and only when V2 is actually
	// available. A missing V2 endpoint is not an error for the shared plate
	// model path, which never reads these URLs.
	let runtimeUrlOverrides: RuntimeDataUrlOverrides = {};
	if (phase1BCloudClient.snapshot.v2WorkspaceAvailable) {
		try {
			runtimeUrlOverrides =
				await phase1BCloudClient.resolveSelectedRuntimeUrls();
		} catch (error) {
			console.warn(
				"Selected versioned resource could not be loaded; using local compatibility data.",
				error
		);
			window.dispatchEvent(
				new CustomEvent("timemachine:project-save-error", {
					detail: {
						message:
							error instanceof Error ? error.message : String(error),
					},
				})
		);
		}
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

	let projectSession: ProjectSession;
	try {
		projectSession =
			ProjectSession.restore(window.localStorage) ?? new ProjectSession();
	} catch (error) {
		console.warn("Stored TimeMachine project draft was ignored.", error);
		projectSession = new ProjectSession();
	}
	projectName.value = projectSession.projectName;
	window.addEventListener("timemachine:cloud-project-open", (event: Event) => {
		try {
			const detail = (
				event as CustomEvent<{
					document: Parameters<typeof ProjectSession.fromDocument>[0];
				}>
			).detail;
			const openedSession = ProjectSession.fromDocument(detail.document);
			openedSession.save(window.localStorage);
			window.location.reload();
		} catch (error) {
			window.dispatchEvent(
				new CustomEvent("timemachine:project-save-error", {
					detail: {
						message: error instanceof Error ? error.message : String(error),
					},
				})
		);
		}
	});
	const initialAgeMa = Math.min(538.8, projectSession.timeMa);
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
	const applyLayerState = (): void => {
		window.dispatchEvent(
			new CustomEvent(LAYER_STATE_EVENT, {
				detail: {
					groups: projectSession.groupList,
					layers: projectSession.layerList,
				},
			}),
		);
	};
	applyLayerState();

	loadingProgress.style.width = "8%";
	const pointManifestPromise = fetchJson<PointFixtureManifest>(
		DATA_URLS.pointManifest,
	);
	const atlasManifestPromise = fetchJson<unknown>(DATA_URLS.atlasManifest).then(
		parsePaleoAtlasManifest,
	);
	const singleRasterManifestPromise = fetchJson<unknown>(
		DATA_URLS.singleRasterManifest,
	).then(parseSingleRasterManifest);

	// ---------------------------------------------------------------------------
	// Plate model source.
	//
	// Three explicit sources and no implicit fallback between them: a shared
	// (V1) model that fails to load surfaces its own error, an unselected model
	// yields an empty but fully usable globe, and the local PALEOMAP demo is
	// reachable only after the user explicitly picks it in the Plate Model tab.
	// ---------------------------------------------------------------------------
	const plateModelStatus = requiredElement("#plate-model-status", HTMLElement);
	const sharedSelection = phase1BCloudClient.snapshot.selection;
	const serverUrl = phase1BCloudClient.snapshot.serverUrl;
	const sharedPlateClient = new SharedPlateModelClient({
		baseUrl: serverUrl,
		getAccessToken: () =>
			window.sessionStorage.getItem(TIME_MACHINE_ACCESS_TOKEN_KEY),
	});

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
	const restoredCamera = projectSession.cameraSnapshot;
	if (restoredCamera) {
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
	let currentTimeState: RenderTimeState = renderer.updateTime(
		initialAgeMa,
		rotationModel,
	);
	let pointRenderer: GpuPointRenderer | undefined;
	let pointPicker: PointPicker | undefined;
	let loadedPointDataset: LoadedPointDataset | undefined;
	let loadedPointEntry: PointDatasetManifestEntry | undefined;
	let pointLoadGeneration = 0;
	let pointLoadAbortController: AbortController | undefined;
	let atlasController: PaleoAtlasLayerController | undefined;
	let singleRasterController: SingleRasterLayerController | undefined;
	const performanceMonitor = new PerformanceMonitor(viewer);

	const applyImageryOrder = (): void => {
		for (const layer of [...projectSession.layerList].reverse()) {
			if (layer.id === RUNTIME_LAYER_IDS.atlas) {
				atlasController?.raiseToTop();
			} else if (layer.id === RUNTIME_LAYER_IDS.raster) {
				singleRasterController?.raiseToTop();
			}
		}
		viewer.scene.requestRender();
	};

	const updateAtlasState = (state: PaleoAtlasRuntimeState): void => {
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
			atlasFrameValue.textContent = `${state.frame.timeMa} Ma`;
			atlasStatus.textContent = `图集瓦片不可用：${state.message}`;
		} else {
			atlasFrameValue.textContent = "—";
			atlasStatus.textContent =
				state.reason === "disabled"
					? "古地理图集已关闭"
					: "该时间超出图集 0–750 Ma 范围";
		}
		applyImageryOrder();
	};

	try {
		const atlasManifest = await atlasManifestPromise;
		atlasController = new PaleoAtlasLayerController(
			viewer,
			new AtlasFrameResolver(atlasManifest),
			updateAtlasState,
		);
		atlasController.setOpacity(
			projectSession.getEffectiveLayerOpacity(RUNTIME_LAYER_IDS.atlas),
		);
		atlasController.setTime(initialAgeMa);
		atlasController.setVisible(
			projectSession.getEffectiveLayerVisibility(RUNTIME_LAYER_IDS.atlas),
		);
		atlasVisibility.disabled = false;
	} catch (error) {
		atlasVisibility.checked = false;
		atlasVisibility.disabled = true;
		atlasFrameValue.textContent = "—";
		atlasStatus.dataset.state = "error";
		atlasStatus.textContent =
			error instanceof Error ? error.message : String(error);
	}

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
		singleRasterStatus.dataset.state = state.status;
		singleRasterStatus.dataset.rasterId = state.raster?.id ?? "";
		singleRasterState.dataset.state = state.status;
		if (state.status === "loading") {
			singleRasterState.textContent = "加载中";
			singleRasterStatus.textContent = `正在加载 ${state.raster.label}…`;
			updateSingleRasterLegend(state.raster);
		} else if (state.status === "ready") {
			singleRasterState.textContent = "已显示";
			singleRasterStatus.textContent = `${state.raster.sourceFile} · Martin PNG tiles`;
			updateSingleRasterLegend(state.raster);
		} else if (state.status === "hidden") {
			singleRasterState.textContent = "已隐藏";
			singleRasterStatus.textContent = "栅格图层已关闭";
		} else {
			singleRasterState.textContent = "失败";
			singleRasterStatus.textContent = `${state.raster.label}：${state.message}`;
			updateSingleRasterLegend(state.raster);
		}
		applyImageryOrder();
	};

	try {
		const singleRasterManifest = await singleRasterManifestPromise;
		singleRasterSelect.replaceChildren(
			...singleRasterManifest.rasters.map((raster) => {
				const option = document.createElement("option");
				option.value = raster.id;
				option.textContent = raster.label;
				return option;
			}),
		);
		singleRasterSelect.value = singleRasterManifest.defaultRasterId;
		singleRasterController = new SingleRasterLayerController(
			viewer,
			singleRasterManifest,
			updateSingleRasterState,
		);
		singleRasterController.setOpacity(
			projectSession.getEffectiveLayerOpacity(RUNTIME_LAYER_IDS.raster),
		);
		singleRasterController.select(singleRasterManifest.defaultRasterId);
		singleRasterController.setVisible(
			projectSession.getEffectiveLayerVisibility(RUNTIME_LAYER_IDS.raster),
		);
		applyImageryOrder();
		singleRasterSelect.disabled = false;
		singleRasterVisibility.disabled = false;
		singleRasterOpacity.disabled = false;
	} catch (error) {
		singleRasterVisibility.checked = false;
		singleRasterSelect.disabled = true;
		singleRasterVisibility.disabled = true;
		singleRasterOpacity.disabled = true;
		singleRasterState.dataset.state = "error";
		singleRasterState.textContent = "数据缺失";
		singleRasterStatus.dataset.state = "error";
		singleRasterStatus.textContent =
			error instanceof Error ? error.message : String(error);
	}

	const setPointPanelState = (
		state: "ready" | "busy" | "error",
		label: string,
		message: string,
	): void => {
		pointStateChip.dataset.state = state;
		pointStateChip.textContent = label;
		pointStatus.dataset.state = state;
		pointStatus.textContent = message;
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
		if (selectedPointRecord) {
			const record = selectedPointRecord;
			inspectorEmpty.hidden = true;
			inspectorContent.hidden = false;
			selectedName.textContent = `PBDB row ${record.rowId.toLocaleString()}`;
			selectedId.textContent = `Plate ID ${record.plateId}`;
			selectedValidity.textContent = `${record.validFromMa} → ${record.validToMa} Ma`;
			const currentAgeMa = timeline.currentAgeMa;
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
			Number(ageValue.textContent ?? 0),
		);
		const rotation = currentTimeState.rotationMap.get(selectedFeature.plateId);
		selectedState.textContent = valid
			? rotation
				? "有效 · 已重建"
				: "有效 · 旋转链断开"
			: "当前时间不可见";
		selectedQuaternion.textContent = formatQuaternion(rotation);
	};

	renderer.setPickCallback((pick: PlatePick) => {
		selectedPointRecord = undefined;
		selectedFeature = pick.feature;
		updateInspector();
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
			maxAgeMa: 538.8,
			initialAgeMa,
			reverse: true,
			onChange: (ageMa) => {
				performanceMonitor.markInteraction();
				atlasController?.setTime(ageMa);
				// One latest-request control for globe and rectangle: in globe this is
				// the synchronous fast path (applyGlobeFrame runs before the next line),
				// in rectangle it prepares + commits a new frame asynchronously while the
				// old picture stays until the new one is verified.
				if (projectionController) {
					timelineFrame = projectionController.setTime(ageMa);
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
				updateVisiblePointCount(ageMa);
				updateInspector();
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
		projectionSelect.disabled = false;
		projectionSelect.value =
			snapshot.status === "preparing"
				? snapshot.requestedId
				: snapshot.committedId;
		const rectangleOption = projectionSelect.querySelector<HTMLOptionElement>(
			'option[value="rectangle"]',
		);
		const rectangleMode = snapshot.availableModes.find(
			(mode) => mode.projectionId === "rectangle",
		);
		if (rectangleOption && rectangleMode) {
			rectangleOption.disabled = !rectangleMode.available;
			rectangleOption.title = rectangleMode.reason ?? "";
		}
		projectionStatus.dataset.state = snapshot.status;
		projectionStatus.textContent = projectionStatusText(snapshot);
		activePlates.textContent =
			snapshot.committedTimeState.activePlateCount.toLocaleString();
		activeFeatures.textContent =
			snapshot.committedTimeState.activeFeatureCount.toLocaleString();
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
		incompatibleLayerIds: PROJECTION_INCOMPATIBLE_LAYER_IDS,
		getCurrentTimeMa: () => timeline.currentAgeMa,
		isLayerVisible: (layerId) =>
			projectSession.getEffectiveLayerVisibility(layerId),
		describeLayer: describeProjectionLayer,
		onCommittedTimeChange: () => {
			// In rectangle, refresh the committed-age rotation map so the inspector
			// reflects the frame actually shown; in globe applyGlobeFrame already did.
			if (projectionController?.activeMode === "rectangle") {
				refreshRectangleTimeState();
				updateInspector();
			}
		},
		onStateChange: applyProjectionStateToUI,
		setGlobeInertiaEnabled: (enabled) => {
			globeSpinInertiaEnabled = enabled;
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
			pointRenderer?.setTime(timeMa, currentTimeState.rotationMap);
			return {
				activeFeatureCount: currentTimeState.activeFeatureCount,
				activePlateCount: currentTimeState.activePlateCount,
				disconnectedFeatureCount: currentTimeState.disconnectedFeatureCount,
			};
		},
		globeHome: () => setCameraHome(viewer),
	});
	projectionController.initialize(initialAgeMa, {
		activeFeatureCount: currentTimeState.activeFeatureCount,
		activePlateCount: currentTimeState.activePlateCount,
		disconnectedFeatureCount: currentTimeState.disconnectedFeatureCount,
	});
	projectionSelect.addEventListener("change", () => {
		void projectionController?.select(projectionSelect.value).catch(() => {
			// The failure is already reflected in the status line and the select
			// has snapped back to the committed mode through onStateChange.
		});
	});

	let pointPickGeneration = 0;
	viewer.scene.canvas.addEventListener("click", async (event) => {
		const activePicker = pointPicker;
		const dataset = loadedPointDataset;
		if (
			!activePicker ||
			!dataset ||
			!projectSession.getEffectiveLayerVisibility(RUNTIME_LAYER_IDS.points)
		) {
			return;
		}
		const bounds = viewer.scene.canvas.getBoundingClientRect();
		const screen = new Cartesian2(
			event.clientX - bounds.left,
			event.clientY - bounds.top,
		);
		const pickedSurface = viewer.camera.pickEllipsoid(screen, SPHERICAL_EARTH);
		if (!pickedSurface) {
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
		const rowId = await activePicker.pick({
			maximumAngularDistance,
			rotationMap: currentTimeState.rotationMap,
			style,
			target: [target.x, target.y, target.z],
			timeMa: timeline.currentAgeMa,
		});
		if (
			generation !== pointPickGeneration ||
			rowId === undefined ||
			dataset !== loadedPointDataset
		) {
			return;
		}
		selectedFeature = undefined;
		selectedPointRecord = readPointRecord(dataset.buffer, rowId);
		updateInspector();
	});

	requiredElement("#home-camera", HTMLButtonElement).addEventListener(
		"click",
		() => projectionController?.home(),
	);

	/**
	 * Shared setters for the native sidebar controls. The DOM listener and the
	 * action handler call the same function, so a programmatic change behaves
	 * exactly like a user dragging the control.
	 */
	const selectSingleRaster = (rasterId: string): void => {
		singleRasterSelect.value = rasterId;
		singleRasterController?.select(rasterId);
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

	const selectLocalPointDataset = async (
		datasetId: string,
		load: boolean,
	): Promise<void> => {
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
		pointDatasetSelect.value = datasetId;
		if (load) {
			if (!loadSelectedPointDataset) {
				throw new AgentActionUnsupportedError(
					"The point dataset manifest is not ready yet.",
				);
			}
			await loadSelectedPointDataset();
		}
	};

	singleRasterSelect.addEventListener("change", () => {
		selectSingleRaster(singleRasterSelect.value);
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
		if (projectionController?.sceneMode !== "rectangle") {
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
		projectSession.setLayerSourceRef(
			RUNTIME_LAYER_IDS.plateModel,
			plateModelSourceRef(plateSource),
		);
		if (selection.datasetVersionId > 0) {
			projectSession.setLayerSourceRef(
				RUNTIME_LAYER_IDS.points,
				`resource:dataset-version:${selection.datasetVersionId}`
		);
		}
	};

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
				captureProjectState();
				projectSession.save(window.localStorage);
				const cloudReference = await phase1BCloudClient.saveProject(
					projectSession.toDocument(),
				);
				window.dispatchEvent(
					new CustomEvent("timemachine:project-saved", {
						detail: {
							message: `Cloud draft r${cloudReference.revisionNumber} autosaved`,
						},
					}),
				);
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
		captureProjectState();
		projectSession.save(window.localStorage);
		scheduleCloudLayerAutosave();
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
		const visible = projectSession.getEffectiveLayerVisibility(id);
		const opacity = projectSession.getEffectiveLayerOpacity(id);
		if (id === RUNTIME_LAYER_IDS.atlas) {
			atlasController?.setVisible(visible);
			atlasController?.setOpacity(opacity);
		} else if (id === RUNTIME_LAYER_IDS.raster) {
			singleRasterController?.setVisible(visible);
			singleRasterController?.setOpacity(opacity);
		} else if (id === RUNTIME_LAYER_IDS.points) {
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
			if (projectionController?.activeMode === "rectangle") {
				// Rectangle style path: setPlateGeometry* already synced the committed
				// rectangle frame. Running the globe updateTime here would re-show the
				// hidden globe bundles (two copies of the plates), so the time state is
				// refreshed for the committed rectangle age instead.
				refreshRectangleTimeState();
				updateInspector();
			} else {
				currentTimeState = renderer.updateTime(
					timeline.currentAgeMa,
					rotationModel
				);
				pointRenderer?.setTime(
					timeline.currentAgeMa,
					currentTimeState.rotationMap
				);
			}
		}
	};

	const layerController = new LayerController(projectSession, {
		applyImageryOrder,
		applyRuntime: applyLayerRuntimeState,
		persist: persistLayerEdit,
		publishState: () => {
			applyLayerState();
			// Every layer/group/order mutation lands here, and each one can flip a
			// rectangle-incompatible layer's effective visibility. Republishing the
			// projection capabilities keeps the select option and the status line
			// honest without a reload; only availability is recomputed (no
			// mode/time/revision change, no frame). This adapter is installed after
			// the ProjectionController is constructed, so it never touches the
			// controller binding before initialization.
			projectionController?.refreshCapabilities();
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
		requireV2Workspace(
			phase1BCloudClient.snapshot.v2WorkspaceAvailable,
			"cloud projects",
		);
		window.clearTimeout(cloudAutosaveTimer);
		captureProjectState();
		const snapshot = projectSession.save(window.localStorage);
		const document = projectSession.toDocument();
		const cloudReference = await phase1BCloudClient.saveProject(document);
		window.dispatchEvent(
			new CustomEvent("timemachine:project-saved", {
				detail: {
					document,
					message: `Cloud revision ${cloudReference.revisionNumber} saved at ${new Date(
						snapshot.savedAt,
					).toLocaleTimeString()}.`,
				},
			})
		);
		return {
			data: {
				revisionId: cloudReference.revisionId,
				revisionNumber: cloudReference.revisionNumber,
			},
		};
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

	const releasePointRenderer = (
		rendererToRelease: GpuPointRenderer | undefined,
	): void => {
		if (!rendererToRelease) {
			return;
		}
		rendererToRelease.setShow(false);
		viewer.scene.requestRender();
		window.requestAnimationFrame(() => {
			const destroy = (): void => rendererToRelease.destroy();
			const requestIdle = (
				window as Window & {
					requestIdleCallback?: typeof window.requestIdleCallback;
				}
			).requestIdleCallback;
			if (requestIdle) {
				requestIdle(destroy, { timeout: 240 });
			} else {
				globalThis.setTimeout(destroy, 0);
			}
		});
	};

	const unloadPointDataset = (): void => {
		pointLoadGeneration += 1;
		pointPickGeneration += 1;
		pointLoadInFlight = false;
		pointLoadAbortController?.abort();
		pointLoadAbortController = undefined;
		pointPicker?.destroy();
		pointPicker = undefined;
		loadedPointDataset = undefined;
		if (selectedPointRecord) {
			selectedPointRecord = undefined;
			inspectorContent.hidden = true;
			inspectorEmpty.hidden = false;
		}
		const retiringRenderer = pointRenderer;
		pointRenderer = undefined;
		releasePointRenderer(retiringRenderer);
		loadedPointEntry = undefined;
		performanceMonitor.resetFrameSamples();
		clearPointMetrics();
		unloadPointsButton.disabled = true;
		setPointPanelState(
			"ready",
			"未加载",
			retiringRenderer
				? "点图层已隐藏；GPU 缓冲区将在下一 idle 阶段释放。"
				: "当前没有已加载的点数据。",
		);
	};
	unloadPointsButton.addEventListener("click", unloadPointDataset);

	// Ensure the first per-instance attribute update happens after Primitive.update.
	let removeInitialPostRenderListener = (): void => {};
	removeInitialPostRenderListener = viewer.scene.postRender.addEventListener(
		() => {
			currentTimeState = renderer.updateTime(
				timeline.currentAgeMa,
				rotationModel
		);
			removeInitialPostRenderListener();
		},
	);

	// Assigned once the point manifest resolves, so the action facade can select a
	// dataset by id without touching the DOM.
	let pointManifestRef: PointFixtureManifest | undefined;
	let loadSelectedPointDataset: (() => Promise<void>) | undefined;
	let pointLoadInFlight = false;
	try {
		const pointManifest = await pointManifestPromise;
		pointManifestRef = pointManifest;
		if (
			pointManifest.format.magic !== "WGP1" ||
			pointManifest.format.recordStrideBytes !== 20 ||
			pointManifest.datasets.length === 0
		) {
			throw new Error("点数据清单格式不受支持。");
		}
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

		loadSelectedPointDataset = async (): Promise<void> => {
			const selectedEntry = pointManifest.datasets.find(
				(entry) => entry.id === pointDatasetSelect.value
		);
			if (!selectedEntry) {
				return;
			}

			const generation = ++pointLoadGeneration;
			pointPickGeneration += 1;
			pointLoadInFlight = true;
			pointLoadAbortController?.abort();
			const abortController = new AbortController();
			pointLoadAbortController = abortController;
			const retiringRenderer = pointRenderer;
			pointRenderer = undefined;
			pointPicker?.destroy();
			pointPicker = undefined;
			loadedPointDataset = undefined;
			releasePointRenderer(retiringRenderer);
			loadedPointEntry = undefined;
			unloadPointsButton.disabled = true;
			loadPointsButton.disabled = true;
			pointDatasetSelect.disabled = true;
			performanceMonitor.resetFrameSamples();
			clearPointMetrics();
			pointCount.textContent = selectedEntry.pointCount.toLocaleString();
			pointMemory.textContent = `${formatBytes(selectedEntry.byteLength)} / —`;
			setPointPanelState(
				"busy",
				"加载中",
				`Worker 正在读取 ${selectedEntry.label}，主线程仍可操作时间轴…`
		);

			try {
				const loaded = await loadPointDataset(
					selectedEntry.id,
					await resolvePointDatasetUrl(
						selectedEntry.url,
						DATA_URLS.pointManifest,
						DATA_URLS.pointManifestAccessToken,
					),
					{ signal: abortController.signal },
				);
				if (generation !== pointLoadGeneration) {
					return;
				}
				if (loaded.header.pointCount !== selectedEntry.pointCount) {
					throw new Error(
						`数据点数 ${loaded.header.pointCount.toLocaleString()} 与清单 ${selectedEntry.pointCount.toLocaleString()} 不一致。`,
					);
				}

				setPointPanelState(
					"busy",
					"上传中",
					"二进制解析完成，正在创建单个 GPU 顶点缓冲区…",
				);
				const nextRenderer = await GpuPointRenderer.create(
					viewer,
					loaded,
					timeline.currentAgeMa,
					currentTimeState.rotationMap,
				);
				if (generation !== pointLoadGeneration) {
					nextRenderer.destroy();
					return;
				}

				pointRenderer = nextRenderer;
				loadedPointEntry = selectedEntry;
				loadedPointDataset = loaded;
				if (loaded.header.pointCount <= MAX_PICKABLE_POINT_COUNT) {
					pointPicker = new PointPicker(loaded);
				}
				const pointStyle = projectSession.getLayer(
					RUNTIME_LAYER_IDS.points,
				)?.pointStyle;
				if (pointStyle) {
					pointRenderer.setStyle(pointStyle);
				} else {
					pointRenderer.setPointSize(Number(pointSize.value));
				}
				pointRenderer.setOpacity(
					projectSession.getEffectiveLayerOpacity(RUNTIME_LAYER_IDS.points),
				);
				pointRenderer.setShow(
					projectSession.getEffectiveLayerVisibility(RUNTIME_LAYER_IDS.points),
				);
				pointCount.textContent = selectedEntry.pointCount.toLocaleString();
				updateVisiblePointCount(timeline.currentAgeMa);
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
					return;
				}
				if (error instanceof DOMException && error.name === "AbortError") {
					setPointPanelState(
						"ready",
						"已取消",
						"点数据请求已取消，没有创建 GPU 缓冲区。",
					);
					return;
				}
				pointRenderer?.destroy();
				pointRenderer = undefined;
				pointPicker?.destroy();
				pointPicker = undefined;
				loadedPointDataset = undefined;
				loadedPointEntry = undefined;
				setPointPanelState(
					"error",
					"失败",
					error instanceof Error ? error.message : String(error),
				);
				// Re-raised so an automated caller sees the failure instead of a
					// success; the panel above is the human-readable form of it.
				throw error;
			} finally {
				if (generation === pointLoadGeneration) {
					pointLoadAbortController = undefined;
					pointLoadInFlight = false;
					loadPointsButton.disabled = false;
					pointDatasetSelect.disabled = false;
				}
			}
		};
		loadPointsButton.addEventListener("click", () => {
			void (async () => {
				try {
					await loadSelectedPointDataset?.();
				} catch {
					// The panel already reports the failure; nothing to re-throw here.
				}
			})();
		});
	} catch (error) {
		pointDatasetSelect.disabled = true;
		loadPointsButton.disabled = true;
		setPointPanelState(
			"error",
			"数据缺失",
			error instanceof Error ? error.message : String(error),
		);
	}

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
		const ready = (
			id: (typeof AGENT_ACTIONS)[keyof typeof AGENT_ACTIONS],
			handler: Parameters<typeof agentActions.register>[1],
		) => {
			agentActions.register(AGENT_DECLARATIONS[id], handler);
		};

		ready(
			AGENT_ACTIONS.timeSet,
			async (params) => {
				const ageMa = params.ageMa as number;
				if (ageMa < timeline.minAgeMa || ageMa > timeline.maxAgeMa) {
					throw new AgentActionValidationError(
						`ageMa must be within [${timeline.minAgeMa}, ${timeline.maxAgeMa}].`,
					);
				}
				// Pause first, exactly like the slider and quick-age buttons, so a
					// running animation cannot immediately overwrite the new age.
				timeline.setPlaying(false);
				timeline.setAge(ageMa);
				// Await the real frame through the same latest-request control the UI
				// uses: in globe this is synchronous, in rectangle it resolves only
				// after the new frame is prepared, verified and committed - a bare
				// timeline callback firing is not success.
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
		ready(AGENT_ACTIONS.cameraReset, () => {
			// Mode-aware home: the full map in Rectangle, the globe view otherwise.
			projectionController?.home();
			return {};
		});

		// --- Projection ------------------------------------------------------
		// The UI select and this action share one handler, so a programmatic
		// switch behaves exactly like picking the option.
		ready(AGENT_ACTIONS.projectionSelect, async (params) => {
			const projectionId = params.projectionId as string;
			if (!projectionController) {
				throw new AgentActionUnsupportedError(
					"The projection runtime is not initialized yet.",
				);
			}
			const result = await projectionController.select(projectionId);
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
				return { data: { active, groupId } };
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
						effective: projectSession.getGroup(groupId)?.alpha ?? alpha,
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
			async () => {
				if (pointLoadInFlight) {
					throw new AgentActionBusyError(
						"A point dataset is already loading.",
					);
				}
				// The GPU point shader is globe-only for now, so loading points while
				// Rectangle is active or pending would show a mis-projected layer.
				if (projectionController?.activeMode === "rectangle") {
					throw new AgentActionUnsupportedError(
						"Points cannot be loaded while the Rectangle projection is active; switch back to Globe first.",
					);
				}
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
				await loadSelectedPointDataset();
				return {
					data: {
						datasetId: loadedPointEntry?.id ?? "",
						loaded: Boolean(loadedPointEntry),
						selectedDatasetId: pointDatasetSelect.value,
					},
				};
			},
		);
		ready(
			AGENT_ACTIONS.pointsSelectDataset,
			async (params) => {
				const datasetId = params.datasetId as string;
				await selectLocalPointDataset(datasetId, params.load === true);
				// `loaded` is about the dataset that was just selected, not about
				// whichever dataset happens to be in GPU memory.
				return {
					data: {
						datasetId,
						loaded: loadedPointEntry?.id === datasetId,
						loadedDatasetId: loadedPointEntry?.id ?? "",
						selectedDatasetId: pointDatasetSelect.value,
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
			unloadPointDataset();
			return {};
		});

		// --- Raster and project metadata -------------------------------------
		ready(
			AGENT_ACTIONS.rasterSelect,
			(params) => {
				const rasterId = params.rasterId as string;
				if (!singleRasterSelect.querySelector(`option[value="${rasterId}"]`)) {
					throw new AgentActionValidationError(
						`Unknown raster "${rasterId}".`,
					);
				}
				selectSingleRaster(rasterId);
				return { data: { rasterId } };
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

		// --- Cloud projects (V2 only) ----------------------------------------
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

		// --- State sections -------------------------------------------------
		// Only bounded scalars: no feature arrays, no GPU objects, no Cesium
		// primitives. `gpmlParseResult.features` can hold tens of thousands of
		// entries and must never be walked into a snapshot.
		agentActions.registerStateSection("time", () => ({
			ageMa: timeline.currentAgeMa,
			playing: timeline.playing,
			speedMaPerSecond: timeline.speedMaPerSecond,
		}));
		agentActions.registerStateSection("plateModel", () => ({
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
		agentActions.registerStateSection("layers", () => ({
			groups: projectSession.groupList.map((group) => ({
				active: group.active,
				alpha: group.alpha,
				collapsed: group.collapsed,
				id: group.id,
			})),
			layers: projectSession.layerList.map((layer) => ({
				active: layer.active,
				alpha: layer.alpha,
				id: layer.id,
				sourceRef: layer.sourceRef,
				type: layer.type,
			})),
		}));
		agentActions.registerStateSection("points", () => ({
			datasetId: loadedPointEntry?.id ?? "",
			loaded: Boolean(loadedPointEntry),
			selectedDatasetId: pointDatasetSelect.value,
		}));
		agentActions.registerStateSection("projection", () => {
			const snapshot = projectionController?.getSnapshot();
			if (!snapshot) {
				return { status: "idle" };
			}
			return {
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
	registerRenderAgentActions();

	loadingTitle.textContent = "重建就绪";
	loadingDetail.textContent = `${loadedPlateModelLabel} · ${
		gpmlParseResult.features.length
	} 个要素，${rotationParseResult.sequences.length} 条旋转序列${
		plateModelLoadError ? `；加载失败：${plateModelLoadError}` : ""
	}；数值链路已通过黄金值校验。`;
	loadingProgress.style.width = "100%";
	await platformBootstrap;
	await phase1BInitialization;
	await new Promise((resolve) => window.setTimeout(resolve, 420));
	loadingOverlay.classList.add("is-complete");
	viewer.scene.requestRender();
}

main().catch((error: unknown) => {
	const loadingTitle = document.querySelector("#loading-title");
	const loadingDetail = document.querySelector("#loading-detail");
	const loadingOverlay = document.querySelector("#loading-overlay");
	loadingTitle && (loadingTitle.textContent = "重建初始化失败");
	loadingDetail &&
		(loadingDetail.textContent =
			error instanceof Error ? error.message : String(error));
	loadingOverlay?.classList.add("has-error");
	console.error(error);
});
