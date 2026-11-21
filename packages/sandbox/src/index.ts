import { readFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import {
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_MEMORY_BYTES,
  DEFAULT_TIMEOUT_MS,
  preludeFor,
} from "./sandbox.ts";
import type { SandboxResult, SandboxTool, RunOptions } from "./sandbox.ts";
import type { WorkerIn, WorkerOut } from "./protocol.ts";

/**
 * Runs one model-written program and returns what it chose to expose.
 *
 * The caller's tools never run inside the VM: this side receives each call, runs
 * it here, and posts back only the value the tool returned. That is what keeps a
 * 10,000-row result out of the model's context — the full value lives and dies in
 * this process, and the program decides what to `text()`.
 */

let compiled: WebAssembly.Module | undefined;

/** Compiles the 638 KB engine once per process; a VM per execution is 7 ms after that. */
export async function loadEngine(): Promise<WebAssembly.Module> {
  if (compiled) return compiled;
  // Resolved through the import map, not a relative guess: a bundler, vitest and
  // production all place node_modules differently, and this is the only form that
  // survives all three.
  const bytes = await readFile(new URL(import.meta.resolve("quickjs-wasi/quickjs.wasm")));
  compiled = await WebAssembly.compile(bytes);
  return compiled;
}

export async function runProgram(
  code: string,
  tools: SandboxTool[],
  options: RunOptions = {},
): Promise<SandboxResult> {
  const startedAt = Date.now();
  const wasm = await loadEngine();
  const controller = new AbortController();
  let settleAbort: (() => void) | undefined;
  const onAbort = (): void => {
    controller.abort();
    worker.postMessage({ type: "abort" } satisfies WorkerOut);
    void worker.terminate();
    // Resolve here rather than waiting for the worker's exit event: a terminated
    // worker reports asynchronously, and an abort that waits on it is an abort that
    // arrives late. A run that errors out does so later and is ignored, because the
    // promise is already settled.
    settleAbort?.();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const worker = new Worker(new URL("./worker.ts", import.meta.url), {
    workerData: {
      code,
      tools: tools.map((tool) => ({ ...tool, execute: undefined })),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxToolCalls: options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
      maxOutputChars: options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
      memoryBytes: options.memoryBytes ?? DEFAULT_MEMORY_BYTES,
      wasm,
    } satisfies WorkerIn,
    // The worker carries the workspace's `"type": "module"` and Node 24 strips the
    // types, so no build step stands between a test and the engine.
    execArgv: [],
  });

  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const result = await new Promise<SandboxResult>((resolve) => {
    let settled = false;
    const finish = (value: SandboxResult): void => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      resolve(value);
    };

    settleAbort = () => {
      finish({
        ok: false,
        error: { kind: "aborted", message: "the run was cancelled" },
        output: [],
        calls: [],
        ms: Date.now() - startedAt,
      });
    };

    worker.on("message", (message: WorkerOut) => {
      if (message.type === "result") {
        finish(message.result);
        return;
      }
      if (message.type !== "call") return;

      const tool = byName.get(message.name);
      if (!tool) {
        worker.postMessage({
          type: "done",
          id: message.id,
          ok: false,
          message: `there is no tool called "${message.name}"`,
          startedAt: Date.now(),
        } satisfies WorkerOut);
        return;
      }

      const callStarted = Date.now();
      tool
        .execute(message.args, { index: message.id - 1, signal: controller.signal })
        .then(
          (value) =>
            worker.postMessage({
              type: "done",
              id: message.id,
              ok: true,
              value,
              startedAt: callStarted,
            } satisfies WorkerOut),
          (error: unknown) =>
            worker.postMessage({
              type: "done",
              id: message.id,
              ok: false,
              message: error instanceof Error ? error.message : "the tool failed",
              startedAt: callStarted,
            } satisfies WorkerOut),
        )
        .catch(() => undefined);
    });

    worker.on("error", (error: Error) => {
      finish({
        ok: false,
        error: { kind: "sandbox", message: error.message },
        output: [],
        calls: [],
        ms: Date.now() - startedAt,
      });
    });

    worker.on("exit", (code) => {
      if (code !== 0) {
        finish({
          ok: false,
          error: { kind: "sandbox", message: `the sandbox exited with code ${code}` },
          output: [],
          calls: [],
          ms: Date.now() - startedAt,
        });
      }
    });
  });

  return result;
}

export { preludeFor };
