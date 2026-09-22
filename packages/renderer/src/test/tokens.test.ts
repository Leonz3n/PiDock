import tokensCss from "../styles/tokens.css?raw";

/**
 * The design closure forbids green as an accent, status or chart colour.
 * Instead of trusting a visual pass, this test parses the design tokens and the
 * shipped component sources, normalises every colour form a source can carry
 * (hex, `rgb()`/`rgba()`, `hsl()`/`hsla()`, including Tailwind arbitrary-value
 * escapes like `text-[#00ff00]` or `bg-[rgb(0,255,0)]`) and rejects any
 * chromatic colour whose hue sits in the green band.
 */

type Hsl = { h: number; s: number; l: number };

function hexToHsl(hex: string): Hsl {
  const value = hex.replace("#", "");
  const expanded = value.length === 3 || value.length === 4 ? value.slice(0, 3).split("").map((c) => c + c).join("") : value.slice(0, 6);
  const r = parseInt(expanded.slice(0, 2), 16) / 255;
  const g = parseInt(expanded.slice(2, 4), 16) / 255;
  const b = parseInt(expanded.slice(4, 6), 16) / 255;
  return rgbToHsl(r, g, b);
}

function rgbToHsl(r: number, g: number, b: number): Hsl {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const l = (max + min) / 2;
  if (delta === 0) return { h: 0, s: 0, l };
  const s = delta / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = 60 * (((g - b) / delta) % 6);
  else if (max === g) h = 60 * ((b - r) / delta + 2);
  else h = 60 * ((r - g) / delta + 4);
  if (h < 0) h += 360;
  return { h, s, l };
}

function channel(token: string): number {
  const value = token.trim();
  if (value.endsWith("%")) return Math.min(1, Math.max(0, Number.parseFloat(value) / 100));
  return Math.min(1, Math.max(0, Number.parseFloat(value) / 255));
}

function splitArgs(inner: string): string[] {
  return inner.replace(/_/g, " ").split(/[\s,/]+/).filter(Boolean);
}

/** Parse the colour forms a component source can contain. `null` when not a colour. */
export function parseColorLiteral(raw: string): Hsl | null {
  const value = raw.trim();
  if (value.startsWith("#")) return hexToHsl(value);
  const rgb = value.match(/^rgba?\(([^)]*)\)$/i);
  if (rgb) {
    const [r, g, b] = splitArgs(rgb[1]).map(channel);
    if (r === undefined || g === undefined || b === undefined) return null;
    return rgbToHsl(r, g, b);
  }
  const hsl = value.match(/^hsla?\(([^)]*)\)$/i);
  if (hsl) {
    const [h, s, l] = splitArgs(hsl[1]).map((token) => Number.parseFloat(token));
    if (![h, s, l].every((part) => Number.isFinite(part))) return null;
    return { h: ((h % 360) + 360) % 360, s: s / 100, l: l / 100 };
  }
  return null;
}

/** Green band in HSL degrees; below the saturation floor a colour is neutral grey. */
const GREEN_MIN_HUE = 75;
const GREEN_MAX_HUE = 165;
const SATURATION_FLOOR = 0.12;

export function isChromaticGreen(color: string): boolean {
  const hsl = parseColorLiteral(color);
  return hsl !== null && hsl.s >= SATURATION_FLOOR && hsl.h >= GREEN_MIN_HUE && hsl.h <= GREEN_MAX_HUE;
}

/** Any colour literal, including the ones inside Tailwind arbitrary-value escapes. */
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\([^)]*\)/g;

export function colorLiterals(source: string): string[] {
  return [...source.matchAll(COLOR_LITERAL)].map((match) => match[0]);
}

export function greenLiterals(source: string): string[] {
  return colorLiterals(source).filter((literal) => isChromaticGreen(literal));
}

function tokenColors(css: string): { name: string; hex: string }[] {
  return [...css.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\b/g)].map((match) => ({
    name: match[1],
    hex: match[2],
  }));
}

describe("design tokens carry no green", () => {
  const css = tokensCss;
  const colors = tokenColors(css);

  it("detects green across hex, rgb() and hsl() forms and spares neutral or blue colours (self-check)", () => {
    expect(isChromaticGreen("#22c55e")).toBe(true);
    expect(isChromaticGreen("#0f0")).toBe(true);
    expect(isChromaticGreen("#00ff00")).toBe(true);
    expect(isChromaticGreen("rgb(34, 197, 94)")).toBe(true);
    expect(isChromaticGreen("rgb(0 255 0)")).toBe(true);
    expect(isChromaticGreen("hsl(120, 60%, 40%)")).toBe(true);
    expect(isChromaticGreen("hsl(120 60% 40% / 0.5)")).toBe(true);

    expect(isChromaticGreen("#f4f5f5")).toBe(false);
    expect(isChromaticGreen("#233c78")).toBe(false);
    expect(isChromaticGreen("#b88032")).toBe(false);
    expect(isChromaticGreen("#ffffff")).toBe(false);
    expect(isChromaticGreen("rgb(246, 247, 248)")).toBe(false);
    expect(isChromaticGreen("rgb(35, 60, 120)")).toBe(false);
    expect(isChromaticGreen("hsl(210 60% 40%)")).toBe(false);
    expect(isChromaticGreen("hsl(0 0% 50%)")).toBe(false);
  });

  it("flags green hidden in arbitrary-value escapes, and still spares a blue one (self-check)", () => {
    expect(greenLiterals('className="text-[#00ff00]"')).toEqual(["#00ff00"]);
    expect(greenLiterals('className="bg-[rgb(0,255,0)]"')).toEqual(["rgb(0,255,0)"]);
    expect(greenLiterals('className="text-[hsl(120_60%_40%)]"')).toEqual(["hsl(120_60%_40%)"]);
    expect(greenLiterals('className="text-[#0be]"')).toEqual([]);
    expect(greenLiterals('className="text-accent bg-[#233c78]"')).toEqual([]);
  });

  it("parses the required tokens", () => {
    expect(colors.length).toBeGreaterThanOrEqual(9);
    expect(colors.map((color) => color.name)).toEqual(
      expect.arrayContaining(["--color-accent", "--color-bg", "--color-ink", "--color-muted", "--color-line"]),
    );
  });

  it("keeps every colour out of the green band", () => {
    const offenders = colors.filter((color) => isChromaticGreen(color.hex));
    expect(offenders).toEqual([]);
  });

  it("keeps the accent in the blue band", () => {
    const accent = colors.find((color) => color.name === "--color-accent");
    expect(accent).toBeDefined();
    const { h, s } = parseColorLiteral(accent!.hex)!;
    expect(s).toBeGreaterThan(SATURATION_FLOOR);
    expect(h).toBeGreaterThanOrEqual(200);
    expect(h).toBeLessThanOrEqual(260);
  });

  it("uses no green keywords or green rgb()/hsl() literals in raw token values", () => {
    expect(css).not.toMatch(/\b(green|lime|emerald|jade|mint|teal|chartreuse)\b/i);
    expect(greenLiterals(css)).toEqual([]);
  });
});

/** TSX and store sources shipped to the renderer, excluding tests and fixtures. */
const componentSources = import.meta.glob(
  ["../components/**/*.{ts,tsx}", "../pages/**/*.{ts,tsx}", "../stores/**/*.ts", "../data/**/*.ts", "../*.tsx"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

/** Tailwind palette utilities (text-green-500, bg-green-50 …). */
const GREEN_UTILITY = /\b(?:text|bg|border|from|via|to|ring|outline|divide|fill|stroke|accent|caret|decoration|placeholder|shadow)-green-\d{2,3}\b/;
const GREEN_KEYWORD = /\b(green|lime|emerald|jade|mint|chartreuse)\b/i;

describe("component sources carry no green either", () => {
  it("flags a Tailwind green utility (self-check)", () => {
    expect(GREEN_UTILITY.test('className="text-green-500"')).toBe(true);
    expect(GREEN_UTILITY.test('className="bg-green-50 border-green-200"')).toBe(true);
    expect(GREEN_UTILITY.test('className="text-accent bg-soft"')).toBe(false);
  });

  it("collected the renderer sources to scan", () => {
    expect(Object.keys(componentSources).length).toBeGreaterThan(10);
    expect(Object.keys(componentSources).some((file) => file.endsWith("TaskPage.tsx"))).toBe(true);
  });

  it("uses no Tailwind green utility in components", () => {
    const offenders = Object.entries(componentSources).filter(([, source]) => GREEN_UTILITY.test(source));
    expect(offenders.map(([file]) => file)).toEqual([]);
  });

  it("uses no green keyword in component sources", () => {
    const offenders = Object.entries(componentSources).filter(([, source]) => GREEN_KEYWORD.test(source));
    expect(offenders.map(([file]) => file)).toEqual([]);
  });

  it("uses no chromatic green colour literal in component sources", () => {
    const offenders = Object.entries(componentSources)
      .map(([file, source]) => ({ file, greens: greenLiterals(source) }))
      .filter((entry) => entry.greens.length > 0);
    expect(offenders).toEqual([]);
  });
});
