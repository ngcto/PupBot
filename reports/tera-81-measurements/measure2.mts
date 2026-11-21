import { readFile } from "node:fs/promises";
import { toOpenAiChatTools, toAnthropicTools, toOpenAiResponsesTools } from "../../packages/providers/src/tools.ts";
import { TOOLS } from "./schemas.ts";

const KEY = process.env.ANTHROPIC_API_KEY!;
const BASE = process.env.ANTHROPIC_BASE_URL!;

/** Tokenizes arbitrary text on the same model, through a user message. */
async function tokensOf(text: string): Promise<number> {
  const res = await fetch(`${BASE}/v1/messages/count_tokens`, {
    method: "POST",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: text }] }),
  });
  const json = (await res.json()) as { input_tokens?: number };
  if (json.input_tokens === undefined) throw new Error(JSON.stringify(json));
  return json.input_tokens;
}
const empty = await tokensOf("x");

const index = JSON.parse(await readFile(new URL("./index.json", import.meta.url), "utf8"));
const decls = JSON.parse(await readFile(new URL("./decls.json", import.meta.url), "utf8"));

const indexListing = index.map((e: any) => `- ${e.name} (${e.cost}) — ${e.description} When: ${e.when.join("; ")}.`).join("\n");
const indexNamesOnly = index.map((e: any) => e.name).join(", ");

const rows = {
  "anthropic tools block (26)": await tokensOf(JSON.stringify(toAnthropicTools(TOOLS))),
  "openai chat tools block (26)": await tokensOf(JSON.stringify(toOpenAiChatTools(TOOLS))),
  "openai responses tools block (26)": await tokensOf(JSON.stringify(toOpenAiResponsesTools(TOOLS))),
  "index listing full (name+desc+when+cost)": await tokensOf(indexListing),
  "index listing names only": await tokensOf(indexNamesOnly),
  "pi-style declarations": await tokensOf(decls),
  "codemode tool, one-line description": await tokensOf(JSON.stringify([{ name: "codemode", description: "Run JavaScript that calls tools as await tools.<name>(args).", input_schema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } }])),
  "codemode tool + index in description": await tokensOf(indexListing) + 21,
};
const out: Record<string, number> = {};
for (const [k, v] of Object.entries(rows)) out[k] = v - empty;
console.log(JSON.stringify(out, null, 2));
