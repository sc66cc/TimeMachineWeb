// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { contrastRatio } from "../ui/timeline-label-contrast";
import { mountAppShell } from "./support/mount-app-shell";

/**
 * The four workspace HUD blocks (`#age-value`/`Ma`, `#era-label`,
 * `#projection-status`, `#mesh-stat` + `#plate-model-status`) are drawn on top
 * of the Cesium canvas, whose colour is map data and therefore unknowable per
 * pixel. Instead of sampling map pixels, each block owns a small **opaque**
 * surface, so the effective ratio is a computed colour pair. This file checks
 * the declared pair, the declared geometry guard and the DOM contract; the live
 * browser pass measures the same values on the real build.
 *
 * The Cesium credit band is app-styled (never source-patched): it must stay
 * visible, clickable and readable, so its rules may not hide it, shrink it
 * below 11px or dim it.
 */

const css = readFileSync(resolve(process.cwd(), "src/style.css"), "utf8");

/** Returns the declarations of the first block whose selector list matches. */
function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)\\s*([^{}]*${escaped}[^{}]*)\\{([^}]*)\\}`, "m").exec(css);
  if (!match) throw new Error(`no CSS block for ${selector}`);
  return match[2]!;
}

function declaration(source: string, property: string): string | undefined {
  const match = new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([^;]+);`).exec(source);
  return match?.[1]?.trim();
}

/** Concatenated bodies of every media block for a max-width query. */
function mediaBlock(query: string): string {
  const header = `@media (${query})`;
  const bodies: string[] = [];
  let from = 0;
  for (;;) {
    const start = css.indexOf(header, from);
    if (start < 0) break;
    let depth = 0;
    let end = -1;
    for (let index = css.indexOf("{", start); index < css.length; index += 1) {
      const character = css[index]!;
      if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end < 0) throw new Error(`unterminated ${header}`);
    bodies.push(css.slice(start, end + 1));
    from = end + 1;
  }
  if (bodies.length === 0) throw new Error(`no ${header}`);
  return bodies.join("\n");
}

/** True only for an opaque colour: hex6, rgb() or a fully opaque rgba(). */
function isOpaque(color: string | undefined): boolean {
  if (!color) return false;
  const value = color.toLowerCase().replace(/\s+/g, "");
  if (/^#[0-9a-f]{6}$/.test(value)) return true;
  if (/^rgb\(\d+,\d+,\d+\)$/.test(value)) return true;
  const rgba = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(value);
  return rgba ? Number(rgba[4]) === 1 : false;
}

function readablePair(foreground: string, background: string): number {
  return contrastRatio(background, foreground);
}

const HUD_SURFACES: Array<{ selector: string; panel: string }> = [
  { selector: ".time-readout", panel: "#0b141b" },
  { selector: ".era-label", panel: "#0b141b" },
  { selector: ".projection-status", panel: "#0b141b" },
  { selector: ".map-caption", panel: "#0b141b" },
];

describe("canvas HUD surfaces are opaque, not halo-dependent", () => {
  it("declares an opaque background and drops the black text halo", () => {
    for (const { selector, panel } of HUD_SURFACES) {
      const declarations = block(selector);
      expect(isOpaque(declaration(declarations, "background")), selector).toBe(true);
      expect(declaration(declarations, "background"), selector).toBe(panel);
      // The halo is what could not be certified; an opaque panel replaces it.
      expect(declaration(declarations, "text-shadow"), selector).toBe("none");
      // A small rounded surface, never a full-width banner.
      expect(declaration(declarations, "border-radius"), selector).toBeTruthy();
      expect(declaration(declarations, "opacity"), selector).toBeUndefined();
    }
  });

  it("keeps the caption shrink-to-fit and click-through", () => {
    const caption = block(".map-caption");
    expect(declaration(caption, "pointer-events")).toBe("none");
    expect(declaration(caption, "width")).toBe("fit-content");
    expect(declaration(caption, "margin-inline")).toBe("auto");
  });

  it("clears 4.5:1 for every declared HUD foreground on its own panel", () => {
    // `.time-readout` is #fff and covers both `#age-value` and the `Ma` unit;
    // the unit span must not override the colour.
    expect(readablePair("#ffffff", "#0b141b")).toBeGreaterThanOrEqual(4.5);
    expect(declaration(block(".time-readout span"), "color")).toBeUndefined();
    expect(readablePair("#dce6ea", "#0b141b")).toBeGreaterThanOrEqual(4.5); // #era-label, #projection-status
    expect(readablePair("#ffe6a8", "#0b141b")).toBeGreaterThanOrEqual(4.5); // status[data-state=preparing]
    expect(readablePair("#ffb4a2", "#0b141b")).toBeGreaterThanOrEqual(4.5); // status[data-state=error]
    expect(readablePair("#d3d3d3", "#0b141b")).toBeGreaterThanOrEqual(4.5); // #mesh-stat
    expect(readablePair("#9fb6bd", "#0b141b")).toBeGreaterThanOrEqual(4.5); // #plate-model-status
    expect(readablePair("#ffb4a2", "#0b141b")).toBeGreaterThanOrEqual(4.5); // .plate-model-status.is-error
  });

  it("keeps the idle live region from painting an empty bar", () => {
    const idle = block(".projection-status:empty");
    expect(declaration(idle, "background")).toBe("none");
    expect(declaration(idle, "padding")).toBe("0");
  });

  it("keeps the padded HUD stack from overlapping the next block", () => {
    // Readout: top 82 + 2px padding + 22px/1.1 line box + 2px padding = 110.2.
    const readoutTop = Number.parseFloat(declaration(block(".time-readout"), "top")!);
    const readoutPadding = Number.parseFloat(declaration(block(".time-readout"), "padding")!);
    const readoutHeight = 22 * 1.1 + 2 * readoutPadding;
    const eraTop = Number.parseFloat(declaration(block(".era-label"), "top")!);
    expect(readoutTop + readoutHeight).toBeLessThanOrEqual(eraTop);

    // Era label: one 11px line at a deliberately generous 1.5 bound + padding.
    const eraPadding = Number.parseFloat(declaration(block(".era-label"), "padding")!);
    const optionsTop = Number.parseFloat(declaration(block(".view-options"), "top")!);
    expect(eraTop + 11 * 1.5 + 2 * eraPadding).toBeLessThanOrEqual(optionsTop);
  });
});

describe("Cesium credit band", () => {
  const band = block("#cesium-container .cesium-viewer-bottom");
  const credits = block("#cesium-container .cesium-widget-credits");

  it("is placed clear of the playback card's bottom-left corner", () => {
    // The credit display writes `style="left: 5px; bottom: 3px; right: 0px"`
    // inline at runtime, so only the offsets may (and must) be forced.
    expect(declaration(band, "left")).toBe("auto !important");
    expect(declaration(band, "right")).toBe("4px !important");
    expect(declaration(band, "bottom")).toBe("44px !important");
    // Playback: left 7 + width 329 => the card ends at x=336; 50% of the map
    // keeps the right-aligned band clear of it on any desktop width.
    expect(declaration(band, "max-width")).toBe("50%");
  });

  it("stays readable: 11px white on the same opaque surface, no dimming", () => {
    expect(declaration(credits, "opacity")).toBe("1");
    expect(declaration(credits, "font-size")).toBe("11px");
    expect(declaration(credits, "text-shadow")).toBe("none");
    expect(isOpaque(declaration(credits, "background"))).toBe(true);
    expect(readablePair("#ffffff", "#0b141b")).toBeGreaterThanOrEqual(4.5);
  });

  it("is never hidden or forged by app CSS", () => {
    const creditRules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((match) =>
      /cesium-credit|cesium-widget-credits|cesium-viewer-bottom/.test(match[1]!),
    );
    expect(creditRules.length).toBeGreaterThan(0);
    for (const [, selector, declarations] of creditRules) {
      expect(selector, selector).not.toMatch(/display\s*:\s*none/);
      expect(declaration(declarations!, "display"), selector).not.toBe("none");
      expect(declaration(declarations!, "visibility"), selector).not.toBe("hidden");
      const opacity = declaration(declarations!, "opacity");
      if (opacity !== undefined) expect(Number.parseFloat(opacity), selector).toBe(1);
      // A forced declaration is allowed only for placement offsets (Cesium
      // writes those inline); it may never force a hiding, dimming or type size.
      for (const [, property] of declarations!.matchAll(/([a-z-]+)\s*:\s*[^;]*?!important/g)) {
        expect(["left", "right", "bottom", "top"], `${selector} ${property}`).toContain(property);
      }
    }
  });

  it("wraps inside the strip left free by the phone transport panel", () => {
    const phone = mediaBlock("max-width: 740px");
    expect(phone).toMatch(/#cesium-container \.cesium-viewer-bottom \{[^}]*max-width: 100px/);
    // 100px cap + 4px offset sits inside the 110px strip the card leaves free.
    expect(phone).toMatch(/\.playback \{[^}]*width: calc\(100% - 116px\)/);
  });

  it("steps above the card when the open sidebar shifts the chrome right", () => {
    const tablet = mediaBlock("max-width: 1180px");
    expect(tablet).toMatch(
      /\.stage:not\(\[data-sidebar-hidden="true"\]\) #cesium-container \.cesium-viewer-bottom \{\s*(?:\/\*[\s\S]*?\*\/\s*)?bottom: 148px !important/,
    );
  });
});

describe("HUD DOM contract", () => {
  let mounted: Awaited<ReturnType<typeof mountAppShell>> | undefined;
  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
  });

  it("keeps the boot-captured HUD nodes and their element types", async () => {
    mounted = await mountAppShell();
    const expectNode = <K extends keyof HTMLElementTagNameMap>(selector: string, tag: K) => {
      const element = document.querySelector(selector);
      expect(element, selector).not.toBeNull();
      expect(element!.tagName, selector).toBe(tag.toUpperCase());
    };
    expectNode("#age-value", "strong");
    expectNode("#era-label", "p");
    expectNode("#projection-status", "p");
    expectNode("#mesh-stat", "span");
    expectNode("#plate-model-status", "span");

    const readout = document.querySelector(".time-readout")!;
    expect(readout.querySelector("#age-value")!.nextElementSibling?.tagName).toBe("SPAN");
    expect(document.querySelector("#projection-status")!.getAttribute("aria-live")).toBe("polite");

    const caption = document.querySelector(".map-caption")!;
    expect(caption.children.length).toBe(2);
    expect(caption.querySelector("#mesh-stat")!.textContent).toBeTruthy();
    expect(caption.querySelector("#plate-model-status")!.classList.contains("plate-model-status")).toBe(true);

    // The readouts keep writing through their own text nodes: a mount must not
    // have replaced them with a component that owns the text.
    expect(document.querySelector("#age-value")!.childNodes.length).toBe(1);
    expect(document.querySelector("#era-label")!.childNodes.length).toBe(1);
  });
});
