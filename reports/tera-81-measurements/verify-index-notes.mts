import { readFileSync } from "node:fs";
const KEY = process.env.ANTHROPIC_API_KEY!, BASE = process.env.ANTHROPIC_BASE_URL!;
async function tokens(body: any): Promise<number> {
  const r = await fetch(`${BASE}/v1/messages/count_tokens`, { method: "POST",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: "x" }], ...body }) });
  const j: any = await r.json();
  if (j.input_tokens === undefined) throw new Error(JSON.stringify(j).slice(0,300));
  return j.input_tokens;
}
const raw = JSON.parse(readFileSync("/workspace/terabot/reports/tera-81-measurements/index.json", "utf8"));
const withNotes = raw.map((e: any) => `- ${e.name} (${e.cost}) — ${e.description} Use when: ${e.when.join("; ")}.${e.resultNote ? " " + e.resultNote : ""}`).join("\n");
const withoutNotes = raw.map((e: any) => `- ${e.name} (${e.cost}) — ${e.description} Use when: ${e.when.join("; ")}.`).join("\n");
// a middle option: notes only where the note prevents a wrong action
const loadBearing = new Set(["click","doubleClick","rightClick","typeText","observeWindow","screenshot","readPage","browserClick","assessChallenge","runSteps"]);
const selective = raw.map((e: any) => `- ${e.name} (${e.cost}) — ${e.description} Use when: ${e.when.join("; ")}.${e.resultNote && loadBearing.has(e.name) ? " " + e.resultNote : ""}`).join("\n");
const empty = await tokens({});
const t = async (d: string) => (await tokens({ tools: [{ name: "codemode", description: d,
  input_schema: { type: "object", properties: { code: { type: "string", description: "the program" } }, required: ["code"] } }] })) - empty;
console.log(JSON.stringify({
  "with every resultNote": await t(withNotes),
  "with no resultNote": await t(withoutNotes),
  "with 10 load-bearing notes": await t(selective),
  "notes cost": (await t(withNotes)) - (await t(withoutNotes)),
}, null, 2));
