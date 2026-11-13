import {
  ImageryLayer,
  Rectangle,
  UrlTemplateImageryProvider,
  Viewer,
  WebMercatorTilingScheme,
} from "cesium";

import { SPHERICAL_EARTH } from "@timemachine/cesium-runtime";
import { AtlasFrameResolver } from "./atlas-frame-resolver";
import type {
  PaleoAtlasFrame,
  PaleoAtlasRuntimeState,
} from "./types";

export type PaleoAtlasStateListener = (
  state: PaleoAtlasRuntimeState,
) => void;

function rootTileUrl(frame: PaleoAtlasFrame): string {
  return frame.tileUrl
    .replace("{z}", "0")
    .replace("{x}", "0")
    .replace("{y}", "0");
}

async function preloadTile(
  frame: PaleoAtlasFrame,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(rootTileUrl(frame), {
    cache: "force-cache",
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `${frame.sourceId} root tile failed with HTTP ${response.status}.`,
    );
  }
  await response.blob();
}

export class PaleoAtlasLayerController {
  private readonly resolver: AtlasFrameResolver;
  private readonly onStateChange: PaleoAtlasStateListener;
  private currentFrame: PaleoAtlasFrame | undefined;
  private currentLayer: ImageryLayer | undefined;
  private incomingLayer: ImageryLayer | undefined;
  private targetSourceId: string | undefined;
  private pendingRequest: AbortController | undefined;
  private switchGeneration = 0;
  private requestedAgeMa = 0;
  private visible = true;
  private opacity = 1;

  constructor(
    private readonly viewer: Viewer,
    resolver: AtlasFrameResolver,
    onStateChange: PaleoAtlasStateListener,
  ) {
    this.resolver = resolver;
    this.onStateChange = onStateChange;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (this.currentLayer) {
      this.currentLayer.show = visible;
    }
    if (this.incomingLayer) {
      this.incomingLayer.show = visible;
    }
    if (!visible) {
      this.onStateChange({
        status: "hidden",
        requestedAgeMa: this.requestedAgeMa,
        reason: "disabled",
      });
    } else {
      this.setTime(this.requestedAgeMa, true);
    }
    this.viewer.scene.requestRender();
  }

  setOpacity(opacity: number): void {
    this.opacity = Math.max(0, Math.min(1, opacity));
    if (this.currentLayer) {
      this.currentLayer.alpha = this.opacity;
    }
    if (this.incomingLayer) {
      this.incomingLayer.alpha = this.opacity;
    }
    this.viewer.scene.requestRender();
  }

  raiseToTop(): void {
    if (
      this.currentLayer &&
      this.viewer.imageryLayers.contains(this.currentLayer)
    ) {
      this.viewer.imageryLayers.raiseToTop(this.currentLayer);
    }
    if (
      this.incomingLayer &&
      this.viewer.imageryLayers.contains(this.incomingLayer)
    ) {
      this.viewer.imageryLayers.raiseToTop(this.incomingLayer);
    }
  }

  setTime(ageMa: number, forceNotification = false): void {
    this.requestedAgeMa = ageMa;
    const frame = this.resolver.resolve(ageMa);
    if (!frame) {
      this.clearLayers();
      this.onStateChange({
        status: "hidden",
        requestedAgeMa: ageMa,
        reason: "out-of-range",
      });
      return;
    }

    if (frame.sourceId === this.targetSourceId) {
      if (forceNotification && this.currentFrame?.sourceId === frame.sourceId) {
        this.notifyReady(frame);
      }
      return;
    }
    this.targetSourceId = frame.sourceId;
    this.startFrameSwitch(frame);
  }

  destroy(): void {
    this.switchGeneration += 1;
    this.pendingRequest?.abort();
    this.clearLayers();
  }

  private startFrameSwitch(frame: PaleoAtlasFrame): void {
    const generation = ++this.switchGeneration;
    this.pendingRequest?.abort();
    this.pendingRequest = new AbortController();
    this.removeLayer(this.incomingLayer);
    this.incomingLayer = undefined;
    this.onStateChange({
      status: "loading",
      requestedAgeMa: this.requestedAgeMa,
      frame,
    });

    void this.switchFrame(frame, generation, this.pendingRequest.signal).catch(
      (error: unknown) => {
        if (generation !== this.switchGeneration) {
          return;
        }
        this.targetSourceId = this.currentFrame?.sourceId;
        this.onStateChange({
          status: "error",
          requestedAgeMa: this.requestedAgeMa,
          frame,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }

  private async switchFrame(
    frame: PaleoAtlasFrame,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    await preloadTile(frame, signal);
    if (generation !== this.switchGeneration) {
      return;
    }

    const bounds = this.resolver.manifest.tiles.bounds;
    const provider = new UrlTemplateImageryProvider({
      url: frame.tileUrl,
      credit: this.resolver.manifest.attribution,
      minimumLevel: this.resolver.manifest.tiles.minimumLevel,
      maximumLevel: this.resolver.manifest.tiles.maximumLevel,
      rectangle: Rectangle.fromDegrees(...bounds),
      tilingScheme: new WebMercatorTilingScheme({
        ellipsoid: SPHERICAL_EARTH,
      }),
      ellipsoid: SPHERICAL_EARTH,
      hasAlphaChannel: false,
      enablePickFeatures: false,
    });
    const nextLayer = new ImageryLayer(provider, {
      alpha: this.visible ? 0 : this.opacity,
      show: this.visible,
    });
    this.incomingLayer = nextLayer;
    this.viewer.imageryLayers.add(nextLayer, 0);
    this.viewer.scene.requestRender();

    const previousLayer = this.currentLayer;
    await this.crossfade(previousLayer, nextLayer, generation);
    if (generation !== this.switchGeneration) {
      this.removeLayer(nextLayer);
      return;
    }

    this.removeLayer(previousLayer);
    nextLayer.alpha = this.opacity;
    nextLayer.show = this.visible;
    this.currentLayer = nextLayer;
    this.currentFrame = frame;
    this.incomingLayer = undefined;
    this.pendingRequest = undefined;
    this.notifyReady(frame);
    this.preloadAdjacentFrames(frame);
    this.viewer.scene.requestRender();
  }

  private crossfade(
    previousLayer: ImageryLayer | undefined,
    nextLayer: ImageryLayer,
    generation: number,
  ): Promise<void> {
    if (!this.visible) {
      nextLayer.alpha = this.opacity;
      return Promise.resolve();
    }
    const durationMs = 220;
    const start = performance.now();
    return new Promise((resolve) => {
      const animate = (now: number): void => {
        if (generation !== this.switchGeneration) {
          resolve();
          return;
        }
        const progress = Math.min(1, (now - start) / durationMs);
        nextLayer.alpha = progress * this.opacity;
        if (previousLayer) {
          previousLayer.alpha = (1 - progress) * this.opacity;
        }
        this.viewer.scene.requestRender();
        if (progress < 1) {
          requestAnimationFrame(animate);
        } else {
          resolve();
        }
      };
      requestAnimationFrame(animate);
    });
  }

  private preloadAdjacentFrames(frame: PaleoAtlasFrame): void {
    for (const adjacentFrame of this.resolver.adjacent(frame)) {
      void preloadTile(adjacentFrame).catch(() => {
        // Adjacent-frame warming is opportunistic; the selected frame remains valid.
      });
    }
  }

  private notifyReady(frame: PaleoAtlasFrame): void {
    if (!this.visible) {
      this.onStateChange({
        status: "hidden",
        requestedAgeMa: this.requestedAgeMa,
        reason: "disabled",
      });
      return;
    }
    this.onStateChange({
      status: "ready",
      requestedAgeMa: this.requestedAgeMa,
      frame,
    });
  }

  private clearLayers(): void {
    this.switchGeneration += 1;
    this.pendingRequest?.abort();
    this.pendingRequest = undefined;
    this.removeLayer(this.incomingLayer);
    this.removeLayer(this.currentLayer);
    this.incomingLayer = undefined;
    this.currentLayer = undefined;
    this.currentFrame = undefined;
    this.targetSourceId = undefined;
    this.viewer.scene.requestRender();
  }

  private removeLayer(layer: ImageryLayer | undefined): void {
    if (layer && this.viewer.imageryLayers.contains(layer)) {
      this.viewer.imageryLayers.remove(layer, true);
    }
  }
}
