import {
  BoundingSphere,
  Cartesian3,
  Color,
  ComponentDatatype,
  Matrix4,
  PixelDatatype,
  PixelFormat,
  Primitive,
  PrimitiveType,
  Viewer,
} from "cesium";
import * as CesiumRuntime from "cesium";

import { EARTH_RADIUS_METRES } from "@timemachine/cesium-runtime";
import type { Quaternion } from "@timemachine/reconstruction-core";

import type { LoadedPointDataset } from "./types";
import {
  DEFAULT_POINT_STYLE,
  normalizePointStyleExpression,
  type PointStyleExpression,
} from "./style-expression";
import { WGP_RECORD_STRIDE_BYTES } from "./wgp-format";

const POINT_RADIUS_METRES = EARTH_RADIUS_METRES + 24_000;

const VERTEX_SHADER = `
in vec3 position;
in vec2 timeRange;
in float plateId;
in float occurrenceCount;

uniform sampler2D u_rotationTexture;
uniform float u_rotationTextureWidth;
uniform float u_timeDeciMa;
uniform float u_pointRadius;
uniform float u_pointSize;
uniform float u_colorMode;
uniform float u_sizeMode;
uniform float u_occurrenceSizeScale;
uniform float u_filterPlateId;
uniform float u_minimumOccurrence;
uniform float u_maximumOccurrence;
uniform vec4 u_singleColor;

out vec3 v_color;

vec3 rotateByQuaternion(vec3 vector, vec4 quaternion)
{
    vec3 twiceCross = 2.0 * cross(quaternion.xyz, vector);
    return vector + quaternion.w * twiceCross + cross(quaternion.xyz, twiceCross);
}

vec3 colorForPlate(float value)
{
    float hue = fract(value * 0.61803398875);
    return 0.62 + 0.30 * cos(
        6.28318530718 * (hue + vec3(0.00, 0.33, 0.67))
    );
}

vec3 colorForOccurrence(float value)
{
    float strength = clamp(log2(value + 1.0) / 12.0, 0.0, 1.0);
    vec3 cool = vec3(0.12, 0.55, 0.93);
    vec3 middle = vec3(0.98, 0.82, 0.19);
    vec3 warm = vec3(0.90, 0.22, 0.16);
    return strength < 0.5
        ? mix(cool, middle, strength * 2.0)
        : mix(middle, warm, (strength - 0.5) * 2.0);
}

void main()
{
    float inTexture = 1.0 - step(u_rotationTextureWidth, plateId);
    float lookupPlate = min(plateId, u_rotationTextureWidth - 1.0);
    float textureX = (lookupPlate + 0.5) / u_rotationTextureWidth;
    vec4 quaternion = texture(u_rotationTexture, vec2(textureX, 0.5));
    float quaternionMagnitude = dot(quaternion, quaternion);
    float connected = inTexture * step(0.5, quaternionMagnitude);
    quaternion *= inversesqrt(max(quaternionMagnitude, 1.0e-12));

    float timeVisible =
        step(timeRange.y, u_timeDeciMa) *
        step(u_timeDeciMa, timeRange.x);
    float occurrenceVisible =
        step(u_minimumOccurrence, occurrenceCount) *
        step(occurrenceCount, u_maximumOccurrence);
    float plateFilterEnabled = step(-0.5, u_filterPlateId);
    float plateMatches = 1.0 - step(0.5, abs(plateId - u_filterPlateId));
    float plateVisible = mix(1.0, plateMatches, plateFilterEnabled);
    float show = connected * timeVisible * occurrenceVisible * plateVisible;

    vec3 rotated = rotateByQuaternion(position, quaternion);
    vec4 positionEC = czm_modelView * vec4(rotated * u_pointRadius, 1.0);
    vec4 clipPosition = czm_projection * positionEC;
    gl_Position = mix(vec4(2.0, 2.0, 2.0, 1.0), clipPosition, show);
    czm_vertexLogDepth();

    float occurrenceBoost = min(log2(occurrenceCount + 1.0) * 0.08, 1.2);
    float sizeBoost =
        step(0.5, u_sizeMode) * occurrenceBoost * u_occurrenceSizeScale;
    gl_PointSize = (u_pointSize + sizeBoost) * czm_pixelRatio * show;
    if (u_colorMode < 0.5)
    {
        v_color = colorForPlate(plateId);
    }
    else if (u_colorMode < 1.5)
    {
        v_color = u_singleColor.rgb;
    }
    else
    {
        v_color = colorForOccurrence(occurrenceCount);
    }
}
`;

const FRAGMENT_SHADER = `
in vec3 v_color;
uniform float u_opacity;
uniform float u_shape;

void main()
{
    float distanceToCenter = length(gl_PointCoord - vec2(0.5));
    float edgeWidth = fwidth(distanceToCenter);
    float circleAlpha =
        1.0 - smoothstep(0.5 - edgeWidth, 0.5, distanceToCenter);
    float alpha = mix(circleAlpha, 1.0, step(0.5, u_shape)) * u_opacity;
    if (alpha < 0.01)
    {
        discard;
    }

    out_FragColor = czm_gammaCorrect(vec4(v_color, alpha));
    czm_writeLogDepth();
}
`;

interface DestroyableRuntime {
  destroy(): void;
}

interface TextureRuntime extends DestroyableRuntime {
  copyFrom(options: {
    source: {
      width: number;
      height: number;
      arrayBufferView: Float32Array;
    };
  }): void;
}

interface DrawCommandRuntime {
  count: number;
}

interface InternalCesiumRuntime {
  Buffer: {
    createVertexBuffer(options: {
      context: unknown;
      typedArray: Uint8Array;
      usage: unknown;
    }): DestroyableRuntime;
  };
  BufferUsage: { STATIC_DRAW: unknown };
  VertexArray: new (options: {
    context: unknown;
    attributes: Array<{
      index: number;
      vertexBuffer: DestroyableRuntime;
      componentsPerAttribute: number;
      componentDatatype: ComponentDatatype;
      normalize?: boolean;
      offsetInBytes: number;
      strideInBytes: number;
    }>;
  }) => DestroyableRuntime;
  ShaderSource: new (options: { sources: string[] }) => unknown;
  ShaderProgram: {
    fromCache(options: {
      context: unknown;
      vertexShaderSource: unknown;
      fragmentShaderSource: unknown;
      attributeLocations: Record<string, number>;
    }): DestroyableRuntime;
  };
  RenderState: {
    fromCache(options: {
      depthTest: { enabled: boolean };
      depthMask: boolean;
      blending: unknown;
    }): unknown;
    removeFromCache(renderState: unknown): void;
  };
  BlendingState: { ALPHA_BLEND: unknown };
  Texture: new (options: {
    context: unknown;
    width: number;
    height: number;
    pixelFormat: PixelFormat;
    pixelDatatype: PixelDatatype;
    flipY: boolean;
    sampler: unknown;
    source: {
      width: number;
      height: number;
      arrayBufferView: Float32Array;
    };
  }) => TextureRuntime;
  Sampler: new (options: {
    minificationFilter: unknown;
    magnificationFilter: unknown;
  }) => unknown;
  TextureMinificationFilter: { NEAREST: unknown };
  TextureMagnificationFilter: { NEAREST: unknown };
  DrawCommand: new (options: {
    vertexArray: DestroyableRuntime;
    renderState: unknown;
    shaderProgram: DestroyableRuntime;
    uniformMap: Record<string, () => unknown>;
    primitiveType: PrimitiveType;
    pass: unknown;
    owner: unknown;
    count: number;
    modelMatrix: Matrix4;
    boundingVolume: BoundingSphere;
  }) => DrawCommandRuntime;
  Pass: { TRANSLUCENT: unknown };
}

interface FrameStateLike {
  context: unknown;
  commandList: DrawCommandRuntime[];
  passes: { render: boolean };
}

const internal = CesiumRuntime as unknown as InternalCesiumRuntime;

export interface GpuPointBuildStats {
  pointCount: number;
  sourceBytes: number;
  gpuVertexBytes: number;
  quaternionTextureBytes: number;
  uploadMs: number;
  drawCalls: number;
}

function creationAborted(): DOMException {
  return new DOMException("Point GPU creation was aborted.", "AbortError");
}

function createQuaternionTextureData(
  width: number,
  rotationMap: ReadonlyMap<number, Quaternion>,
): Float32Array {
  const data = new Float32Array(width * 4);
  for (const [plateId, quaternion] of rotationMap) {
    if (plateId < 0 || plateId >= width) {
      continue;
    }
    const offset = plateId * 4;
    data[offset] = quaternion.x;
    data[offset + 1] = quaternion.y;
    data[offset + 2] = quaternion.z;
    data[offset + 3] = quaternion.w;
  }
  return data;
}

export function buildQuaternionTextureData(
  width: number,
  rotationMap: ReadonlyMap<number, Quaternion>,
): Float32Array {
  return createQuaternionTextureData(width, rotationMap);
}

class GpuPointCloudPrimitive {
  show = true;
  readonly ready: Promise<GpuPointBuildStats>;

  private readonly viewer: Viewer;
  private readonly pointCount: number;
  private readonly sourceBytes: number;
  private readonly rotationTextureWidth: number;
  private readonly boundingVolume = new BoundingSphere(
    Cartesian3.ZERO,
    POINT_RADIUS_METRES,
  );
  private sourcePayload: Uint8Array | undefined;
  private rotationTextureData: Float32Array;
  private rotationTextureDirty = false;
  private timeDeciMa = 0;
  private opacity = 1;
  private style = normalizePointStyleExpression(DEFAULT_POINT_STYLE);
  private singleColor = Color.fromCssColorString(
    DEFAULT_POINT_STYLE.singleColor,
  );
  private vertexArray: DestroyableRuntime | undefined;
  private unownedVertexBuffer: DestroyableRuntime | undefined;
  private shaderProgram: DestroyableRuntime | undefined;
  private renderState: unknown;
  private rotationTexture: TextureRuntime | undefined;
  private command: DrawCommandRuntime | undefined;
  private destroyed = false;
  private resolveReady:
    | ((stats: GpuPointBuildStats) => void)
    | undefined;
  private rejectReady: ((reason: unknown) => void) | undefined;

  constructor(viewer: Viewer, dataset: LoadedPointDataset) {
    this.viewer = viewer;
    this.pointCount = dataset.header.pointCount;
    this.sourceBytes = dataset.buffer.byteLength;
    this.rotationTextureWidth = Math.max(1, dataset.header.maxPlateId + 1);
    this.rotationTextureData = new Float32Array(
      this.rotationTextureWidth * 4,
    );
    this.sourcePayload = new Uint8Array(
      dataset.buffer,
      dataset.header.headerBytes,
      dataset.header.pointCount * dataset.header.recordStrideBytes,
    );
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  setTime(
    timeMa: number,
    rotationMap: ReadonlyMap<number, Quaternion>,
  ): void {
    this.timeDeciMa = timeMa * 10;
    this.rotationTextureData = createQuaternionTextureData(
      this.rotationTextureWidth,
      rotationMap,
    );
    this.rotationTextureDirty = true;
    this.viewer.scene.requestRender();
  }

  setPointSize(pointSize: number): void {
    this.setStyle({ ...this.style, pointSize });
  }

  setStyle(style: unknown): void {
    this.style = normalizePointStyleExpression(style);
    this.singleColor = Color.fromCssColorString(this.style.singleColor);
    this.viewer.scene.requestRender();
  }

  setOpacity(opacity: number): void {
    this.opacity = Math.max(0, Math.min(1, opacity));
    this.viewer.scene.requestRender();
  }

  update(frameState: FrameStateLike): void {
    if (this.destroyed || !frameState.passes.render) {
      return;
    }
    if (!this.command) {
      try {
        this.initialize(frameState);
      } catch (error) {
        this.show = false;
        this.rejectReady?.(error);
        this.resolveReady = undefined;
        this.rejectReady = undefined;
        return;
      }
    }
    // Hidden candidates must finish initialization without entering the draw
    // list before the application has installed their effective visibility.
    if (!this.show) return;
    if (this.rotationTexture && this.rotationTextureDirty) {
      this.rotationTexture.copyFrom({
        source: {
          width: this.rotationTextureWidth,
          height: 1,
          arrayBufferView: this.rotationTextureData,
        },
      });
      this.rotationTextureDirty = false;
    }
    if (this.command) {
      frameState.commandList.push(this.command);
    }
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  matchesFrameState(timeMa: number, show: boolean): boolean {
    return !this.destroyed && this.command !== undefined && this.show === show &&
      this.timeDeciMa === timeMa * 10 && (!show || !this.rotationTextureDirty);
  }

  destroy(): void {
    this.destroyed = true;
    this.show = false;
    this.rejectReady?.(creationAborted());
    this.resolveReady = undefined;
    this.rejectReady = undefined;
    this.sourcePayload = undefined;
    this.command = undefined;
    const failures: unknown[] = [];
    for (const key of ["unownedVertexBuffer", "vertexArray", "shaderProgram", "rotationTexture"] as const) {
      try {
        this[key]?.destroy();
        this[key] = undefined;
      } catch (error) {
        // Keep only the failed handle for an explicit cleanup retry. A failed
        // release must not skip the other resources or make the object render.
        failures.push(error);
      }
    }
    if (this.renderState) {
      try {
        internal.RenderState.removeFromCache(this.renderState);
        this.renderState = undefined;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, "Point GPU resource cleanup failed.");
  }

  private initialize(frameState: FrameStateLike): void {
    const payload = this.sourcePayload;
    if (!payload) {
      throw new Error("Point payload was released before GPU initialization.");
    }
    const started = performance.now();
    const vertexBuffer = internal.Buffer.createVertexBuffer({
      context: frameState.context,
      typedArray: payload,
      usage: internal.BufferUsage.STATIC_DRAW,
    });
    // VertexArray owns the buffer only after its constructor succeeds.
    this.unownedVertexBuffer = vertexBuffer;

    const attributeLocations = {
      position: 0,
      timeRange: 1,
      plateId: 2,
      occurrenceCount: 3,
    };
    this.vertexArray = new internal.VertexArray({
      context: frameState.context,
      attributes: [
        {
          index: attributeLocations.position,
          vertexBuffer,
          componentsPerAttribute: 3,
          componentDatatype: ComponentDatatype.FLOAT,
          offsetInBytes: 0,
          strideInBytes: WGP_RECORD_STRIDE_BYTES,
        },
        {
          index: attributeLocations.timeRange,
          vertexBuffer,
          componentsPerAttribute: 2,
          componentDatatype: ComponentDatatype.UNSIGNED_SHORT,
          offsetInBytes: 12,
          strideInBytes: WGP_RECORD_STRIDE_BYTES,
        },
        {
          index: attributeLocations.plateId,
          vertexBuffer,
          componentsPerAttribute: 1,
          componentDatatype: ComponentDatatype.UNSIGNED_SHORT,
          offsetInBytes: 16,
          strideInBytes: WGP_RECORD_STRIDE_BYTES,
        },
        {
          index: attributeLocations.occurrenceCount,
          vertexBuffer,
          componentsPerAttribute: 1,
          componentDatatype: ComponentDatatype.UNSIGNED_SHORT,
          offsetInBytes: 18,
          strideInBytes: WGP_RECORD_STRIDE_BYTES,
        },
      ],
    });
    this.unownedVertexBuffer = undefined;

    this.shaderProgram = internal.ShaderProgram.fromCache({
      context: frameState.context,
      vertexShaderSource: new internal.ShaderSource({
        sources: [VERTEX_SHADER],
      }),
      fragmentShaderSource: new internal.ShaderSource({
        sources: [FRAGMENT_SHADER],
      }),
      attributeLocations,
    });
    this.renderState = internal.RenderState.fromCache({
      depthTest: { enabled: true },
      depthMask: false,
      blending: internal.BlendingState.ALPHA_BLEND,
    });
    const sampler = new internal.Sampler({
      minificationFilter: internal.TextureMinificationFilter.NEAREST,
      magnificationFilter: internal.TextureMagnificationFilter.NEAREST,
    });
    this.rotationTexture = new internal.Texture({
      context: frameState.context,
      width: this.rotationTextureWidth,
      height: 1,
      pixelFormat: PixelFormat.RGBA,
      pixelDatatype: PixelDatatype.FLOAT,
      flipY: false,
      sampler,
      source: {
        width: this.rotationTextureWidth,
        height: 1,
        arrayBufferView: this.rotationTextureData,
      },
    });
    this.rotationTextureDirty = false;

    const uniformMap = {
      u_rotationTexture: () => this.rotationTexture,
      u_rotationTextureWidth: () => this.rotationTextureWidth,
      u_timeDeciMa: () => this.timeDeciMa,
      u_pointRadius: () => POINT_RADIUS_METRES,
      u_pointSize: () => this.style.pointSize,
      u_opacity: () => this.opacity,
      u_colorMode: () =>
        this.style.colorMode === "plate"
          ? 0
          : this.style.colorMode === "single"
            ? 1
            : 2,
      u_sizeMode: () => (this.style.sizeMode === "fixed" ? 0 : 1),
      u_occurrenceSizeScale: () => this.style.occurrenceSizeScale,
      u_filterPlateId: () => this.style.filter.plateId ?? -1,
      u_minimumOccurrence: () => this.style.filter.minimumOccurrence,
      u_maximumOccurrence: () => this.style.filter.maximumOccurrence,
      u_singleColor: () => this.singleColor,
      u_shape: () => (this.style.shape === "circle" ? 0 : 1),
    };
    this.command = new internal.DrawCommand({
      vertexArray: this.vertexArray,
      renderState: this.renderState,
      shaderProgram: this.shaderProgram,
      uniformMap,
      primitiveType: PrimitiveType.POINTS,
      pass: internal.Pass.TRANSLUCENT,
      owner: this,
      count: this.pointCount,
      modelMatrix: Matrix4.IDENTITY,
      boundingVolume: this.boundingVolume,
    });

    const uploadMs = performance.now() - started;
    this.sourcePayload = undefined;
    this.resolveReady?.({
      pointCount: this.pointCount,
      sourceBytes: this.sourceBytes,
      gpuVertexBytes: this.pointCount * WGP_RECORD_STRIDE_BYTES,
      quaternionTextureBytes: this.rotationTextureData.byteLength,
      uploadMs,
      drawCalls: 1,
    });
    this.resolveReady = undefined;
    this.rejectReady = undefined;
  }
}

export class GpuPointRenderer {
  readonly buildStats: GpuPointBuildStats;

  private readonly viewer: Viewer;
  private readonly primitive: GpuPointCloudPrimitive;
  private destroyed = false;

  private constructor(
    viewer: Viewer,
    primitive: GpuPointCloudPrimitive,
    buildStats: GpuPointBuildStats,
  ) {
    this.viewer = viewer;
    this.primitive = primitive;
    this.buildStats = buildStats;
  }

  static async create(
    viewer: Viewer,
    dataset: LoadedPointDataset,
    timeMa: number,
    rotationMap: ReadonlyMap<number, Quaternion>,
    options: {
      signal?: AbortSignal;
      show?: boolean;
      onCleanupError?: (error: unknown) => void;
      onCleanupPending?: (resource: { destroy(): void }) => void;
    } = {},
  ): Promise<GpuPointRenderer> {
    const signal = options.signal;
    const scene = viewer.scene;
    if (signal?.aborted || scene.isDestroyed() || scene.primitives.isDestroyed()) throw creationAborted();
    const primitive = new GpuPointCloudPrimitive(viewer, dataset);
    primitive.show = options.show ?? true;
    let ownershipLost = false;
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        ownershipLost = true;
        reject(creationAborted());
      };
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error("Point GPU initialization did not complete within 30 seconds.")), 30_000);
    });
    const ready = Promise.race([primitive.ready, cancelled, timedOut]);
    const assertOwner = (): void => {
      if (signal?.aborted || ownershipLost || scene.isDestroyed() || scene.primitives.isDestroyed() ||
          primitive.isDestroyed() || !scene.primitives.contains(primitive as unknown as Primitive)) throw creationAborted();
    };
    let removeCollectionListener: (() => void) | undefined;
    const reportCleanupError = (error: unknown): void => {
      try { void Promise.resolve(options.onCleanupError?.(error)).catch(() => undefined); }
      catch { /* diagnostics must not replace the creation result */ }
    };
    // The caller only receives this handle after cleanup has actually failed.
    // Retry destroy even when isDestroyed is already true: that flag stops
    // drawing, while the primitive retains failed native resources for retry.
    const pendingRelease = { destroy(): void {
      const failures: unknown[] = [];
      try {
        if (!viewer.scene.primitives.isDestroyed()) viewer.scene.primitives.remove(primitive as unknown as Primitive);
      } catch (error) { failures.push(error); }
      try { primitive.destroy(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "Point GPU cleanup retry failed.");
    } };
    // A native add/requestRender can throw before the await. Cleanup still
    // rejects the owned ready promise, which must not become unhandled.
    void ready.catch(() => undefined);
    try {
      signal?.addEventListener("abort", onAbort, { once: true });
      // Removal loses this creation's ownership even when the collection was
      // configured not to destroy primitives. The candidate is still ours.
      removeCollectionListener = viewer.scene.primitives.primitiveRemoved.addEventListener(removed => {
        if (removed === primitive) onAbort();
      });
      primitive.setTime(timeMa, rotationMap);
      if (signal?.aborted || scene.isDestroyed() || scene.primitives.isDestroyed()) throw creationAborted();
      viewer.scene.primitives.add(primitive as unknown as Primitive);
      assertOwner();
      // A previous draw/recovery failure stops CesiumWidget's public loop.
      // Hidden candidates still need native update before ready can resolve.
      if (viewer.useDefaultRenderLoop === false) viewer.useDefaultRenderLoop = true;
      assertOwner();
      viewer.scene.requestRender();
      const buildStats = await ready;
      // Ready resolution and ownership loss can occur in the same frame,
      // before this continuation has handed the renderer to its caller.
      assertOwner();
      return new GpuPointRenderer(viewer, primitive, buildStats);
    } catch (error) {
      try {
        try {
          if (!viewer.scene.primitives.isDestroyed()) {
            viewer.scene.primitives.remove(primitive as unknown as Primitive);
          }
        } finally {
          if (!primitive.isDestroyed()) primitive.destroy();
        }
      } catch (cleanupError) {
        try {
          void Promise.resolve(options.onCleanupPending?.(pendingRelease)).catch(reportCleanupError);
        } catch (pendingError) { reportCleanupError(pendingError); }
        if (!options.onCleanupError && !options.onCleanupPending) throw cleanupError;
        reportCleanupError(cleanupError);
      }
      throw error;
    } finally {
      clearTimeout(deadline);
      for (const remove of [() => signal?.removeEventListener("abort", onAbort), removeCollectionListener]) {
        try { remove?.(); } catch (error) { reportCleanupError(error); }
      }
    }
  }

  setTime(
    timeMa: number,
    rotationMap: ReadonlyMap<number, Quaternion>,
  ): void {
    this.primitive.setTime(timeMa, rotationMap);
  }

  setPointSize(pointSize: number): void {
    this.primitive.setPointSize(pointSize);
  }

  setStyle(style: PointStyleExpression): void {
    this.primitive.setStyle(style);
  }

  setOpacity(opacity: number): void {
    this.primitive.setOpacity(opacity);
  }

  setShow(show: boolean): void {
    this.primitive.show = show;
    this.viewer.scene.requestRender();
  }

  /** Inspect the existing native owner; a caller must still wait for postRender. */
  matchesFrameState(timeMa: number, show: boolean): boolean {
    const scene = this.viewer.scene;
    return Number.isFinite(timeMa) && !this.destroyed && !scene.isDestroyed() &&
      !scene.primitives.isDestroyed() && scene.primitives.contains(this.primitive as unknown as Primitive) &&
      this.primitive.matchesFrameState(timeMa, show);
  }

  destroy(): void {
    if (this.destroyed) {
      this.primitive.destroy();
      return;
    }
    this.destroyed = true;
    try {
      if (!this.viewer.scene.primitives.isDestroyed()) {
        this.viewer.scene.primitives.remove(this.primitive as unknown as Primitive);
      }
    } finally {
      if (!this.primitive.isDestroyed()) this.primitive.destroy();
    }
  }
}
