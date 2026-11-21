/**
 * The product's measured design tokens, as React Native style values.
 * Values come from `handoffs/spec/tokens.json` (sampled from the reference
 * captures) and match the web theme in `packages/ui/src/styles.css`, so the
 * phone looks like the same product rather than a second design.
 */

export const color = {
  bgApp: "#0e0e0e",
  canvas: "#121212",
  surface1: "#1f1f1f",
  surface2: "#232323",
  surface3: "#272727",
  surface4: "#2b2b2b",
  bubbleTop: "#212121",
  bubbleBottom: "#1b1b1b",
  hairline: "#1b1b1b",
  divider: "#1e1e1e",
  card: "#212121",
  input: "#343434",
  strong: "#4e4e4e",
  text: "#f5f5f5",
  textSecondary: "#ababab",
  textTertiary: "#a7a7a7",
  textMuted: "#8d8d8d",
  textFaint: "#707070",
  onAccent: "#f5f5f5",
  success: "#00ba69",
  warning: "#e28600",
  danger: "#ff6463",
  dangerSolid: "#cf2b35",
  focus: "#4ccce0",
  scrim: "rgba(0,0,0,0.72)",
} as const;

export const space = {
  xxs: 2,
  xs: 4,
  xs2: 6,
  sm: 8,
  sm2: 10,
  md: 12,
  md2: 14,
  lg: 16,
  lg2: 20,
  xl: 24,
  xl2: 28,
  xxl: 32,
  xxxl: 40,
  huge: 48,
} as const;

export const radius = {
  xs: 6,
  sm: 8,
  md: 10,
  lg: 12,
  xl: 16,
  pill: 999,
} as const;

export const type = {
  xs: { fontSize: 11, lineHeight: 16, letterSpacing: 0.22 },
  sm: { fontSize: 12, lineHeight: 16 },
  base: { fontSize: 13, lineHeight: 18 },
  body: { fontSize: 14, lineHeight: 22 },
  md: { fontSize: 15, lineHeight: 22 },
  lg: { fontSize: 16, lineHeight: 24, letterSpacing: -0.16 },
  xl: { fontSize: 20, lineHeight: 26, letterSpacing: -0.2 },
  xxl: { fontSize: 22, lineHeight: 28, letterSpacing: -0.22 },
} as const;

export const weight = {
  regular: "400",
  medium: "500",
  semiBold: "600",
  bold: "700",
} as const;

export const motion = {
  fast: 120,
  base: 180,
  panel: 240,
} as const;
