import { readFile } from "node:fs/promises";
const KEY = process.env.ANTHROPIC_API_KEY!;
const BASE = process.env.ANTHROPIC_BASE_URL!;

async function count(body: any): Promise<number> {
  const res = await fetch(`${BASE}/v1/messages/count_tokens`, {
    method: "POST",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-5-5", ...body }),
  });
  const json = (await res.json()) as any;
  if (json.input_tokens === undefined) throw new Error(JSON.stringify(json).slice(0, 400));
  return json.input_tokens;
}

const png = await readFile("/tmp/shot.png");
const b64 = await readFile("/tmp/shot.b64", "utf8");
const empty = await count({ messages: [{ role: "user", content: "." }] });

const image = await count({
  messages: [{
    role: "user",
    content: [
      { type: "text", text: "." },
      { type: "image", source: { type: "base64", media_type: "image/png", data: b64.trim() } },
    ],
  }],
});

const asText = await count({ messages: [{ role: "user", content: b64.trim() }] });

console.log(JSON.stringify({
  "png bytes": png.length,
  "base64 chars": b64.trim().length,
  "as an image block (real request)": image - empty,
  "as base64 text": asText - empty,
}, null, 2));
