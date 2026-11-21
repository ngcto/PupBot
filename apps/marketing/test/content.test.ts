import { describe, expect, it } from "vitest";
import { bannedWords, botParts, questions, steps, tiers } from "../content.ts";

const everyString = [
  ...tiers.flatMap((tier) => [tier.name, tier.price, tier.summary, ...tier.included, ...tier.notes]),
  ...questions.flatMap((entry) => [entry.question, entry.answer]),
  ...steps.flatMap((step) => [step.title, step.body]),
  ...botParts.flatMap((part) => [part.title, part.body]),
];

describe("pricing", () => {
  it("offers exactly one plan today", () => {
    const available = tiers.filter((tier) => tier.availability === "available");
    expect(available).toHaveLength(1);
    expect(available[0]?.price.toLowerCase()).toContain("free while in development");
  });

  it("does not print a price for a plan that does not exist", () => {
    const notYet = tiers.filter((tier) => tier.availability === "not-yet");
    expect(notYet.length).toBeGreaterThan(0);
    for (const tier of notYet) {
      expect(tier.price.toLowerCase()).toBe("not announced");
      expect(tier.included).toHaveLength(0);
    }
  });

  it("states what is billed instead of hiding it", () => {
    const free = tiers.find((tier) => tier.id === "free");
    expect(free?.notes.join(" ").toLowerCase()).toContain("billed by your provider");
  });
});

describe("claims", () => {
  it("invents no numeric limits", () => {
    const invented = /(\d+)\s*(bots|messages|computers|seats|users|workspaces|requests|hours|minutes|gb|mb|%)/i;
    for (const line of everyString) {
      expect(line, `"${line}" states a limit we cannot back up`).not.toMatch(invented);
    }
  });

  it("uses no hype words", () => {
    for (const line of everyString) {
      for (const word of bannedWords) {
        expect(line.toLowerCase(), `"${line}" uses "${word}"`).not.toContain(word);
      }
    }
  });

  it("asks questions that are questions and answers them in sentences", () => {
    for (const entry of questions) {
      expect(entry.question.endsWith("?")).toBe(true);
      expect(entry.answer.endsWith(".")).toBe(true);
    }
  });

  it("gives every step an instruction and a reason", () => {
    expect(steps).toHaveLength(3);
    for (const step of steps) {
      expect(step.body.length).toBeGreaterThan(60);
    }
  });
});
