import tokensCss from "../styles/tokens.css?raw";

/**
 * The design closure forbids green as an accent, status or chart colour.
 * Instead of trusting a visual pass, this test parses the design tokens and
 * rejects any chromatic colour whose hue sits in the green band.
 */

type Hsl = { h: number; s: number; l: number };

function hexToHsl(hex: string): Hsl {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
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

/** Green band in HSL degrees; below the saturation floor a colour is neutral grey. */
const GREEN_MIN_HUE = 75;
const GREEN_MAX_HUE = 165;
const SATURATION_FLOOR = 0.12;

function isChromaticGreen(hex: string): boolean {
  const { h, s } = hexToHsl(hex);
  return s >= SATURATION_FLOOR && h >= GREEN_MIN_HUE && h <= GREEN_MAX_HUE;
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

  it("detects green and spares neutral or blue colours (self-check)", () => {
    expect(isChromaticGreen("#22c55e")).toBe(true);
    expect(isChromaticGreen("#16a34a")).toBe(true);
    expect(isChromaticGreen("#f4f5f5")).toBe(false);
    expect(isChromaticGreen("#233c78")).toBe(false);
    expect(isChromaticGreen("#b88032")).toBe(false);
    expect(isChromaticGreen("#ffffff")).toBe(false);
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
    const { h, s } = hexToHsl(accent!.hex);
    expect(s).toBeGreaterThan(SATURATION_FLOOR);
    expect(h).toBeGreaterThanOrEqual(200);
    expect(h).toBeLessThanOrEqual(260);
  });

  it("uses no green keywords in raw token values", () => {
    expect(css).not.toMatch(/\b(green|lime|emerald|jade|mint|teal|chartreuse)\b/i);
  });
});
