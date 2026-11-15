import { RequestState, Resource, UrlTemplateImageryProvider } from "cesium";

/** Observe this provider instance without changing Cesium's scheduling contract. */
export class ObservedAtlasProvider extends UrlTemplateImageryProvider {
  requested = 0;
  succeeded = 0;
  pending = 0;
  private observer: { onProgress: () => void; onFailure: (error: unknown) => void } | undefined;
  private readonly sparseResource: Resource | undefined;
  private emptyTile: HTMLCanvasElement | undefined;

  constructor(options: UrlTemplateImageryProvider.ConstructorOptions, emptyTilePolicy?: "transparent-204") {
    super({ ...options, hasAlphaChannel: emptyTilePolicy ? true : options.hasAlphaChannel });
    // This explicit source protocol is only for plain XYZ raster tiles. Atlas
    // and unmarked sources retain Cesium's native image-loading path.
    if (emptyTilePolicy === "transparent-204") {
      this.sparseResource = typeof options.url === "string" ? new Resource({ url: options.url }) : options.url.clone();
      const tags = [...this.sparseResource.url.matchAll(/\{([^}]+)\}/g)].map(match => match[1]);
      if (["x", "y", "z"].some(tag => !tags.includes(tag)) || tags.some(tag => !["x", "y", "z"].includes(tag!)) || options.customTags) {
        throw new Error("Sparse raster tiles require a plain XYZ URL template.");
      }
    }
  }

  observe(onProgress: () => void, onFailure: (error: unknown) => void): () => void {
    const observer = { onProgress, onFailure };
    this.observer = observer;
    return () => { if (this.observer === observer) this.observer = undefined; };
  }

  override requestImage(...args: Parameters<UrlTemplateImageryProvider["requestImage"]>): ReturnType<UrlTemplateImageryProvider["requestImage"]> {
    let image: ReturnType<UrlTemplateImageryProvider["requestImage"]>;
    try {
      if (this.sparseResource) {
        const [x, y, level, request] = args;
        const resource = this.sparseResource.getDerivedResource({ templateValues: { x, y, z: level }, request });
        const pending = resource.fetchImage({ preferBlob: true, preferImageBitmap: true, flipY: true });
        // Immediate undefined remains scheduler throttling. In the locked
        // Resource Blob path only an HTTP 204 resolves without an image;
        // 200 empty/bad images and transport errors still reject normally.
        image = pending?.then(value => {
          if (value !== undefined) return value;
          if (!this.emptyTile) {
            this.emptyTile = document.createElement("canvas");
            this.emptyTile.width = this.tileWidth;
            this.emptyTile.height = this.tileHeight;
          }
          return this.emptyTile;
        });
      } else image = super.requestImage(...args);
    }
    catch (error) { this.observer?.onFailure(error); throw error; }
    // Undefined is Cesium's throttling signal, not a successful image request.
    if (image === undefined) return undefined;
    this.requested += 1;
    this.pending += 1;
    return image.then(value => {
      this.pending -= 1;
      if (value === undefined) {
        this.observer?.onFailure(new Error("Atlas image request returned no image."));
      } else {
        this.succeeded += 1;
        this.observer?.onProgress();
      }
      return value;
    }, error => {
      this.pending -= 1;
      // Cesium cancels low-priority tiles while navigating, then retries them.
      // Preserve its rejection path without cancelling the whole Atlas frame.
      if (args[3]?.state !== RequestState.CANCELLED) this.observer?.onFailure(error);
      throw error;
    });
  }
}
