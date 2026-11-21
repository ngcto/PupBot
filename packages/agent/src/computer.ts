/**
 * The seam between the harness and the computer layer.
 *
 * Nothing here names a provider, imports one, or knows what a lease is made of:
 * the harness asks for a machine for the length of some work, and the computer
 * layer decides whether that means waking a sleeping box, provisioning a first
 * one, or explaining why it cannot. `apps/worker` wires the allocator behind
 * this interface; the browser tests wire a fake.
 *
 * Two rules shape it:
 *
 * 1. **The machine is obtained on use, not up front.** `withLease` is called
 *    when a tool actually needs the machine. A bot that only chats never calls
 *    it, so it never costs a box — which is the whole point of lazy
 *    provisioning, and is why this interface replaced "wake before the first
 *    token".
 * 2. **A refusal is data, not an exception.** Every way of not getting a
 *    machine comes back as an {@link Obstacle}, which the run hands to the model
 *    as the tool's result. The model is what tells the user, so the obstacle
 *    carries the situation, the cause, and what a person can do about it.
 */

/**
 * Everything that can stop the bot from getting on with the user's request.
 *
 * The union is closed and shared on purpose: a computer that cannot be
 * provisioned and a vault item that cannot be filled are the same kind of event
 * — the bot has to stop and explain — so they travel together and are worded the
 * same way. A new source of blockers adds a code here, next to the ones that
 * exist, so every consumer's switch keeps being exhaustive.
 */
export type ObstacleCode =
  /** No computer provider is configured and the deployment supplies no pool. */
  | "no_provider"
  /** A deployment pool exists but it needs a plan this workspace does not have. */
  | "no_plan"
  /** Providers are configured, but every one of them is full or rate-limited. */
  | "all_busy"
  /** A provider answered with an error that cannot be turned into advice. */
  | "provider_error"
  /** The command ran, but the machine was lost part way through. */
  | "computer_lost";

/**
 * What the model reads when the bot cannot proceed.
 *
 * Every field is load-bearing because this object *is* the user-facing message:
 * the bot relays it in its own words. `summary` is the situation, `detail` is the
 * cause, `resolution` is what a person would actually have to do, and
 * `userAction` says whether a person can do anything at all — which is what stops
 * a bot from telling someone to "try again" about a missing API key.
 */
export interface Obstacle {
  code: ObstacleCode;
  /** One sentence naming what is wrong, readable to a model and to a person. */
  summary: string;
  /** The cause: which provider, which limit, which error. Never a stack trace. */
  detail: string;
  /** What would fix it, specific to the case. */
  resolution: string;
  /**
   * `configure` and `plan` are things the user can do; `wait` clears on its own;
   * `none` is not the user's problem and must not be dressed as one.
   */
  userAction: "configure" | "plan" | "wait" | "none";
  /** True when trying again later may work with nothing changed. */
  retryable: boolean;
}

/** One command's output. A non-zero exit is a result, not a refusal. */
export interface MachineExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  /** stdout or stderr was cut at the provider's cap. */
  truncated: boolean;
}

export interface MachineExecOptions {
  cwd?: string;
  timeoutSeconds?: number;
  /** Stream chunks as they arrive, for a long command's live output. */
  onOutput?: (chunk: { stream: "stdout" | "stderr"; text: string }) => void;
  signal?: AbortSignal;
}

/**
 * The machine, for the length of one `withLease` call.
 *
 * Only what a tool loop needs today: run a command. Screenshots, file transfer
 * and pointer control belong to the computer-use layer that drives this same
 * handle, so they are added here when that layer lands rather than guessed at
 * now.
 */
export interface Machine {
  readonly computerId: string;
  /** Run a command. Throws only when the machine itself failed; a bad exit code does not. */
  exec(command: string, options?: MachineExecOptions): Promise<MachineExecResult>;
}

/**
 * The outcome of asking for a machine. The failure arm is what a tool returns to
 * the model verbatim when the bot cannot use a computer.
 */
export type LeaseOutcome<T> =
  | { ok: true; value: T; computerId: string; /** True when this call actually woke a sleeping box. */ woke: boolean }
  | { ok: false; obstacle: Obstacle };

/**
 * What the harness needs from the computer layer.
 *
 * One call, deliberately: `withLease` provisions or wakes the bot's machine if it
 * needs to, runs `fn` under a lease that keeps the box from being swept mid-run,
 * and releases the lease afterwards even when `fn` throws. A tool loop wraps the
 * whole of its computer use in one call, so five tool calls cost one lease
 * rather than five.
 *
 * @param botId the bot asking. Its own workspace decides which providers are in
 *   reach, and a bot that already has a box is never given a second one.
 * @param fn the work to do with the machine. Called only once the machine is
 *   usable, so it never has to wake anything itself.
 */
export interface RunComputer {
  withLease<T>(botId: string, fn: (machine: Machine) => Promise<T>): Promise<LeaseOutcome<T>>;
}

/**
 * The instruction that makes the model relay an obstacle instead of swallowing
 * it. It is part of the seam because the obstacle's wording is only correct when
 * the model is told to pass it on in this shape.
 */
export function obstacleInstruction(botName: string): string {
  return [
    `When something stops you, ${botName} still owes the user an answer.`,
    "Say what happened in plain words, say why, and tell them exactly what they can do about it, using the resolution you were given.",
    "Do not paste the raw error, do not call it an internal problem, and do not claim you are unsure why.",
    "If there is nothing for them to do, say so and say when to try again.",
    "Then do whatever you still can without that tool.",
  ].join(" ");
}
