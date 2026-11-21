import { readFileSync } from "node:fs";

// Renders the CUA index through the product renderer and prices it through a real
// `tools` block. Run from this directory; needs ANTHROPIC_API_KEY and
// ANTHROPIC_BASE_URL.
import { renderIndex } from "../../packages/tools/src/index.ts";

const KEY = process.env.ANTHROPIC_API_KEY!, BASE = process.env.ANTHROPIC_BASE_URL!;
async function tokens(body: any): Promise<number> {
  const r = await fetch(`${BASE}/v1/messages/count_tokens`, {
    method: "POST",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: "x" }], ...body }),
  });
  const j: any = await r.json();
  if (j.input_tokens === undefined) throw new Error(JSON.stringify(j).slice(0, 300));
  return j.input_tokens;
}

// Map the CUA tool-index data (TERA-74's) into our entry shape, without copying it into our package.
const raw = JSON.parse(readFileSync(new URL("./index.json", import.meta.url), "utf8"));
const entries = raw.map((e: any) => ({
  // Exactly what the product does: `toIdentifier` leaves camelCase alone, so the
  // rendered name is `observeWindow`, not `observe_window`. Rendering a different
  // name here would price something the model never sees.
  name: e.name,
  description: e.description, when: e.when, category: e.category, cost: e.cost,
  ...(e.resultNote ? { resultNote: e.resultNote } : {}),
}));
const index = renderIndex(entries);
const empty = await tokens({});
const bare = await tokens({ tools: [{ name: "codemode",
  description: "Run JavaScript that calls tools as await tools.<name>(args); output with text() or return.",
  input_schema: { type: "object", properties: { code: { type: "string", description: "the program" } }, required: ["code"] } }] });
const withIndex = await tokens({ tools: [{ name: "codemode",
  description: index,
  input_schema: { type: "object", properties: { code: { type: "string", description: "the program" } }, required: ["code"] } }] });
const names = await tokens({ system: entries.map((e: any) => e.name).join(", ") });

console.log(JSON.stringify({
  entries: entries.length,
  "rendered index chars": index.length,
  "codemode bare": bare - empty,
  "codemode + index (this renderer)": withIndex - empty,
  "names only": names - empty,
}, null, 2));
console.log("--- first 3 lines ---");
console.log(index.split("\n").slice(0, 3).join("\n"));
