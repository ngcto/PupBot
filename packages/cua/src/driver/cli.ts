import { ProviderError } from "@terabot/computers";
import type { ComputerRef, ComputerProvider } from "@terabot/computers";

/**
 * How this package reaches Cua Driver, and why.
 *
 * The driver offers four entry points (MCP over stdio, CLI over its daemon, the
 * Python/TypeScript SDK, and an app-hosted service). The docs say to pick by
 * **who owns the runtime**: the process that holds the OS permissions, the
 * sessions, and the browser connections.
 *
 * For us the runtime is the bot's own box, a Linux cloud machine we provision
 * and can already exec in. So the choice is:
 *
 *   `cua-driver serve --socket <path>` on the box, once, and
 *   `cua-driver call <tool> '<json>' --socket <path>` per tool call.
 *
 * Why not the alternatives:
 *
 * - **SDK** (`CuaDriver.create()`): it wants to own a runtime in *our* Node
 *   process. On Linux it is in-process, which would mean our worker — possibly
 *   in a serverless function — owns the X session and browser connections of a
 *   remote box. It also adds a native uniffi dependency per platform for no
 *   gain, because the desktop we drive is never this process's desktop.
 * - **MCP over stdio**: this is the right shape for an *agent CLI* that speaks
 *   MCP, and the wrong shape for a harness that owns its own loop. It would add
 *   a protocol hop over an exec we already have, and a long-lived stdio session
 *   to keep alive across serverless invocations.
 * - **CLI over the daemon** is the one the docs call out for "an agent that can
 *   only run shell commands". We can run shell commands. One daemon per box
 *   keeps sessions, element caches and browser bindings alive between calls —
 *   which is exactly what the element rung of the ladder needs — while each
 *   call stays a stateless, retryable exec.
 *
 * MEASURED on a real Instabox box (Debian 13, X11/XFCE, cua-driver 0.55.0):
 * element tokens minted by one `call` are still valid in the next `call` through
 * the same daemon, and a call costs ~10 ms of in-box time. So the per-call exec
 * is a transport detail, not a latency problem.
 */

/** What a driver call needs from a computer: run a command, get its output. */
export interface CuaExecTarget {
  /** Runs one command with its environment and returns stdout and the exit code. */
  exec: (
    command: string,
    options?: { cwd?: string; env?: Record<string, string>; timeoutSeconds?: number; signal?: AbortSignal },
  ) => Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>;
}

export interface CuaDriverOptions {
  /** Absolute path to the driver binary inside the box. */
  binary?: string;
  /** The daemon's socket or named pipe. */
  socket?: string;
  /** The X display the box's desktop runs on. */
  display?: string;
  /** Named session label, so a bot's calls share one lifecycle session. */
  session?: string;
  /** Ceiling on one driver call, in seconds. */
  timeoutSeconds?: number;
  /** Extra environment for the daemon and every call. */
  env?: Record<string, string>;
}

const DEFAULT_BINARY = "cua-driver";
export const DEFAULT_SOCKET = "/tmp/terabot-cua.sock";

/**
 * The environment the driver needs **inside the target box**.
 *
 * AT-SPI is what makes an accessibility tree exist at all, and it is reached
 * through the *session* bus, not the system bus. Without `DBUS_SESSION_BUS_ADDRESS`
 * the driver still connects to X11 and still takes screenshots, but
 * `get_window_state` returns an empty tree — the `degraded` state the docs warn
 * about — so every element call falls back to pixels.
 *
 * It is deliberately **not** derived from this process's environment by default.
 * This process usually runs on a different machine from the box, so forwarding
 * its `XDG_RUNTIME_DIR` (say `/run/user/1001`) would point the driver at a bus
 * that does not exist on the box (whose desktop runs as UID 1000) and silently
 * reinstate the pixel-only failure. The box's own login session already exports
 * both values, so the correct default is to assert nothing and let them through.
 *
 * Pass `derive: true` only when the caller *is* the box — a call running inside
 * the target's own session — for the case where a value is genuinely missing.
 */
export function boxEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: { derive?: boolean } = {},
): Record<string, string> {
  const result: Record<string, string> = {
    // GTK's AT-SPI bridge is opt-in per process; apps started without it expose
    // no tree no matter what the driver does.
    GTK_MODULES: "gail:atk-bridge",
    GNOME_ACCESSIBILITY: "1",
    NO_AT_BRIDGE: "0",
  };
  if (!options.derive) return result;

  const runtimeDir = env.XDG_RUNTIME_DIR ?? (env.UID ? `/run/user/${env.UID}` : "");
  if (runtimeDir) result.XDG_RUNTIME_DIR = runtimeDir;
  if (!env.DBUS_SESSION_BUS_ADDRESS && runtimeDir) {
    result.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runtimeDir}/bus`;
  }
  return result;
}

/** A JSON payload from the driver, or a diagnosis of why there isn't one. */
export type DriverReply =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; code: string; message: string; exitCode: number };

export class CuaDriver {
  readonly options: Required<Pick<CuaDriverOptions, "binary" | "socket" | "session" | "timeoutSeconds">> &
    Pick<CuaDriverOptions, "display" | "env">;
  readonly #target: CuaExecTarget;

  constructor(target: CuaExecTarget, options: CuaDriverOptions = {}) {
    this.#target = target;
    this.options = {
      binary: options.binary ?? DEFAULT_BINARY,
      socket: options.socket ?? DEFAULT_SOCKET,
      session: options.session ?? "terabot",
      timeoutSeconds: options.timeoutSeconds ?? 60,
      ...(options.display ? { display: options.display } : {}),
      ...(options.env ? { env: options.env } : {}),
    };
  }

  /**
   * One tool call. The JSON goes over **stdin**, not as a positional argument:
   * a quoted JSON object in a shell string is where every injection and quoting
   * bug in a CLI integration comes from, and stdin has neither problem.
   */
  async call(
    tool: string,
    args: Record<string, unknown> = {},
    options: { timeoutSeconds?: number; signal?: AbortSignal } = {},
  ): Promise<DriverReply> {
    const payload = JSON.stringify({ ...args, session: args.session ?? this.options.session });
    const command = [
      `printf '%s' ${shellQuote(payload)}`,
      "|",
      shellQuote(this.options.binary),
      "call",
      shellQuote(tool),
      "--socket",
      shellQuote(this.options.socket),
    ].join(" ");

    let result: Awaited<ReturnType<CuaExecTarget["exec"]>>;
    try {
      result = await this.#target.exec(command, {
        env: { ...boxEnvironment(), ...this.options.env },
        timeoutSeconds: options.timeoutSeconds ?? this.options.timeoutSeconds,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      throw asDriverError(error);
    }

    if (result.timedOut) {
      return {
        ok: false,
        code: "driver_timeout",
        message: `cua-driver ${tool} did not answer within ${options.timeoutSeconds ?? this.options.timeoutSeconds}s`,
        exitCode: result.exitCode,
      };
    }

    const stdout = result.stdout.trim();
    if (!stdout) {
      return {
        ok: false,
        code: "driver_unavailable",
        message: driverDiagnosis(result.stderr, this.options.binary),
        exitCode: result.exitCode,
      };
    }

    // A refused action still prints a JSON body and exits non-zero, so the
    // payload decides, not the exit code.
    const parsed = parseJsonObject(stdout);
    if (!parsed) {
      return {
        ok: false,
        code: "driver_unavailable",
        message: driverDiagnosis(result.stderr || stdout, this.options.binary),
        exitCode: result.exitCode,
      };
    }
    return { ok: true, value: parsed };
  }

  /** One call that must succeed, for the read paths where a refusal is a bug. */
  async require(
    tool: string,
    args: Record<string, unknown> = {},
    options: { timeoutSeconds?: number; signal?: AbortSignal } = {},
  ): Promise<Record<string, unknown>> {
    const reply = await this.call(tool, args, options);
    if (!reply.ok) throw new CuaDriverError(reply.code, reply.message);
    const refusal = readRefusal(reply.value);
    if (refusal) throw new CuaDriverError(refusal.code, refusal.message);
    return reply.value;
  }

  /**
   * Make sure a daemon is running and the desktop is reachable.
   *
   * Idempotent and safe to call per run: `status` answers in milliseconds, and
   * a daemon that is already up is left alone. The install itself is the
   * provisioning layer's job — this only reports clearly when it is missing.
   */
  async ensureReady(options: { signal?: AbortSignal } = {}): Promise<{
    ok: boolean;
    reason?: string;
    installed: boolean;
    daemonStarted: boolean;
    accessibility: boolean;
  }> {
    const status = await this.call("get_session", {}, options);
    if (status.ok) {
      const a11y = await this.call("health_report", { include: ["accessibility"] }, options);
      return {
        ok: true,
        installed: true,
        daemonStarted: false,
        accessibility: !isAccessibilityWarning(a11y),
      };
    }

    // No daemon (or no binary). Distinguish the two: one is fixable by starting
    // a process, the other is the provisioning layer's job.
    const version = await this.#target
      .exec(`${shellQuote(this.options.binary)} --version`, { timeoutSeconds: 20, ...(options.signal ? { signal: options.signal } : {}) })
      .catch(() => null);
    if (!version || version.exitCode !== 0) {
      return {
        ok: false,
        installed: false,
        daemonStarted: false,
        accessibility: false,
        reason:
          "Cua Driver is not installed on this computer. Install it with the driver's own installer, then retry: " +
          "curl -fsSL https://cua.ai/driver/install.sh | bash",
      };
    }

    const started = await this.#startDaemon(options);
    if (!started.ok) return { ...started, installed: true, daemonStarted: false, accessibility: false };

    const health = await this.call("health_report", { include: ["accessibility"] }, options);
    return {
      ok: true,
      installed: true,
      daemonStarted: true,
      accessibility: !isAccessibilityWarning(health),
    };
  }

  async #startDaemon(options: { signal?: AbortSignal }): Promise<{ ok: boolean; reason?: string }> {
    const display = this.options.display ? `DISPLAY=${shellQuote(this.options.display)} ` : "";
    const command = [
      `${display}setsid ${shellQuote(this.options.binary)} serve --socket ${shellQuote(this.options.socket)}`,
      "> /tmp/terabot-cua-serve.log 2>&1 < /dev/null &",
      // Wait for the socket to answer rather than sleeping a fixed guess: the
      // daemon's startup is not constant across boxes.
      `for i in $(seq 1 40); do ${shellQuote(this.options.binary)} status --socket ${shellQuote(this.options.socket)} >/dev/null 2>&1 && exit 0; sleep 0.5; done;`,
      "exit 1",
    ].join(" ");
    const result = await this.#target
      .exec(command, {
        env: { ...boxEnvironment(), ...this.options.env },
        timeoutSeconds: 40,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      .catch(() => null);
    if (!result || result.exitCode !== 0) {
      return {
        ok: false,
        reason:
          "The computer-use driver is installed but its daemon would not start; " +
          "on Linux it needs a running X11 desktop session (DISPLAY) — check the box's desktop is up.",
      };
    }
    return { ok: true };
  }
}

export class CuaDriverError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CuaDriverError";
    this.code = code;
  }
}

/* ───────────────────────────── reply reading ───────────────────────────── */

/** The refusal shape every driver tool uses, or null when the call went through. */
export function readRefusal(value: Record<string, unknown>): { code: string; message: string; hint?: string } | null {
  const refusal = value.refusal;
  let code: string | undefined;
  let message: string | undefined;
  if (refusal && typeof refusal === "object") {
    const body = refusal as Record<string, unknown>;
    code = typeof body.code === "string" ? body.code : undefined;
    message = typeof body.message === "string" ? body.message : undefined;
  }
  // Element and window refusals are flat: `{code, detail, effect: "refused"}`.
  if (!code && typeof value.code === "string" && value.effect === "refused") code = value.code;
  if (!code) return null;
  return {
    code,
    message: message ?? (typeof value.detail === "string" ? value.detail : code),
    ...(typeof value.hint === "string" ? { hint: value.hint } : {}),
  };
}

export function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  // The CLI can print a warning line before the JSON body; take the last
  // balanced object rather than requiring a clean stream.
  const end = text.lastIndexOf("}");
  if (end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

function driverDiagnosis(stderr: string, binary: string): string {
  const text = stderr.trim();
  if (/command not found|No such file/i.test(text)) {
    return `Cua Driver is not installed on this computer (${binary} not found).`;
  }
  if (/connect|socket|refused|no such file/i.test(text)) {
    return `Cua Driver's daemon is not reachable, so this action did not run. ${text.slice(0, 300)}`;
  }
  return text
    ? `Cua Driver returned nothing usable: ${text.slice(0, 400)}`
    : "Cua Driver returned nothing usable, and did not say why.";
}

function isAccessibilityWarning(reply: DriverReply): boolean {
  if (!reply.ok) return true;
  const text = JSON.stringify(reply.value);
  return /accessibility bus not reachable|AT-SPI.*not|no actionable elements/i.test(text);
}

function asDriverError(error: unknown): Error {
  if (error instanceof ProviderError) {
    return new CuaDriverError(error.code, error.message);
  }
  if (error instanceof Error) return new CuaDriverError("driver_unavailable", error.message);
  return new CuaDriverError("driver_unavailable", "the computer command failed");
}

/**
 * A single POSIX shell word. The only characters a shell reads inside single
 * quotes are the closing quote itself, so escaping just that is exact — and it
 * keeps a JSON body with newlines, quotes and `$` from being interpreted.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/* ──────────────────────── computers-provider adapter ─────────────────────── */

/**
 * One bot's computer, as this package consumes it.
 *
 * It is deliberately smaller than `ComputerProvider`: computer use needs to run
 * a command, and nothing else. A caller that already holds a provider can wrap
 * it with `execTargetFor`.
 */
export function execTargetFor(
  provider: Pick<ComputerProvider, "exec">,
  ref: ComputerRef,
): CuaExecTarget {
  return {
    exec: async (command, options = {}) => {
      const result = await provider.exec(ref, command, {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: options.env } : {}),
        ...(options.timeoutSeconds ? { timeoutSeconds: options.timeoutSeconds } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
      };
    },
  };
}
