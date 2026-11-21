import { describe, expect, it } from "vitest";
import type { RunTool } from "../src/tools.ts";
import { codemodeApplies, codemodeTool } from "../src/codemode-tool.ts";

/**
 * The wire between a run's tools and code mode.
 *
 * `@terabot/tools` shipped `codemodeSchema` and `runCodeMode` with good token
 * measurements and no consumer, so a hosted run's tool list was only ever the surfaces
 * that registered directly. These tests are about the wiring being real: the index is
 * derived from the registry, a program calling a tool actually reaches that tool's
 * handler, and the vault's tools are not reachable from a program.
 *
 * The last one is the security claim, and it is the reason this file exists rather than
 * a happy-path smoke test alone: a tool result inside a program is data the model wrote
 * code to inspect, so offering `vault_fill` there would rebuild the leak channel the
 * vault's `ToolOutcome` shape exists to close.
 */

/** A tool that records what it was called with, so a handler call is observable. */
function recordingTool(name: string, result = "ok"): { tool: RunTool; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    tool: {
      schema: {
        name,
        description: `${name} does a thing`,
        parameters: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
      },
      handler: async (input) => {
        calls.push(input);
        return { result: typeof input.target === "string" ? `${result}:${input.target}` : result };
      },
    },
  };
}

const context = {
  workspaceId: "w",
  botId: "b",
  conversationId: "c",
  runId: "r",
  signal: new AbortController().signal,
  emit: async () => 1,
};

describe("code mode as a registered tool", () => {
  it("is absent for a run with nothing worth wrapping", () => {
    expect(codemodeTool([])).toBeNull();
    expect(codemodeApplies([])).toBe(false);
  });

  /**
   * The vault's tools are the one category excluded. A program that could call
   * `vault_fill` would receive the tool's result as data to inspect and could print it,
   * which is exactly the channel `ToolOutcome` is shaped to prevent.
   */
  it("refuses to wrap the vault's tools, and offers nothing when they are all there is", () => {
    const vaultFind = recordingTool("vault_find");
    const vaultFill = recordingTool("vault_fill");
    expect(codemodeApplies([vaultFind.tool, vaultFill.tool])).toBe(false);
    expect(codemodeTool([vaultFind.tool, vaultFill.tool])).toBeNull();
  });

  it("offers a run's other tools even when the vault's are present", () => {
    const vaultFind = recordingTool("vault_find");
    const click = recordingTool("click");
    expect(codemodeApplies([vaultFind.tool, click.tool])).toBe(true);

    const built = codemodeTool([vaultFind.tool, click.tool]);
    expect(built).not.toBeNull();
    const description = built!.schema.description ?? "";
    expect(description).toContain("click");
    expect(description).not.toContain("vault_find");
  });

  /**
   * The claim, tested through the sandbox rather than around it: the program's code
   * calls a tool by name, and the handler this run registered is the one that runs.
   */
  it("runs the registered handler when a program calls the tool", async () => {
    const click = recordingTool("click", "clicked");
    const built = codemodeTool([click.tool])!;
    const outcome = await built.handler({ code: 'return await tools.click({ target: "#buy" });' }, context);
    expect(click.calls).toEqual([{ target: "#buy" }]);
    expect(outcome.result).toContain("clicked:#buy");
  });

  it("shows the model only what the program printed", async () => {
    const page = "a very long page dump";
    const read = recordingTool("read_screen", page);
    const built = codemodeTool([read.tool])!;
    // A program that filters: this is the point of code mode, and the model should see
    // only what the program chose to print rather than the whole tool result.
    const outcome = await built.handler(
      { code: 'const dump = await tools.read_screen({ target: "window" }); return dump.length;' },
      context,
    );
    // The handler returns `${result}:${target}`, so the value the program sees is the
    // page plus the suffix it was concatenated with.
    const seen = `${page}:window`;
    expect(outcome.result).toContain(String(seen.length));
    expect(outcome.result).not.toContain(page);
  });

  it("records each admitted call as a tool_call event", async () => {
    const click = recordingTool("click");
    const emitted: string[] = [];
    const built = codemodeTool([click.tool])!;
    await built.handler({ code: 'await tools.click({ target: "#a" }); return "done";' }, {
      ...context,
      emit: async (event) => {
        emitted.push(event.type);
        return 1;
      },
    });
    expect(emitted).toContain("tool_call");
  });

  it("refuses an empty program instead of running nothing", async () => {
    const click = recordingTool("click");
    const built = codemodeTool([click.tool])!;
    const outcome = await built.handler({ code: "   " }, context);
    expect(outcome.result).toContain("needs a program");
    expect(click.calls).toEqual([]);
  });
});
