/**
 * Cua Driver, as plain typed functions.
 *
 * This package is the computer-use and browser-use capability for a bot's own
 * box. It deliberately contains **no agent loop, no tool schema, and no model
 * decision**: each function takes explicit arguments, returns a typed result,
 * and can be called from a test, a route handler, a worker job, or a code-mode
 * sandbox without any of the others.
 *
 * The three ideas that come from the driver and shape everything here:
 *
 * 1. **Observe once, act exactly.** `get_window_state` returns the tree and the
 *    screenshot together, and every action names one exact target.
 * 2. **The ladder is the contract.** Element, then pixel, then page, then
 *    foreground — and `effect` / `escalation` / `verified` say whether to climb.
 * 3. **A delivered event is not an applied change.** `unverifiable` is reported
 *    as `unverifiable`, and a refusal is never success.
 */

export { CuaDriver, CuaDriverError, boxEnvironment, execTargetFor, shellQuote, DEFAULT_SOCKET } from "./driver/cli.ts";
export type { CuaDriverOptions, CuaExecTarget, DriverReply } from "./driver/cli.ts";

export {
  readActionResult,
  readEscalation,
  readObservation,
  readPageState,
  readScreenshot,
  readWindow,
  readWindows,
} from "./driver/parse.ts";

export type {
  CaptchaDetection,
  CaptchaKind,
  CaptchaSignal,
  CuaActionResult,
  CuaApp,
  CuaBrowserTarget,
  CuaEffect,
  CuaElement,
  CuaEscalation,
  CuaEvidence,
  CuaObservation,
  CuaScreenshot,
  CuaPageRef,
  CuaPageState,
  CuaRefusalCode,
  CuaWindow,
  EscalationRung,
} from "./types.ts";

export {
  click,
  doubleClick,
  hotkey,
  launchApp,
  listApps,
  listWindows,
  observeDesktop,
  observeWindow,
  pressKey,
  rankElements,
  rightClick,
  runSteps,
  screenshot,
  scroll,
  setValue,
  typeText,
} from "./tools/desktop.ts";
export type {
  ActionPosition,
  ActOptions,
  BatchResult,
  BatchStep,
  ObserveOptions,
  StepExpectation,
  WindowTarget,
} from "./tools/desktop.ts";

export {
  browserClick,
  browserDialog,
  browserNavigate,
  browserPointer,
  browserSelect,
  browserState,
  browserType,
  endBrowserSession,
  prepareBrowser,
  readPage,
} from "./tools/browser.ts";
export type { BrowserWindowRef } from "./tools/browser.ts";

export { detectCaptcha, describeDetection, siteKeyFromUrl } from "./captcha/detect.ts";
export type { PageSignals } from "./captcha/detect.ts";

export { assessChallenge, solverFromEnv } from "./captcha/challenge.ts";
export type { ChallengeAssessment, ChallengeOptions, ChallengePath } from "./captcha/challenge.ts";

export {
  createSolver,
  solverConfigFromEnv,
  solverRequestFor,
  tokenInjectionScript,
} from "./captcha/solver.ts";
export type { CaptchaSolver, SolverConfig, SolverProvider, SolverRequest, SolverResult } from "./captcha/solver.ts";

export { TOOL_INDEX, findTools } from "./tool-index.ts";
export type { ToolIndexEntry } from "./tool-index.ts";
