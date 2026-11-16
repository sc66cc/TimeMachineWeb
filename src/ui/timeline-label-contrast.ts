/**
 * Label-only contrast maths for the geological timeline bands.
 *
 * The bands keep their data colours; this module only decides whether the
 * label on a band is black or white, and it picks the option with the higher
 * WCAG 2.x sRGB contrast ratio. Because the two candidates are the extremes of
 * the luminance range, the winner is never below 1.05 / 0.05 = 21 : 1 at the
 * ends and never below sqrt(1.05 / 0.05) ≈ 4.58 : 1 at the crossover, so every
 * opaque band colour clears the 4.5 : 1 AA requirement for normal text.
 *
 * Deliberately pure: no DOM, no data, no theme tokens.
 */

/** The two candidate label colours. */
export type TimelineLabelColor = "#ffffff" | "#000000";

const LABEL_LIGHT: TimelineLabelColor = "#ffffff";
const LABEL_DARK: TimelineLabelColor = "#000000";
/** Luminance where white and black label contrast is equal (≈4.58 : 1). */
const LABEL_CROSSOVER = Math.sqrt(1.05 / 0.05) * 0.05 - 0.05;

function channel(value: number): number {
  const srgb = value / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

/**
 * Reads `#rgb`, `#rrggbb`, `rgb(...)` or `rgba(...)` (opaque channels only,
 * because the timeline never draws a band over a translucent backdrop).
 */
function srgbChannels(color: string): [number, number, number] {
  const value = color.trim().toLowerCase();
  if (value.startsWith("#")) {
    const hex = value.slice(1);
    if (hex.length === 3) {
      const [r, g, b] = [...hex].map((digit) => Number.parseInt(digit + digit, 16));
      if (r !== undefined && g !== undefined && b !== undefined) return [r, g, b];
    }
    if (hex.length === 6) {
      const r = Number.parseInt(hex.slice(0, 2), 16);
      const g = Number.parseInt(hex.slice(2, 4), 16);
      const b = Number.parseInt(hex.slice(4, 6), 16);
      if (![r, g, b].some(Number.isNaN)) return [r, g, b];
    }
  }
  const rgb = /^rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)/.exec(value);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  throw new Error(`Unsupported timeline colour: ${color}`);
}

/** WCAG relative luminance of an opaque sRGB colour. */
export function relativeLuminance(color: string): number {
  const [r, g, b] = srgbChannels(color);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two opaque sRGB colours (1 … 21). */
export function contrastRatio(background: string, foreground: string): number {
  const first = relativeLuminance(background);
  const second = relativeLuminance(foreground);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/** Black or white, whichever reads better on `background`. */
export function readableLabelColor(background: string): TimelineLabelColor {
  return relativeLuminance(background) <= LABEL_CROSSOVER ? LABEL_LIGHT : LABEL_DARK;
}

/**
 * The halo is only useful behind light labels; behind dark labels it darkens
 * the backdrop the glyph actually sits on and lowers the effective contrast.
 */
export function labelTextShadow(label: TimelineLabelColor): string {
  return label === LABEL_LIGHT ? "0 1px 2px rgb(0 0 0 / 45%)" : "none";
}
