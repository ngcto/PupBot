import { describe, expect, it } from "vitest";
import {
  availableIndex,
  computerRequiresFor,
  declarationsFor,
  namesOf,
  renderIndex,
  searchIndex,
} from "../src/index.ts";
import type { ToolEntry, ToolNeed } from "../src/index.ts";

function entry(name: string, extra: Partial<ToolEntry> = {}): ToolEntry {
  return {
    name,
    description: `${name} does a thing`,
    when: [],
    category: "act",
    cost: "cheap",
    ...extra,
  };
}

describe("placement filtering", () => {
  it("hides a box-only tool from a host program and vice versa", () => {
    const entries = [
      entry("read_window", { placement: "box" }),
      entry("vault_fill", { placement: "host" }),
      entry("notes", {}),
    ];

    expect(availableIndex(entries, "host").map((e) => e.name)).toEqual(["vault_fill", "notes"]);
    expect(availableIndex(entries, "box").map((e) => e.name)).toEqual(["read_window", "notes"]);
    expect(availableIndex(entries, "anywhere")).toHaveLength(3);
  });

  it("treats an entry with no placement as available everywhere", () => {
    expect(availableIndex([entry("x")], "box")).toHaveLength(1);
  });

  it("means a program never sees the tool it may not call", () => {
    // This is the point: discovery filters, so `unavailable_here` stays rare and a
    // model does not form a plan around a capability it cannot reach.
    const index = availableIndex([entry("vault_fill", { placement: "host" })], "box");
    expect(renderIndex(index)).toContain("No tools are available here.");
  });
});

describe("rendering", () => {
  const click = entry("click", {
    description: "Click one exact target.",
    when: ["press a button", "follow a link"],
    resultNote: "check effect and escalation before claiming success",
    cost: "cheap",
  });
  const shot = entry("screenshot", {
    description: "Capture one window or the display.",
    when: ["see the screen"],
    cost: "expensive",
  });

  it("renders name, cost, description and situations, and no schema", () => {
    const text = renderIndex([click]);
    expect(text).toContain("click (cheap)");
    expect(text).toContain("Use when: press a button; follow a link.");
    expect(text).toContain("check effect and escalation");
    expect(text).not.toContain("properties");
  });

  it("says when nothing is available rather than rendering an empty list", () => {
    expect(renderIndex([])).toBe("No tools are available here.");
  });

  it("keeps an expensive tool visibly expensive", () => {
    expect(renderIndex([shot])).toContain("(expensive)");
  });
});

describe("declarations on demand", () => {
  const withSig = (name: string, signature: string): ToolEntry =>
    entry(name, { signature, description: `${name} described` });

  it("renders only the tools asked for", () => {
    const entries = [withSig("click", "click(args: { target: string }): Promise<unknown>;"), withSig("typeText", "typeText(args: { text: string }): Promise<unknown>;")];
    const text = declarationsFor(entries, ["click"]);
    expect(text).toContain("click(args");
    expect(text).not.toContain("typeText(args");
  });

  it("falls back to a generic signature when no declaration was supplied", () => {
    const text = declarationsFor([entry("mystery")], ["mystery"]);
    expect(text).toContain("mystery(args: Record<string, unknown>)");
    expect(text).toContain("// mystery does a thing");
  });

  it("names the miss when the model asks for a tool that is not there", () => {
    expect(declarationsFor([entry("click")], ["nope"])).toBe("No such tool in this index.");
  });
});

describe("capability search", () => {
  const click = entry("click", { when: ["press a button", "follow a link"] });
  const runSteps = entry("run_steps", {
    description: "Run several actions in one call.",
    when: ["fill a form", "do several clicks in a row"],
  });
  const typeText = entry("type_text", {
    description: "Type into a field.",
    when: ["fill a field", "enter text"],
  });
  const readPage = entry("read_page", {
    description: "Snapshot a bound tab.",
    when: ["read a page", "why do my clicks do nothing"],
  });

  it("finds a tool from the situation a model would describe", () => {
    expect(searchIndex([click, runSteps, typeText, readPage], "the page is gated and clicks do nothing")[0]?.name).toBe(
      "read_page",
    );
  });

  it("prefers the batch tool for 'fill a form' over the single-field one", () => {
    const ranked = searchIndex([click, runSteps, typeText, readPage], "fill a form");
    expect(ranked[0]?.name).toBe("run_steps");
  });

  it("prefers an exact name match above everything", () => {
    const ranked = searchIndex([click, runSteps, typeText, readPage], "click");
    expect(ranked[0]?.name).toBe("click");
  });

  it("returns the whole index for an empty query, so browsing works", () => {
    expect(searchIndex([click, runSteps], "   ")).toHaveLength(2);
  });

  it("returns nothing rather than guessing when nothing matches", () => {
    expect(searchIndex([click, runSteps], "quantum flux")).toEqual([]);
  });
});

describe("names", () => {
  it("lists names for a prompt that only needs the list", () => {
    expect(namesOf([entry("a"), entry("b")])).toEqual(["a", "b"]);
  });
});

describe("box needs a tool places on its computer", () => {
  it("keeps an entry with no stated need compatible with every box", () => {
    expect(computerRequiresFor([entry("read_window"), entry("vault_fill")])).toEqual([]);
  });

  it("collects the needs of the tools actually offered, deduplicated", () => {
    // Two tools that read the screen are one requirement, not two: the allocator
    // asks "can this box show a screen", which is a yes or no.
    const tools = [
      entry("screenshot", { needs: ["screenshot"] }),
      entry("click_at", { needs: ["screenshot"] }),
      entry("read_window"),
    ];
    expect(computerRequiresFor(tools)).toEqual(["screenshot"]);
  });

  it("does not read a need from a tool the caller is not offering", () => {
    // The requirement comes from the tools a run is actually given, so removing
    // the screen tool removes the requirement rather than leaving it behind.
    const offered = [entry("read_window")];
    const inTheCatalogue = [entry("screenshot", { needs: ["screenshot"] })];
    expect(computerRequiresFor(offered)).toEqual([]);
    expect(computerRequiresFor(inTheCatalogue)).toEqual(["screenshot"]);
  });

  it("names every need the type allows, so a new one cannot go unhandled", () => {
    // `anyNeeds()` is a `Record<ToolNeed, true>`, which cannot be written without
    // listing every member of the union. Adding a need therefore fails to compile
    // here, on whoever adds it, rather than reaching a runtime path months later.
    expect(anyNeeds().sort()).toEqual(["exec", "files", "screenshot"]);
  });
});

/**
 * Every need the type allows, as data. A `Record<ToolNeed, true>` cannot be
 * written without listing each member, so adding one to the union fails to
 * compile here — which is the point: the failure lands on whoever adds the need,
 * not on a runtime path months later.
 */
function anyNeeds(): ToolNeed[] {
  const all: Record<ToolNeed, true> = { exec: true, files: true, screenshot: true };
  return Object.keys(all) as ToolNeed[];
}
