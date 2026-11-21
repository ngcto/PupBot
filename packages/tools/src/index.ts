/**
 * The tool index: what a model can discover, and how it is rendered.
 *
 * A code-mode harness cannot put every tool's JSON Schema in the request — that is
 * the wall this exists to remove. So a tool is described here as **data about a
 * capability**, not as a schema for a call, and the harness decides how to render
 * it: a name, a situation, a cost, or (on demand, for two or three tools) a full
 * TypeScript declaration.
 *
 * Measured on our own surface (`reports/tera-81-measurements/`): the 26 CUA
 * functions cost 3,546 tokens as an Anthropic `tools` block, 1,200 as this index,
 * 81 as names alone, and 46 as one bare `codemode` tool. So the index is the cheap
 * representation and the schema block is the expensive one — the reverse of what
 * most harnesses do.
 *
 * Two rules shaped the entry shape:
 *
 * - **`when`, not only `what`.** A capability search has to match how a model
 *   describes being stuck ("the page is gated and clicks do nothing"), because it
 *   does not know our verb for the fix.
 * - **`cost` is stated.** A tree read is cheap enough to use freely; an image is
 *   thousands of tokens. That difference has to be visible before the call, not
 *   discovered from the bill.
 */

export type ToolCost = "cheap" | "moderate" | "expensive";

export type ToolCategory = "observe" | "act" | "browser" | "challenge" | "vault" | "data";

/**
 * Where a tool can run. A program in the bot's box cannot reach a host-only tool,
 * so this is what keeps discovery honest: the index shown to a program lists only
 * the tools that exist *where it is running*.
 *
 * The distinction matters more than it looks. Without it, a model sees
 * `vault_fill`, calls it, and gets a refusal it has to interpret. With it, the
 * tool is simply absent and the model never forms the wrong plan.
 */
export type ToolPlacement = "host" | "box" | "anywhere";

/**
 * A requirement a tool places on the box, in the vocabulary the computer contract
 * understands.
 *
 * These are the same strings as `RequiredCapability` in `@terabot/computers`, on
 * purpose. They were once different — a tool said `screen` while the allocator said
 * `screenshot` — and the two were meant to be joined by a translator that no file
 * ever contained, so a tool stating a need the allocator could not read would have
 * been placed on a box that could not serve it, silently. Sharing the words removes
 * that failure: `packages/computers/test/need-vocabulary.test.ts` is what keeps
 * them the same, and it fails when a capability is added on one side only.
 *
 * This package does not depend on `@terabot/computers` and should not start: a
 * shared vocabulary does not couple two packages, a translation layer does.
 */
export type ToolNeed = "exec" | "files" | "screenshot";

export interface ToolEntry {
  /** The identifier a program calls: `tools.<name>(args)`. */
  name: string;
  /** One line, present tense. What it does, not how. */
  description: string;
  /** Situations this tool is the answer to, phrased as a model would describe them. */
  when: string[];
  category: ToolCategory;
  cost: ToolCost;
  /** What a caller must not ignore in the result, in one phrase. */
  resultNote?: string;
  /** Where it can run. Defaults to `"anywhere"`. */
  placement?: ToolPlacement;
  /**
   * What the box a program runs on must provide beyond running the program.
   *
   * Placement already answers "can this tool run here at all". This answers the
   * different question the machine has to satisfy: `screenshot` means the tool
   * reads the box's screen, so a provider with no framebuffer cannot serve a run
   * that offers it. Stated on the tool because the tool is the only thing that
   * knows what it does with a computer; the allocator reads it as `requires`.
   *
   * The strings are the allocator's own, so no translation is needed or wanted —
   * see `ToolNeed` for why. Collect them with `computerRequiresFor(entries)`.
   */
  needs?: ToolNeed[];
  /**
   * The TypeScript signature, rendered by whoever owns the tool. Kept as data so
   * the index never needs to import the implementation — and so a declaration is
   * only paid for when the model asks for that tool.
   */
  signature?: string;
}

/**
 * The index, filtered to where the program is running.
 *
 * Generic in the entry type so a caller that carries more than an entry — a
 * dispatchable tool with an `execute`, say — gets its own type back instead of a
 * bare `ToolEntry` that has to be re-widened.
 */
export function availableIndex<T extends ToolEntry>(entries: T[], placement: ToolPlacement = "host"): T[] {
  if (placement === "anywhere") return entries;
  return entries.filter((entry) => (entry.placement ?? "anywhere") === "anywhere" || entry.placement === placement);
}

/**
 * Renders the index as the block that travels with the `codemode` tool.
 *
 * Deliberately terse: name, cost, one line, and the situations. Not the schema —
 * that is what makes it 1,200 tokens instead of 3,546 — and not the declarations,
 * because rendering all 26 as TypeScript measured **3,984** tokens, worse than the
 * raw schemas they replace. Declarations are for `declarationsFor(names)`.
 */
export function renderIndex(entries: ToolEntry[]): string {
  if (entries.length === 0) return "No tools are available here.";
  return entries
    .map((entry) => {
      const when = entry.when.length > 0 ? ` Use when: ${entry.when.join("; ")}.` : "";
      const note = entry.resultNote ? ` ${entry.resultNote}` : "";
      return `- ${entry.name} (${entry.cost}) — ${entry.description}${when}${note}`;
    })
    .join("\n");
}

/**
 * Declarations for the named tools only.
 *
 * `describe("click", "observeWindow")` is how a model asks for detail after the
 * index told it those two are the answer. Rendering per capability is the whole
 * point: all 26 at once costs more than the schemas it was meant to replace.
 */
export function declarationsFor(entries: ToolEntry[], names: string[]): string {
  const wanted = new Set(names);
  const found = entries.filter((entry) => wanted.has(entry.name));
  if (found.length === 0) return "No such tool in this index.";
  return found
    .map((entry) =>
      entry.signature
        ? `/** ${entry.description} */\n${entry.signature.trim()}`
        : `${entry.name}(args: Record<string, unknown>): Promise<unknown>; // ${entry.description}`,
    )
    .join("\n\n");
}

/**
 * Capability search over the index, for `searchTools(query)`.
 *
 * Scoring, in priority order: an exact name beats a situation phrase that matches
 * every word, which beats a situation phrase that matches some, which beats a
 * description match. A multi-word query that matches a whole situation is worth
 * more than the same words scattered, because "fill a form" belongs to the batch
 * tool, not to the single-field one that shares the verb.
 */
export function searchIndex<T extends ToolEntry>(entries: T[], query: string): T[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return entries;

  const scored = entries.map((entry) => {
    const name = entry.name.toLowerCase();
    const haystack = [entry.description, ...entry.when, entry.category, entry.resultNote ?? ""]
      .join(" ")
      .toLowerCase();

    let score = 0;
    for (const term of terms) {
      if (name === term) score += 10;
      if (name.includes(term)) score += 4;
      if (entry.when.some((phrase) => phrase.toLowerCase().includes(term))) score += 3;
      if (haystack.includes(term)) score += 1;
    }
    if (
      terms.length > 1 &&
      entry.when.some((phrase) => terms.every((term) => phrase.toLowerCase().includes(term)))
    ) {
      score += 6;
    }
    return { entry, score };
  });

  return scored
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((row) => row.entry);
}

/** Every entry's name, for a prompt that only needs the list. */
export function namesOf(entries: ToolEntry[]): string[] {
  return entries.map((entry) => entry.name);
}

/**
 * The needs a set of offered tools places on the box, deduplicated.
 *
 * This is not yet the allocator's `requires`: that function lives in the loop,
 * which owns the translation, because `@terabot/tools` does not depend on
 * `@terabot/computers` and should not start to for one string. What it removes is
 * the part that decays — walking the tools and collecting their needs — so the
 * loop's adapter is a mapping over a short list rather than a second place that
 * knows how tools describe themselves.
 */
export function computerRequiresFor(entries: ToolEntry[]): ToolNeed[] {
  const needs = new Set<ToolNeed>();
  for (const entry of entries) for (const need of entry.needs ?? []) needs.add(need);
  return [...needs];
}

export {
  codemodeSchema,
  renderForModel,
  runCodeMode,
} from "./codemode.ts";
export type { CodeModeOptions, CodeModeToolInput, DispatchableTool } from "./codemode.ts";
