import { readFile } from 'node:fs/promises';
import { QuickJS } from 'quickjs-wasi';

const wasm = await readFile(new URL('node_modules/quickjs-wasi/quickjs.wasm', import.meta.url));
const t0 = performance.now();
const mod = await WebAssembly.compile(wasm);
const tCompile = performance.now() - t0;

let tCreate = 0, tEval = 0;
for (let i = 0; i < 5; i++) {
  const a = performance.now();
  const vm = await QuickJS.create({ wasm: mod, memoryLimit: 32 * 1024 * 1024 });
  tCreate += performance.now() - a;
  const b = performance.now();
  const r = vm.evalCode('(async () => { let n=0; for (let i=0;i<1000;i++) n+=i; return n })()');
  vm.executePendingJobs();
  const out = await vm.resolvePromise(r);
  tEval += performance.now() - b;
  out.value?.dispose?.(); r.dispose(); vm.dispose();
}
console.log('wasm compile ms', tCompile.toFixed(1));
console.log('vm create ms avg', (tCreate / 5).toFixed(2));
console.log('async eval ms avg', (tEval / 5).toFixed(2));

let calls = 0;
const start = performance.now();
const vm2 = await QuickJS.create({
  wasm: mod,
  interruptHandler: () => { calls++; return performance.now() - start > 50; },
});
const tInt = performance.now();
try {
  const r = vm2.evalCode('while(true){}');
  r.dispose();
} catch (e) { console.log('interrupt stopped a tight loop after', (performance.now() - tInt).toFixed(1), 'ms; handler invocations', calls); }
vm2.dispose();

// no-timers check: setTimeout, fetch, process
const vm3 = await QuickJS.create({ wasm: mod });
for (const expr of ['typeof setTimeout','typeof fetch','typeof process','typeof require','typeof WebAssembly']) {
  vm3.evalCode(expr).consume(h => console.log(expr, '=>', h.toString()));
}
vm3.dispose();
