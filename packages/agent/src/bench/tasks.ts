/**
 * The ten benchmark tasks, with their validators.
 *
 * The validators are written here, before any run, so a task cannot be scored by
 * reading the transcript afterwards and deciding what counted. Each one reads only
 * two things: the final answer text, and the arm's tool-call log. It never reads the
 * harness's own opinion of whether it succeeded.
 *
 * `attemptable` is the honest column. Arm A has no tools at all, so the nine tasks
 * that need one are marked unattemptable rather than scored zero — a zero would make
 * arm A look like it tried and failed, which is a different claim.
 */

import type { Arm, ArmBuild } from "./arms.ts";
import { STALE_TOKEN } from "./arms.ts";
import { treeFor, WINDOWS } from "./fixtures.ts";

export interface Task {
  id: number;
  /** What the model is asked, verbatim and identically in every arm. */
  prompt: string;
  /** The property this task tests, for the report's table. */
  property: string;
  /** Tools the task needs by name. */
  needs: string[];
  /** Whether an arm can attempt it at all. */
  attemptable: (arm: Arm) => boolean;
  /**
   * Judges the run from the answer and the call log. Returns true for correct.
   * `answer` is the assistant's final text; `build` is the arm's state and log.
   */
  validate: (answer: string, build: ArmBuild) => { ok: boolean; why: string };
}

/** Every task that needs a tool is unattemptable by an arm with none. */
const needsTools = (arm: Arm): boolean => arm !== "a";

/**
 * Task 11 is the only task all three arms can attempt: a plain question that needs
 * no tool at all.
 *
 * It exists because arm A otherwise reads `n/a` in every cell, which leaves the table
 * with no measurement of the product as it ships. It is also the honest cost test for
 * code mode: on a task that needs no tools, arm C's 1,877-token index is pure
 * overhead, and if it loses on turns or tokens here that goes in the table.
 */
const TASK_11: Task = {
  id: 11,
  prompt: "In two sentences, explain why an action that is refused should not be reported as a success.",
  property: "The no-tool baseline: what each arm costs when no tool is needed",
  needs: [],
  attemptable: () => true,
  validate: (answer) => {
    const sentences = answer.split(/[.!?]+/).filter((part) => part.trim().length > 0).length;
    const concrete = /refus|denied|not (applied|done)|unverif|fail/i.test(answer);
    return {
      ok: sentences >= 2 && concrete,
      why: `${sentences} sentence(s), mentioned refusal=${concrete}`,
    };
  },
};

export const TASKS: Task[] = [
  {
    id: 1,
    prompt: "Which apps are running, and which one owns the frontmost window?",
    property: "Two cheap observations combined into one answer",
    needs: ["listApps", "listWindows"],
    attemptable: needsTools,
    validate: (answer, build) => {
      const called = new Set(build.log.map((c) => c.name));
      const named = ["Invoices", "Mail", "Editor"].every((app) => answer.includes(app));
      return {
        ok: called.has("listApps") && named,
        why: `called listApps=${called.has("listApps")}, named the apps=${named}`,
      };
    },
  },
  {
    id: 2,
    prompt: "Open the Mail app and tell me the title of the window it created.",
    property: "Acting, then observing the effect",
    needs: ["launchApp"],
    attemptable: needsTools,
    validate: (answer, build) => {
      const launched = build.world.launched;
      return {
        ok: launched === "Mail" && /Mail\s*—\s*Untitled/.test(answer),
        why: `launched=${launched ?? "nothing"}, title in answer=${/Mail\s*—\s*Untitled/.test(answer)}`,
      };
    },
  },
  {
    id: 3,
    prompt:
      "In the Invoices window, fill the three text fields with any values and submit. Then tell me whether the form is closed.",
    property: "A multi-step sequence with verification; many turns in B, one program in C",
    needs: ["observeWindow", "typeText", "click"],
    attemptable: needsTools,
    validate: (_answer, build) => {
      const filled = [...build.world.values.values()].filter((v) => v.length > 0).length;
      const clicked = build.world.clicked.length;
      return { ok: filled >= 3 && clicked >= 1, why: `filled ${filled} fields, made ${clicked} clicks` };
    },
  },
  {
    id: 4,
    prompt:
      "In the Invoices window, find the element labelled \"Approve invoice\" and click it. Use the element token, not a coordinate, and tell me the token you used.",
    property: "Token discipline: acting on a fresh observation, not a guessed point",
    needs: ["observeWindow", "click"],
    attemptable: needsTools,
    validate: (answer, build) => {
      const click = build.log.find((c) => c.name === "click");
      const token = typeof click?.input.token === "string" ? click.input.token : "";
      const effect = click?.effect;
      return {
        ok: Boolean(token) && effect === "confirmed" && answer.includes(token),
        why: `token=${token || "none"}, effect=${effect ?? "none"}, echoed=${token ? answer.includes(token) : false}`,
      };
    },
  },
  {
    id: 5,
    prompt:
      "In the Invoices window there are 24 rows. Click every row that is actionable, and tell me how many you clicked.",
    property: "The turn-count property: many similar actions in one program vs one turn each",
    needs: ["observeWindow", "click"],
    attemptable: needsTools,
    validate: (answer, build) => {
      const clicks = build.log.filter((c) => c.name === "click").length;
      const said = answer.match(/\b(\d+)\b/);
      const claimed = said ? Number(said[1]) : -1;
      // The count in the answer must be the count actually made, and non-trivial.
      return {
        ok: clicks >= 4 && claimed === clicks,
        why: `${clicks} clicks made, answer claimed ${claimed}`,
      };
    },
  },
  {
    id: 6,
    prompt:
      "Read the Mail window's tree and tell me whether anything in it is actionable. Answer yes or no and name one actionable element.",
    property: "Reading a large structured result and answering one question from it",
    needs: ["observeWindow"],
    attemptable: needsTools,
    validate: (answer) => ({
      ok: /yes/i.test(answer) && /button|textfield|link|checkbox/i.test(answer),
      why: `said yes=${/yes/i.test(answer)}, named an actionable role=${/button|textfield|link|checkbox/i.test(answer)}`,
    }),
  },
  {
    id: 7,
    prompt:
      "Navigate to https://example.test/report and tell me the page title and whether a challenge gates it.",
    property: "Browser path plus a state field that is not a failure",
    needs: ["prepareBrowser", "browserNavigate", "readPage"],
    attemptable: needsTools,
    validate: (answer, build) => {
      const navigated = build.world.navigated === "https://example.test/report";
      const titled = answer.includes("Example Domain");
      const gated = /not gated|no challenge|false|no,/i.test(answer);
      return { ok: navigated && titled && gated, why: `navigated=${navigated}, title=${titled}, said ungated=${gated}` };
    },
  },
  {
    id: 8,
    prompt:
      "On the page, type \"quarterly\" into the search field and confirm the value landed, without taking a screenshot.",
    property: "Acting and verifying without an image, whose cost is unmeasurable",
    needs: ["browserType", "readPage"],
    attemptable: needsTools,
    validate: (answer, build) => {
      const typed = [...build.world.values.values()].includes("quarterly");
      const shot = build.log.some((c) => c.name === "screenshot");
      return { ok: typed && !shot && /quarterly/i.test(answer), why: `value set=${typed}, took a screenshot=${shot}` };
    },
  },
  {
    id: 9,
    prompt: `Click the element token ${STALE_TOKEN} in the Invoices window. If that fails, recover and tell me what you did instead.`,
    property: "Recovery: branching on a refusal rather than claiming success",
    needs: ["click", "observeWindow"],
    attemptable: needsTools,
    validate: (answer, build) => {
      const first = build.log.find((c) => c.name === "click");
      const refused = first?.effect === "refused";
      const recovered = build.log.some((c, i) => i > 0 && c.effect === "confirmed");
      const honest = /stale|refus|older snapshot|re-?(read|observed)/i.test(answer);
      return { ok: refused && recovered && honest, why: `first refused=${refused}, recovered=${recovered}, said so=${honest}` };
    },
  },
  {
    id: 10,
    prompt:
      "In the Invoices window, tell me how many rows are actionable, and name the token of the row labelled \"Approve invoice\".",
    property: "Filtering a large result before the model sees it; replaces the spreadsheet read",
    needs: ["observeWindow"],
    attemptable: needsTools,
    validate: (answer, build) => {
      const called = build.log.some((c) => c.name === "observeWindow");
      const { actionable, targetToken } = task10Expected();
      // The token in the answer must be *the* Approve invoice row's, not merely a
      // token-shaped string — otherwise a model that guesses passes this task.
      const gaveRightToken = targetToken.length > 0 && answer.includes(targetToken);
      const saidCount = new RegExp(`\\b${actionable}\\b`).test(answer);
      return {
        ok: called && gaveRightToken && saidCount,
        why: `observed=${called}, right token=${gaveRightToken}, said ${actionable}=${saidCount}`,
      };
    },
  },
  TASK_11,
];

/** Task 10's expected answer, computed from the fixture rather than hard-coded. */
export function task10Expected(): { actionable: number; targetToken: string } {
  const window = WINDOWS.find((w) => w.id === "w1")!;
  const rows = treeFor(WINDOWS.indexOf(window) + 1, window.rows);
  return {
    actionable: rows.filter((r) => r.actionable).length,
    targetToken: rows.find((r) => r.label === "Approve invoice")?.token ?? "",
  };
}
