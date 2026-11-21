import type { CallRecord, SandboxResult, SandboxTool } from "./sandbox.ts";

/**
 * The worker's wire format. Kept free of Node and wasm imports so the host can
 * type its side of the conversation without pulling the engine into whatever
 * bundles it.
 */

export interface WorkerIn {
  code: string;
  /** Without `execute`: the tools run on the host, never inside the VM. */
  tools: Omit<SandboxTool, "execute">[];
  timeoutMs: number;
  maxToolCalls: number;
  maxOutputChars: number;
  memoryBytes: number;
  wasm: WebAssembly.Module;
}

export type WorkerOut =
  | { type: "call"; id: number; name: string; args: Record<string, unknown> }
  | { type: "result"; result: SandboxResult }
  | { type: "done"; id: number; ok: true; value: unknown; startedAt: number }
  | { type: "done"; id: number; ok: false; message: string; startedAt: number }
  | { type: "abort" };

export type { CallRecord };
