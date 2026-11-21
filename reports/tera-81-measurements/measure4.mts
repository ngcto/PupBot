import { readFile } from "node:fs/promises";
const KEY = process.env.ANTHROPIC_API_KEY!;
const BASE = process.env.ANTHROPIC_BASE_URL!;
async function tokensOf(body: any): Promise<number> {
  const res = await fetch(`${BASE}/v1/messages/count_tokens`, {
    method: "POST",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: "x" }], ...body }),
  });
  const json = (await res.json()) as any;
  if (json.input_tokens === undefined) throw new Error(JSON.stringify(json));
  return json.input_tokens;
}
const empty = await tokensOf({});
const index = JSON.parse(await readFile(new URL("./index.json", import.meta.url), "utf8"));
const listing = index.map((e: any) => `- ${e.name} (${e.cost}) — ${e.description} When: ${e.when.join("; ")}.`).join("\n");
const withIndex = await tokensOf({ tools: [{ name: "codemode", description: listing, input_schema: { type: "object", properties: { code: { type: "string", description: "the JavaScript program" } }, required: ["code"] } }] });
const bare = await tokensOf({ tools: [{ name: "codemode", description: "Run JavaScript that calls tools as await tools.<name>(args).", input_schema: { type: "object", properties: { code: { type: "string", description: "the JavaScript program" } }, required: ["code"] } }] });
// what a discovery turn would cost instead: one extra round trip replays the prefix
console.log(JSON.stringify({ "codemode tool alone (real)": bare - empty, "codemode tool + index (real)": withIndex - empty, index: withIndex - bare }, null, 2));
