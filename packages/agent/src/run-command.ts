import type { ToolSchema } from "@terabot/providers";
import type { Machine, MachineExecOptions, Obstacle, RunComputer } from "./computer.ts";
import { stringArg } from "./tools.ts";
import type { RunTool } from "./tools.ts";

/**
 * The computer tool: run a command on the bot's own machine.
 *
 * It exists because lazy provisioning needs a moment of demand. Without a tool
 * there is no "the bot tried to use its computer" to hook, so the box would have
 * to be created for every message — which is exactly what the lifecycle change
 * is meant to stop. The tool is also what makes a computer *failure* something
 * the model can see and explain, rather than a run that dies before the model
 * is ever called.
 *
 * The name is deliberately plain and provider-free. The desktop and browser layer
 * adds its own tools beside this one when it lands; they all take the machine the
 * same way, through {@link runComputerTool}.
 */
export const RUN_COMMAND_TOOL: ToolSchema = {
  name: "run_command",
  description:
    "Run a shell command on your own cloud computer and read its output. Use it to inspect files, run builds and tests, install packages, or reach the network. Your computer is created the first time you use it and sleeps when you are idle.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to run." },
      cwd: { type: "string", description: "Working directory. Defaults to the home directory." },
      timeoutSeconds: {
        type: "integer",
        description: "Kill the command after this many seconds. Defaults to 60.",
        minimum: 1,
        maximum: 600,
      },
    },
    required: ["command"],
  },
};

/** How many model↔tool round trips one run may make before it must answer. */
export const MAX_TOOL_ROUNDS = 6;

/**
 * The result a tool hands back to the model.
 *
 * Success and failure are both plain text, because every wire format carries a
 * tool result as a string and the model is going to read it either way. A
 * refusal is worded so that relaying it faithfully *is* the correct answer: the
 * bot tells the user what happened and what to do, and that is the entire
 * user-facing mechanism for a computer failure.
 */
export function describeObstacle(obstacle: Obstacle): string {
  return [
    `BLOCKED: ${obstacle.summary}`,
    `Why: ${obstacle.detail}`,
    `What the user can do: ${obstacle.resolution}`,
    obstacle.userAction === "none"
      ? "There is nothing the user can change about this."
      : `This needs the user to ${obstacle.userAction === "plan" ? "choose a plan" : obstacle.userAction === "configure" ? "change a setting" : "wait"}.`,
    obstacle.retryable ? "Trying again later may work." : "Trying again will fail the same way until that is done.",
    "Tell the user this in your own words and say what they can do. Do not claim you could not understand the error.",
  ].join("\n");
}

export interface ToolCallRequest {
  computer: RunComputer;
  botId: string;
  command: string;
  options?: MachineExecOptions;
}

/**
 * Run one command through the lease seam, turning every way of not getting a
 * machine into the text the model reads.
 */
export async function runComputerTool(request: ToolCallRequest): Promise<{ text: string; isError: boolean }> {
  const outcome = await request.computer.withLease(request.botId, (machine: Machine) =>
    machine.exec(request.command, request.options),
  );

  if (!outcome.ok) return { text: describeObstacle(outcome.obstacle), isError: true };

  const result = outcome.value;
  const body = [
    result.stdout ? `stdout:\n${result.stdout}` : "stdout: (empty)",
    result.stderr ? `stderr:\n${result.stderr}` : "",
    `exit code: ${result.exitCode}${result.timedOut ? " (timed out)" : ""}${result.truncated ? " (output truncated)" : ""}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  return { text: body, isError: false };
}

/**
 * Whether the endpoint should be offered the tool at all.
 *
 * A model whose catalogue entry says it cannot call tools is not sent a schema it
 * will ignore: the run falls back to plain chat instead of looping on a tool it
 * can never invoke. An unmatched model is offered the tool, because the catalogue
 * being silent is not evidence about the provider.
 */
export function toolOffered(input: { toolSupport: boolean | null; hasComputer: boolean }): boolean {
  return input.hasComputer && input.toolSupport !== false;
}

/**
 * The registry entry for `run_command`.
 *
 * The handler reaches the machine only through `withLease`, so the box is
 * provisioned or woken at the moment a tool asks for it and never before the
 * first token. A refusal comes back as text rather than a throw: the model is
 * what tells the user, and a thrown error would end the run before it could.
 */
export function runCommandTool(computer: RunComputer, botId: string): RunTool {
  return {
    schema: RUN_COMMAND_TOOL,
    async handler(input) {
      const command = stringArg(input, "command");
      if (!command) return { result: "BLOCKED: no command was given." };
      const cwd = stringArg(input, "cwd");
      const rawTimeout = input.timeoutSeconds;
      const timeoutSeconds = typeof rawTimeout === "number" && Number.isFinite(rawTimeout) ? rawTimeout : undefined;
      const { text } = await runComputerTool({
        computer,
        botId,
        command,
        ...(cwd || timeoutSeconds ? { options: { ...(cwd ? { cwd } : {}), ...(timeoutSeconds ? { timeoutSeconds } : {}) } } : {}),
      });
      return { result: text };
    },
  };
}
