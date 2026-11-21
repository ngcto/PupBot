import { writeFileSync } from "node:fs";
import { COLORS, SHAPES, renderAvatarSvg } from "../src/index.ts";

/**
 * Regenerates `contact-sheet.html`: every shape at 96px, the size ladder this set
 * has to survive (16 / 32 / 64 / 256), and the palette on three shapes. Open it
 * in a browser to judge the family.
 */
function cell(shape: string, color: string, size: number, label?: string) {
  return `<figure><div class="art">${renderAvatarSvg({ shape, color, size })}</div>${
    label ? `<figcaption>${label}</figcaption>` : ""
  }</figure>`;
}

const shapeRows = SHAPES.map((shape) =>
  cell(shape.id, "ember", 96, `${shape.name}<span>${shape.note}</span>`),
).join("");

const sizeRow = (size: number) =>
  `<div class="row">${SHAPES.map((shape) => cell(shape.id, "sky", size)).join("")}</div>`;

const paletteRows = ["circle", "drop", "star4"]
  .map(
    (shape) =>
      `<div class="row palette">${COLORS.map((color) => cell(shape, color.id, 48)).join("")}</div>`,
  )
  .join("");

const SIZES = [16, 32, 64, 96, 256];

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
  .grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 28px 16px; }
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
  <p class="lead">${SHAPES.length} silhouettes traced from the Grok Bot reference, through the
  open-bot-avatar renderer. Deliberately asymmetric: several are tilted or unevenly lobed.</p>
  <h2>Shapes at 96px</h2>
  <div class="grid">${shapeRows}</div>
  <h2>Sizes ${SIZES.join(" / ")}</h2>
  ${SIZES.map((size) => sizeRow(size)).join("")}
  <h2>Palette on circle, drop, star4</h2>
  ${paletteRows}
</main>
</body>
</html>
`;

writeFileSync(new URL("../contact-sheet.html", import.meta.url), html);
console.log(`contact sheet: ${SHAPES.length} shapes, ${COLORS.length} colours, sizes ${SIZES.join("/")}`);
