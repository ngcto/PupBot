import { readFileSync } from "node:fs";

// Renders the CUA index through the product renderer and prices it through a real
// `tools` block. Run from this directory; needs ANTHROPIC_API_KEY and
// ANTHROPIC_BASE_URL.
import { availableIndex, namesOf, renderIndex } from "../../packages/tools/src/index.ts";
import { codemodeSchema } from "../../packages/tools/src/codemode.ts";

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

// The figures that ship are the real renderer's, and it is worth showing that they
// decompose: the earlier 1,805 was this same index under a one-line description, so
// the difference between the two numbers was never the index, only the instructions
// in front of it. Both are priced here so the composition is checkable.
const schema = codemodeSchema(entries as any);
const MARK = "\nAvailable here:";
const header = schema.description.split(MARK)[0] + MARK;
const idxText = renderIndex(availableIndex(entries as any, "host"));
const priced = (description: string) => tokens({ tools: [{ name: "codemode", description,
  input_schema: { type: "object", properties: { code: { type: "string", description: "The program body. Top-level `await` and `return` both work." } }, required: ["code"] } }] });

const shipped = (await priced(schema.description)) - empty;
const headerOnly = (await priced(header)) - empty;
const indexOnly = (await priced(idxText)) - empty;
const insteadOfNothing = (await tokens({ tools: [{ name: "codemode", description: schema.description,
  input_schema: schema.parameters }] })) - empty;

console.log(JSON.stringify({
  entries: entries.length,
  "rendered index chars": index.length,
  "codemode bare": bare - empty,
  "codemode + index (this renderer)": withIndex - empty,
  "names only": names - empty,
}, null, 2));
console.log(JSON.stringify({
  "SHIPPED codemodeSchema (instructions + index)": insteadOfNothing,
  "instructions only (no index)": headerOnly,
  "index body only": indexOnly,
  // Parts do not sum exactly to the whole: a tokenizer is not additive across a
  // concatenation boundary, so 146 + 1,771 lands 40 over 1,877. Quote the whole.
  "parts summed (NOT the shipped figure)": headerOnly + indexOnly,
  "names, comma-joined chars": namesOf(entries as any).join(", ").length,
}, null, 2));
console.log("--- first 3 lines ---");
console.log(index.split("\n").slice(0, 3).join("\n"));
