import { writeFileSync } from "node:fs";
import { DEFAULT_COLOR as PACKAGE_COLOR } from "open-bot-avatar";
import { COLORS, DEFAULT_COLOR, SHAPES, renderAvatarSvg } from "../src/index.ts";

/**
 * Regenerates `contact-sheet.html`: all 23 avatars at 96px, the size ladder this
 * set has to survive (16 / 32 / 64 / 96 / 128 / 256), the palette on three of
 * them, and the package's own orange on all of them.
 */
function cell(shape: string, color: string, size: number, label?: string) {
  return `<figure><div class="art">${renderAvatarSvg({ shape, color, size })}</div>${
    label ? `<figcaption>${label}</figcaption>` : ""
  }</figure>`;
}

const shapeRows = SHAPES.map((shape) =>
  cell(shape.id, DEFAULT_COLOR, 96, `${shape.name}<span>${shape.id}</span>`),
).join("");

const sizeRow = (size: number) =>
  `<div class="row">${SHAPES.map((shape) => cell(shape.id, "sky", size)).join("")}</div>`;

const paletteRows = ["controller", "chat", "sprout"]
  .map(
    (shape) =>
      `<div class="row palette">${COLORS.map((color) => cell(shape, color.id, 48)).join("")}</div>`,
  )
  .join("");

const packageRow = `<div class="row palette">${SHAPES.map((shape) =>
  cell(shape.id, PACKAGE_COLOR, 48),
).join("")}</div>`;

const SIZES = [16, 32, 64, 96, 128, 256];

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>PupBot avatars</title>
<style>
  body { margin: 0; background: #0e0e0e; color: #f5f5f5; font: 14px/22px Inter, system-ui, sans-serif; }
  main { max-width: 1040px; margin: 0 auto; padding: 40px 32px 64px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 12px; letter-spacing: .04em; text-transform: uppercase; color: #8d8d8d; margin: 40px 0 16px; }
  p.lead { color: #8d8d8d; margin: 0; }
  .grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 28px 16px; }
  figure { margin: 0; text-align: center; }
  figcaption { margin-top: 10px; font-size: 13px; font-weight: 600; }
  figcaption span { display: block; margin-top: 3px; font-weight: 400; font-size: 12px; color: #8d8d8d; }
  .art { display: flex; justify-content: center; min-height: 16px; }
  .row { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; margin-bottom: 14px; }
  .row.palette { margin-bottom: 6px; }
</style>
</head>
<body>
<main>
  <h1>PupBot avatars</h1>
  <p class="lead">${SHAPES.length} starter avatars from <code>open-bot-avatar</code> 0.3.0, in our
  palette. The definitions, the eyes and the depth are the package's; the colours are ours.</p>
  <h2>Shapes at 96px</h2>
  <div class="grid">${shapeRows}</div>
  <h2>Sizes ${SIZES.join(" / ")}</h2>
  ${SIZES.map((size) => sizeRow(size)).join("")}
  <h2>Palette on controller, chat, sprout</h2>
  ${paletteRows}
  <h2>Package default colour (${PACKAGE_COLOR}) on all ${SHAPES.length}</h2>
  ${packageRow}
</main>
</body>
</html>
`;

writeFileSync(new URL("../contact-sheet.html", import.meta.url), html);
console.log(`contact sheet: ${SHAPES.length} shapes, ${COLORS.length} colours, sizes ${SIZES.join("/")}`);
