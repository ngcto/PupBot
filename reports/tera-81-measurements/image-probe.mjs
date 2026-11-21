import { readFile } from 'node:fs/promises';
const KEY = process.env.ANTHROPIC_API_KEY, BASE = process.env.ANTHROPIC_BASE_URL;
async function usage(content) {
  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 1, messages: [{ role: 'user', content }] }),
  });
  const j = await res.json();
  return j.usage?.input_tokens ?? j.error?.message ?? JSON.stringify(j).slice(0,200);
}
const textOnly = await usage([{ type: 'text', text: '.' }]);
console.log('text-only baseline tokens', textOnly);
for (const p of ['/tmp/shot.png', '/tmp/big2.png', '/tmp/big1.png']) {
  const b64 = (await readFile(p)).toString('base64');
  const t = await usage([{ type: 'text', text: '.' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } }]);
  console.log(p, 'png', (await readFile(p)).length, 'tokens with image', t, 'delta', typeof t === 'number' ? t - textOnly : 'n/a');
}
