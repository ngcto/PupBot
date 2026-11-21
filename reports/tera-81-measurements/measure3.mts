const KEY = process.env.ANTHROPIC_API_KEY!;
const BASE = process.env.ANTHROPIC_BASE_URL!;
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

// A synthetic window tree close to the live proof: 75 actionable rows.
const rows = Array.from({ length: 75 }, (_, i) => ({
  token: `snp_7f3a:${i}`, role: i % 3 === 0 ? "pushbutton" : i % 3 === 1 ? "textfield" : "statictext",
  label: i % 3 === 0 ? `Button ${i}` : i % 3 === 1 ? `Field ${i}` : `Some descriptive container text row ${i} that a human would read`,
  bounds: [120 + i, 80 + i * 18, 240, 24], enabled: true, offscreen: false, actions: i % 3 === 0 ? ["click"] : [],
}));
const treeJson = JSON.stringify(rows);
const treeText = rows.map((r) => `[${r.token}] ${r.role} "${r.label}"`).join("\n");

// A 10,000-row table result, as a spreadsheet read would return it.
const table = Array.from({ length: 10_000 }, (_, i) => ({
  id: `ORD-${1000 + i}`, customer: `customer-${i}`, status: i % 73 === 0 ? "pending" : "shipped",
  amount: (i * 7.31).toFixed(2), placedAt: "2026-11-19T04:12:00Z",
}));
const tableJson = JSON.stringify(table);
const filtered = JSON.stringify({ found: 137, sample: table.filter((r) => r.status === "pending").slice(0, 5) });

const base64 = (bytes: number) => Buffer.alloc(bytes, 7).toString("base64");
const shot = JSON.stringify({ screenshot_png_b64: base64(95_728), mime: "image/png" });

const out = {
  "75-row accessibility tree as JSON": await tokensOf(treeJson) - empty,
  "75-row accessibility tree as text lines": await tokensOf(treeText) - empty,
  "10,000-row table as JSON (~1.2 MB)": await tokensOf(tableJson) - empty,
  "filtered answer (137 found, 5 rows)": await tokensOf(filtered) - empty,
  "95 KB screenshot as base64 text": await tokensOf(shot) - empty,
  "chars: table": tableJson.length, "chars: tree json": treeJson.length, "chars: tree text": treeText.length,
};
console.log(JSON.stringify(out, null, 2));
