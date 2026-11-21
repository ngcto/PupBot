import { readFileSync } from "node:fs";
import { renderIndex, availableIndex } from "/workspace/terabot/packages/tools/src/index.ts";

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
const raw = JSON.parse(readFileSync("/workspace/terabot/reports/tera-81-measurements/index.json", "utf8"));
const entries = raw.map((e: any) => ({
  name: e.name.replace(/[A-Z]/g, (c: string) => "_" + c.toLowerCase()),
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
