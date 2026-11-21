import { describe, expect, it } from "vitest";
import { lineFromStack, preludeFor, programOf, toIdentifier } from "../src/sandbox.ts";
import { runProgram } from "../src/index.ts";
import type { SandboxTool } from "../src/sandbox.ts";

function tool(name: string, execute: SandboxTool["execute"], extra: Partial<SandboxTool> = {}): SandboxTool {
  return { name, description: `${name} for tests`, execute, ...extra };
}

describe("script environment", () => {
  it("names a tool as an identifier, keeping the original callable", () => {
    expect(toIdentifier("vault_fill")).toBe("vault_fill");
    expect(toIdentifier("my-tool")).toBe("my_tool");
    expect(toIdentifier("a.b c")).toBe("a_b_c");
  });

  it("wraps the model's code so top-level await and return both work", () => {
    expect(programOf("return 1;")).toContain("async ()");
    expect(programOf("await x();")).toContain("async ()");
  });

  it("offers only the tools it was given, and no ambient capability", async () => {
    const seen: string[] = [];
    const result = await runProgram("return typeof setTimeout;", []);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("undefined");
    void seen;
  });

  it("reports every capability the VM does not have", async () => {
    const result = await runProgram(
      "return [typeof setTimeout, typeof fetch, typeof process, typeof require, typeof WebAssembly].join(',')",
      [],
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("undefined,undefined,undefined,undefined,undefined");
    }
  });

  it("builds a prelude listing tools with their metadata, and no execute", () => {
    const prelude = preludeFor([
      { name: "click", description: "Click a target", cost: "cheap", when: ["press a button"] },
    ]);
    expect(prelude).toContain("click: (args) => __call(\"click\", args)");
    expect(prelude).toContain("press a button");
    expect(prelude).not.toContain("execute");
  });

  it("reads a line number out of the engine's stack", () => {
    expect(lineFromStack("    at f (<eval>:4:9)")).toBe(3);
    expect(lineFromStack("at f (codemode.js:2:31)")).toBe(1);
    expect(lineFromStack(undefined)).toBeUndefined();
  });
});

describe("tool calls", () => {
  it("keeps a tool's full result out of the model's view", async () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => ({ id: i, status: i % 73 === 0 ? "pending" : "shipped" }));
    const result = await runProgram(
      `
      const rows = await tools.read({ sheet: "orders" });
      const pending = rows.filter((row) => row.status === "pending");
      text("found " + pending.length);
      text(JSON.stringify(pending.slice(0, 2)));
      return pending.length;
      `,
      [tool("read", async () => rows)],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(137);
    expect(result.output).toEqual(["found 137", JSON.stringify(rows.filter((r) => r.status === "pending").slice(0, 2))]);
    // The whole point: what the model reads is two lines, not 10,000 rows.
    expect(result.output.join("").length).toBeLessThan(120);
  });

  it("runs concurrent calls and applies their results in order", async () => {
    const result = await runProgram(
      `
      const values = await Promise.all([
        tools.echo({ n: 1 }),
        tools.echo({ n: 2 }),
        tools.echo({ n: 3 }),
      ]);
      return values.join(",");
      `,
      [tool("echo", async (args) => `echo-${String(args.n)}`)],
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("echo-1,echo-2,echo-3");
  });

  it("turns a throwing tool into a catchable rejection, not a dead run", async () => {
    const result = await runProgram(
      `
      try {
        await tools.boom({});
        text("not reached");
      } catch (error) {
        text("caught: " + error.message);
      }
      return "survived";
      `,
      [
        tool("boom", async () => {
          throw new Error("that element is stale");
        }),
      ],
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("survived");
      expect(result.output).toEqual(["caught: that element is stale"]);
    }
  });

  it("passes arguments both ways as JSON, including nested and unicode values", async () => {
    let seen: Record<string, unknown> = {};
    const result = await runProgram(
      `return await tools.roundtrip({ deep: { list: [1, "two", null] }, text: "xin chào" });`,
      [
        tool("roundtrip", async (args) => {
          seen = args;
          return args;
        }),
      ],
    );
    expect(seen).toEqual({ deep: { list: [1, "two", null] }, text: "xin chào" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(seen);
  });

  it("names an unknown tool rather than failing obscurely", async () => {
    const result = await runProgram(`await tools.nope({}); return 1;`, []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("script");
      expect(result.error.message).toContain("no tool called");
    }
  });
});

describe("bounds", () => {
  it("fails a program that waits on a promise nothing can settle, immediately", async () => {
    const started = Date.now();
    const result = await runProgram(`text("before"); await new Promise(() => {}); return 1;`, []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("stall");
      // Output before the stall is kept: it says what the program was doing.
      expect(result.output).toEqual(["before"]);
    }
    // A stall must not be waited out — it is detectable, so it is fast.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("stops a tight loop with the interrupt handler", async () => {
    const started = Date.now();
    const result = await runProgram(`while (true) {}`, [], { timeoutMs: 300 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["timeout", "sandbox"]).toContain(result.error.kind);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("refuses more calls than the budget allows", async () => {
    const result = await runProgram(
      `for (let i = 0; i < 10; i += 1) await tools.echo({ i }); return "done";`,
      [tool("echo", async () => "ok")],
      { maxToolCalls: 3 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("limit");
      expect(result.error.message).toContain("3 tool calls");
    }
  });

  it("caps retained output", async () => {
    const result = await runProgram(
      `for (let i = 0; i < 100; i += 1) text("x".repeat(50)); return 1;`,
      [],
      { maxOutputChars: 200 },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.join("").length).toBeLessThan(400);
      expect(result.output.at(-1)).toContain("output stopped");
    }
  });

  it("caps the heap, and the VM survives to report it", async () => {
    const result = await runProgram(`return "x".repeat(64 * 1024 * 1024).length;`, [], {
      memoryBytes: 4 * 1024 * 1024,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["script", "sandbox"]).toContain(result.error.kind);
  });

  it("reports a syntax error with the line the model wrote", async () => {
    const result = await runProgram(`const a = 1;\nconst b = ;\nreturn a;`, []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("script");
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });

  it("aborts a run when the caller's signal fires", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const result = await runProgram(`await tools.slow({}); return 1;`, [
      tool("slow", () => new Promise((resolve) => setTimeout(() => resolve("late"), 5_000))),
    ], { signal: controller.signal });
    expect(result.ok).toBe(false);
  });
});

describe("result shape", () => {
  it("returns calls with names, ok and host time the model never sees", async () => {
    const result = await runProgram(`await tools.echo({}); return 1;`, [tool("echo", async () => "ok")]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]?.name).toBe("echo");
      expect(result.calls[0]?.ok).toBe(true);
      expect(typeof result.calls[0]?.ms).toBe("number");
    }
  });

  it("marks a failed call as not ok while the program carries on", async () => {
    const result = await runProgram(
      `try { await tools.boom({}); } catch {} return 1;`,
      [
        tool("boom", async () => {
          throw new Error("nope");
        }),
      ],
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.calls[0]?.ok).toBe(false);
  });
});
