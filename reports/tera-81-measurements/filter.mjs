import { readFile } from 'node:fs/promises';
import { QuickJS } from 'quickjs-wasi';
const wasm = await WebAssembly.compile(await readFile(new URL('node_modules/quickjs-wasi/quickjs.wasm', import.meta.url)));

const table = Array.from({ length: 10_000 }, (_, i) => ({
  id: `ORD-${1000 + i}`, customer: `customer-${i}`, status: i % 73 === 0 ? 'pending' : 'shipped',
  amount: (i * 7.31).toFixed(2), placedAt: '2026-11-19T04:12:00Z',
}));

const vm = await QuickJS.create({ wasm, memoryLimit: 32 * 1024 * 1024 });
vm.evalCode('globalThis.rows = undefined').dispose();
const t0 = performance.now();
const h = vm.hostToHandle(table);
vm.setProp(vm.global, 'rows', h);
const tInject = performance.now() - t0;

const t1 = performance.now();
const r = vm.evalCode(`
  (() => {
    const pending = rows.filter(r => r.status === "pending");
    pending.sort((a, b) => Number(b.amount) - Number(a.amount));
    return { found: pending.length, top: pending.slice(0, 5).map(r => r.id + " " + r.amount) };
  })()
`);
const out = vm.dump(r);
const tFilter = performance.now() - t1;
console.log('rows', table.length, 'json bytes', JSON.stringify(table).length);
console.log('hostToHandle+setProp ms', tInject.toFixed(1));
console.log('filter+sort 10k in QuickJS ms', tFilter.toFixed(1));
console.log('result', JSON.stringify(out));
r.dispose(); h.dispose(); vm.dispose();
