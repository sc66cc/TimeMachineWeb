// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  contrastRatio,
  labelTextShadow,
  readableLabelColor,
  relativeLuminance,
} from "../ui/timeline-label-contrast";
import { mountAppShell } from "./support/mount-app-shell";

/**
 * The timeline band colours are scientific data and stay exactly as declared;
 * this file checks the label colours chosen on top of them. All comparisons run
 * on the real rendered bands (every row, every segment), not on a sample.
 */

let mounted: Awaited<ReturnType<typeof mountAppShell>> | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

/** Bands whose data colour must survive untouched, across the brightness range. */
const DATA_COLOURS = [
  "#4fae9e", // mid green-cyan → light label
  "#d8bc77", // pale ochre
  "#e5ee4a", // bright yellow-green → dark label
  "#9666bb", // mid purple
  "#75bed4", // eon band
];

async function renderBands(): Promise<HTMLElement[]> {
  mounted = await mountAppShell();
  return [...document.querySelectorAll<HTMLElement>(".segment")];
}

describe("timeline label contrast helper", () => {
  it("matches the WCAG sRGB reference values", () => {
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
    expect(relativeLuminance("#808080")).toBeCloseTo(0.2158, 3);
    expect(relativeLuminance("rgb(128, 128, 128)")).toBeCloseTo(0.2158, 3);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });

  it("always picks the higher of the two ratios, so no opaque band drops under 4.58", () => {
    for (let channel = 0; channel <= 255; channel += 15) {
      const hex = `#${channel.toString(16).padStart(2, "0").repeat(3)}`;
      const label = readableLabelColor(hex);
      expect(label === "#ffffff" || label === "#000000").toBe(true);
      expect(contrastRatio(hex, label)).toBeGreaterThanOrEqual(4.58);
      // The loser is never better than the winner.
      const other = label === "#ffffff" ? "#000000" : "#ffffff";
      expect(contrastRatio(hex, label)).toBeGreaterThanOrEqual(contrastRatio(hex, other));
    }
  });

  it("keeps the halo only behind light labels", () => {
    expect(labelTextShadow("#ffffff")).toContain("rgb(0 0 0 / 45%)");
    expect(labelTextShadow("#000000")).toBe("none");
  });
});

describe("rendered geological bands", () => {
  it("keeps every data colour and clears AA for every label in every row", async () => {
    const bands = await renderBands();
    // 26 stages + 22 series + 11 periods + 3 eras + 1 eon.
    expect(bands.length).toBeGreaterThanOrEqual(63);
    const rows = new Map<string, number>();
    for (const band of bands) {
      const row = band.closest(".timeline-row")?.className ?? "";
      rows.set(row, (rows.get(row) ?? 0) + 1);
      const background = band.style.backgroundColor;
      const color = band.style.color;
      expect(background, band.title).not.toBe("");
      expect(["rgb(255, 255, 255)", "rgb(0, 0, 0)"], `${band.title}: ${color}`).toContain(color);
      expect(contrastRatio(background, color), `${band.title} (${background})`).toBeGreaterThanOrEqual(4.5);
      // The halo must not sit behind a dark label: it would lower the ratio.
      expect(band.style.textShadow === "none").toBe(color === "rgb(0, 0, 0)");
    }
    expect([...rows.keys()].join(" ")).toMatch(/stages/);
    expect([...rows.keys()].join(" ")).toMatch(/periods/);
    expect([...rows.keys()].join(" ")).toMatch(/eras/);
    expect([...rows.keys()].join(" ")).toMatch(/\beon\b/);
  });

  it("never recolours the science bands to reach the contrast target", async () => {
    const bands = await renderBands();
    const rendered = new Set(bands.map((band) => band.style.backgroundColor));
    // rgb(...) form of the declared data colours.
    const declared = DATA_COLOURS.map((hex) => {
      const value = hex.slice(1);
      const [r, g, b] = [0, 2, 4].map((start) => Number.parseInt(value.slice(start, start + 2), 16));
      return `rgb(${r}, ${g}, ${b})`;
    });
    for (const colour of declared) expect(rendered.has(colour), colour).toBe(true);
  });
});

describe("UI control boundary token", () => {
  it("keeps the input edge at or above 3:1 on white, card and pale surfaces", () => {
    const css = readFileSync(resolve(process.cwd(), "src/vueui/theme.css"), "utf8");
    const token = /--input:\s*(#[0-9a-fA-F]{6})/.exec(css)?.[1];
    expect(token, "--input token").toBeTruthy();
    const input = token!;
    expect(contrastRatio(input, "#ffffff")).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(input, "#f7f9fc")).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(input, "#eef2f7")).toBeGreaterThanOrEqual(3);
    // The focus ring must stay the stronger cue.
    const ring = /--ring:\s*(#[0-9a-fA-F]{6})/.exec(css)?.[1]!;
    expect(contrastRatio(ring, "#ffffff")).toBeGreaterThanOrEqual(3);
  });
});
