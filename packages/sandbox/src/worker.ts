import { parentPort, workerData } from "node:worker_threads";
import { QuickJS } from "quickjs-wasi";
import type { JSValueHandle } from "quickjs-wasi";
import { lineFromStack, preludeFor, programOf, previewOf, refusalOf } from "./sandbox.ts";
import type { CallRecord, SandboxFailure } from "./sandbox.ts";
import type { WorkerIn, WorkerOut } from "./protocol.ts";

/**
 * One execution, in its own thread.
 *
 * QuickJS runs synchronously, so a script that computes holds this thread until
 * it awaits a tool. That is precisely why it is here and not on the caller's: on
 * the request thread a ten-second loop stops every other request, which is the
 * failure pi measured on Cloudflare — 10 s of delay for a colocated script,
 * ~50 ms when it ran in a separate isolate.
 *
 * The host owns the tools, so this side never executes one: it posts the call and
 * waits for the answer. That keeps a tool's full result out of the VM except for
 * the value it explicitly returns, which is what the token argument depends on.
 */

const input = workerData as WorkerIn;
const port = parentPort;
if (!port) throw new Error("the sandbox worker was started without a parent port");

const startedAt = Date.now();
const output: string[] = [];
const calls: CallRecord[] = [];
const waiting = new Map<number, { deferred: ReturnType<QuickJS["newPromise"]>; record: CallRecord }>();
const inbox: WorkerOut[] = [];
let wake: (() => void) | undefined;
let closed = false;
let aborted = false;
let admitted = 0;
let sequence = 0;
let limitMessage: string | undefined;

port.on("message", (message: WorkerOut) => {
  if (closed) return;
  if (message.type === "abort") {
    aborted = true;
    wake?.();
    return;
  }
  inbox.push(message);
  wake?.();
});

function post(message: unknown): void {
  if (!closed) port!.postMessage(message);
}

/** The next message from the host, or a promise that resolves when one arrives. */
function nextMessage(): Promise<WorkerOut | undefined> {
  const queued = inbox.shift();
  if (queued) return Promise.resolve(queued);
  return new Promise((resolve) => {
    wake = () => {
      wake = undefined;
      resolve(inbox.shift());
    };
  });
}

async function main(): Promise<void> {
  const vm = await QuickJS.create({
    wasm: input.wasm,
    memoryLimit: input.memoryBytes,
    // A tight loop that calls no tool gets no time from any timer, so this is the
    // only thing that can stop it. It runs about once per bytecode instruction, so
    // it must do no work: one clock read and one comparison.
    interruptHandler: () => aborted || Date.now() - startedAt > input.timeoutMs,
  });

  const outHandle = vm.hostToHandle([]);
  vm.setProp(vm.global, "__out", outHandle);

  const callFn = vm.newFunction("__call", (nameHandle: JSValueHandle, argsHandle: JSValueHandle) => {
    const deferred = vm.newPromise();
    const name = nameHandle.toString();

    if (admitted >= input.maxToolCalls) {
      limitMessage = `this program made more than ${input.maxToolCalls} tool calls`;
      deferred.reject(vm.newError(limitMessage));
      return deferred.handle;
    }

    let args: Record<string, unknown>;
    try {
      const dumped = vm.dump(argsHandle);
      args =
        dumped && typeof dumped === "object" && !Array.isArray(dumped)
          ? (dumped as Record<string, unknown>)
          : {};
    } catch {
      deferred.reject(vm.newError("that call's arguments could not be read as a JSON object"));
      return deferred.handle;
    }

    admitted += 1;
    const record: CallRecord = { name, ok: true, ms: 0 };
    calls.push(record);
    waiting.set(++sequence, { deferred, record });
    post({ type: "call", id: sequence, name, args });
    return deferred.handle;
  });
  vm.setProp(vm.global, "__call", callFn);

  vm.evalCode(preludeFor(input.tools)).dispose();

  const fail = (error: SandboxFailure): void => {
    drainOutput();
    post({ type: "result", result: { ok: false, error, output: [...output], calls: [...calls], ms: Date.now() - startedAt } });
    cleanup();
  };

  let script: JSValueHandle;
  try {
    script = vm.evalCode(programOf(input.code), "codemode.js");
  } catch (error) {
    const exception = error as { message?: string; stack?: string };
    // The interrupt handler fires during a synchronous loop, which surfaces here
    // as a thrown exception. It is a timeout, not a mistake in the program.
    if (aborted || Date.now() - startedAt > input.timeoutMs) {
      fail({
        kind: aborted ? "aborted" : "timeout",
        message: aborted
          ? "the run was cancelled"
          : `the program did not finish within ${Math.round(input.timeoutMs / 1000)}s`,
      });
      return;
    }
    const line = lineFromStack(exception.stack);
    fail({
      kind: "script",
      message: (exception.message ?? "the program could not be compiled").replace(/^Error:\s*/, "").trim(),
      ...(line !== undefined ? { line } : {}),
      ...(exception.stack ? { stack: exception.stack } : {}),
    });
    return;
  }

  // The pump. Each turn drains the VM's microtasks and then applies exactly one
  // host answer. When nothing is in flight and the program is still unsettled,
  // nothing can ever settle it — the VM has no timers and no I/O — so that is a
  // stall, not a slow run, and it must not be waited out.
  for (;;) {
    vm.executePendingJobs();
    if (script.promiseState !== 0) break;

    if (aborted) {
      fail({ kind: "aborted", message: "the run was cancelled" });
      return;
    }
    if (Date.now() - startedAt > input.timeoutMs) {
      fail({
        kind: "timeout",
        message: `the program did not finish within ${Math.round(input.timeoutMs / 1000)}s`,
      });
      return;
    }

    if (waiting.size === 0 && inbox.length === 0) {
      fail({
        kind: limitMessage ? "limit" : "stall",
        message:
          limitMessage ??
          "the program is waiting on a promise that can never settle: the sandbox has no timers and no I/O, so nothing can resolve it",
      });
      return;
    }

    const message = await nextMessage();
    if (!message) {
      fail({ kind: "aborted", message: "the run was cancelled" });
      return;
    }
    if (message.type !== "done") continue;

    const entry = waiting.get(message.id);
    if (!entry) continue;
    waiting.delete(message.id);
    entry.record.ok = message.ok;
    entry.record.ms = Date.now() - startedAt - message.startedAt;
    const preview = previewOf(message.ok ? message.value : message.message);
    entry.record.preview = preview.text;
    if (preview.truncated) entry.record.truncated = true;
    // A refusal resolves — it is information, not a failure — so it is recorded
    // beside `ok` rather than in place of it. Losing this is what made a program
    // that ignored `effect` indistinguishable from one whose action worked.
    if (message.ok) {
      const refused = refusalOf(message.value);
      if (refused) entry.record.refused = refused;
    }
    if (message.ok) {
      entry.deferred.resolve(vm.hostToHandle(message.value));
    } else {
      entry.deferred.reject(vm.newError(message.message));
    }
  }

  const settled = await vm.resolvePromise(script);
  if ("error" in settled) {
    const message = readProp(settled.error, "message") ?? "the program threw";
    const hitLimit = limitMessage !== undefined && message.includes("tool call");
    const stack = readProp(settled.error, "stack");
    const line = lineFromStack(stack);
    settled.error.dispose();
    fail({
      kind: hitLimit ? "limit" : "script",
      message: message.replace(/^Error:\s*/, "").trim(),
      ...(line !== undefined ? { line } : {}),
      ...(stack ? { stack } : {}),
    });
    return;
  }

  const value = vm.dump(settled.value);
  settled.value.dispose();
  drainOutput();
  post({ type: "result", result: { ok: true, output: [...output], value, calls: [...calls], ms: Date.now() - startedAt } });
  cleanup();

  /** Reads `__out` back as text, stopping at the cap, so a runaway program cannot flood the host. */
  function drainOutput(): void {
    const dumped = vm.dump(outHandle);
    const items = Array.isArray(dumped) ? dumped : [];
    let chars = 0;
    for (const item of items) {
      const text = typeof item === "string" ? item : JSON.stringify(item);
      chars += text.length;
      if (chars > input.maxOutputChars) {
        output.push(`[output stopped at ${input.maxOutputChars} characters; the program produced more]`);
        return;
      }
      output.push(text);
    }
  }

  function cleanup(): void {
    closed = true;
    outHandle.dispose();
    callFn.dispose();
    vm.dispose();
  }
}

function readProp(handle: JSValueHandle, name: string): string | undefined {
  try {
    const value = handle.getProp(name);
    const text = value.toString();
    value.dispose();
    return text;
  } catch {
    return undefined;
  }
}

void main().catch((error: unknown) => {
  post({
    type: "result",
    result: {
      ok: false,
      error: { kind: "sandbox", message: error instanceof Error ? error.message : "the sandbox failed" },
      output: [],
      calls: [],
      ms: 0,
    },
  });
  process.exit(0);
});
