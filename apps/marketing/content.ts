/**
 * Copy that is also data: the pricing tiers, the questions, the steps.
 *
 * Everything here has to be true of the product as it is. If a limit is not
 * known, the copy says so instead of printing a number: `test/content.test.ts`
 * keeps the tiers and the guide words honest.
 */

export interface Tier {
  readonly id: string;
  readonly name: string;
  /** The price line, printed as written. */
  readonly price: string;
  readonly availability: "available" | "not-yet";
  readonly summary: string;
  readonly included: readonly string[];
  readonly notes: readonly string[];
}

export const tiers: readonly Tier[] = [
  {
    id: "free",
    name: "Terabot",
    price: "Free while in development",
    availability: "available",
    summary: "One plan, for everyone using Terabot today. We do not bill anything.",
    included: [
      "Bots with their own conversation, instructions and cloud computer",
      "Your own model provider, connected with your own key",
      "Chat history kept in your workspace",
      "The desktop and mobile apps, when their builds are published",
    ],
    notes: [
      "Model usage is billed by your provider, at its rates.",
      "Cloud computers come from the computer provider set up for your workspace.",
      "Computers are provisioned through a provider interface; the current build uses a stub provider until a real one is connected.",
      "No usage limits are published or enforced while the product is in development.",
    ],
  },
  {
    id: "paid",
    name: "Paid plan",
    price: "Not announced",
    availability: "not-yet",
    summary:
      "There is no paid plan, and nothing on this page is a reservation. If we add one, its price and its limits go here before anyone is charged.",
    included: [],
    notes: ["Nothing to buy today.", "Nothing to cancel."],
  },
];

export interface Question {
  readonly question: string;
  readonly answer: string;
}

export const questions: readonly Question[] = [
  {
    question: "Do I need an API key?",
    answer:
      "Yes. Terabot does not resell model access: you connect the provider you already pay for, with your key. The key is stored encrypted and used only to run your bots' replies.",
  },
  {
    question: "What does Terabot cost?",
    answer:
      "Nothing from us while it is in development. Your provider bills you for the tokens your bots use. There is no second bill and no per-seat charge.",
  },
  {
    question: "Where do the computers come from?",
    answer:
      "Each bot gets a cloud computer of its own, separate from every other bot's. It runs on the computer provider set up for your workspace, and the app shows whether it is awake.",
  },
  {
    question: "Can I install it yet?",
    answer:
      "Not yet. The desktop app for macOS, Windows and Linux and the mobile app are both being built and neither build is published. The download page says Coming soon on a button rather than sending you to a missing file.",
  },
];

export interface Step {
  readonly title: string;
  readonly body: string;
}

export const steps: readonly Step[] = [
  {
    title: "Make a bot",
    body: "Give it a name and a face, then write what it is for. Those instructions are sent before every conversation, so the bot keeps its standing brief instead of starting cold.",
  },
  {
    title: "Point it at a model",
    body: "Open the bot's settings and add a model endpoint: base URL, model id and your provider key. Terabot talks to your endpoint; it does not come with model access of its own.",
  },
  {
    title: "Give it a computer",
    body: "Each bot gets a cloud computer of its own. Until it has one the bot is visible but its composer is blocked, with the reason and a one-click fix.",
  },
];

export interface BotPart {
  readonly title: string;
  readonly body: string;
}

export const botParts: readonly BotPart[] = [
  {
    title: "A conversation",
    body: "One thread per bot. Replies stream as they are written, and if you interrupt one, what it already said stays in the thread.",
  },
  {
    title: "Instructions",
    body: "A standing brief in the bot's own settings. It is assembled into the context of every run, so the bot answers as the thing you described.",
  },
  {
    title: "A computer",
    body: "A cloud machine that belongs to that bot alone, listed in the rail with whether it is awake.",
  },
];

/** Words this site does not use. The content test refuses them. */
export const bannedWords: readonly string[] = [
  "revolutionary",
  "seamless",
  "unlock",
  "supercharge",
  "empower",
  "cutting-edge",
  "world-class",
  "game-changer",
  "effortless",
  "blazing",
  "state-of-the-art",
  "leverage",
  "synergy",
  "10x",
];
