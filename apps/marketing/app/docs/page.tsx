import type { Metadata } from "next";
import Link from "next/link";
import { botParts } from "../../content.ts";

export const metadata: Metadata = {
  title: "Docs",
  description:
    "What a bot is, how to connect your own model endpoint, and what a bot's computer does. Written for the app as it is built today.",
  alternates: { canonical: "/docs" },
  openGraph: {
    type: "website",
    title: "Docs — Terabot",
    description: "What a bot is, how to connect a model endpoint, and what a bot's computer does.",
    url: "/docs",
    images: [{ url: "/og/docs.png", width: 1200, height: 630, alt: "Terabot docs" }],
  },
};

const contents = [
  { id: "what-a-bot-is", label: "What a bot is" },
  { id: "connect-a-model", label: "Connect a model" },
  { id: "computer", label: "Connect a computer" },
  { id: "accounts", label: "Accounts and data" },
  { id: "status", label: "Status" },
] as const;

export default function DocsPage() {
  return (
    <div className="site-wrap doc-layout">
      <article className="doc">
        <header>
          <h1 className="display">Docs</h1>
          <p className="lede" style={{ marginTop: 18 }}>
            What Terabot is made of, and how to set a bot up. Written against the app as it is built today, not against
            a plan.
          </p>
        </header>

        <section id="what-a-bot-is" style={{ marginTop: 44 }}>
          <h2>What a bot is</h2>
          <div className="prose">
            <p>
              A bot is not a prompt you reuse. It is a named thing in your workspace with its own conversation and its
              own machine.
            </p>
            {botParts.map((part) => (
              <div key={part.title}>
                <h3>{part.title}</h3>
                <p>{part.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="connect-a-model">
          <h2>Connect a model</h2>
          <div className="prose">
            <p>
              Terabot does not come with model access. Each bot points at an endpoint you control, which means a base
              URL, a model id and an API key from the provider you already pay.
            </p>
            <h3>Where it lives</h3>
            <p>
              Open the bot&apos;s settings and find the <strong>Model</strong> group. Pick an endpoint you have used
              before, or add one with its base URL, the model id and your API key. The bot keeps that endpoint and the
              model id you choose, so two bots can run on different providers.
            </p>
            <h3>What is supported</h3>
            <p>
              An OpenAI-compatible chat completions endpoint. Model metadata — context window and pricing — comes
              from models.dev and is stored with the endpoint, so the app knows what a model can take before a run
              starts.
            </p>
            <h3>What happens to the key</h3>
            <p>
              It is encrypted with AES-256-GCM before it is stored, and decrypted only to make a call on your behalf.
              It is never written into a conversation&apos;s transcript or a run&apos;s event log.
            </p>
          </div>
        </section>

        <section id="computer">
          <h2>Connect a computer</h2>
          <div className="prose">
            <p>
              Every bot gets a cloud computer of its own. A bot without one is still visible in the sidebar, but its
              composer is replaced with the reason and a <strong>Connect a computer</strong> button, so a missing
              machine never looks like a broken chat.
            </p>
            <p>
              The rail lists the bot&apos;s computer and whether it is awake. It is the bot&apos;s machine, not a pool
              shared with the rest of the workspace.
            </p>
            <p>
              Provisioning goes through an allocator over a provider interface, with Instabox as the provider. It
              creates a machine on request, sleeps it when it goes idle, renews its lease and starts it again when work
              needs it. A wake that times out, or one that finds the box gone, replaces it; a credential or quota
              failure keeps the box bound and blocks the bot with the reason.
            </p>
            <p>
              Running commands on that machine from a chat is not wired yet: the harness in this build sends your
              message to the model and streams the reply, and tool calling is what comes next. The computer is real and
              the rail shows whether it is awake or asleep; it is not yet taking orders.
            </p>
          </div>
        </section>

        <section id="accounts">
          <h2>Accounts and data</h2>
          <div className="prose">
            <p>
              You sign in with an email address and a password. Your bots, their instructions, their conversations and
              their endpoints belong to your workspace and are stored in Postgres.
            </p>
            <p>
              Runs are queued and streamed as they are written. A new message interrupts the reply in flight, keeps
              what it already said, and continues with your message in context.
            </p>
          </div>
        </section>

        <section id="status">
          <h2>Status</h2>
          <div className="prose">
            <p>What exists today, and what does not:</p>
            <ul>
              <li>
                No build is published. The <Link href="/download">download page</Link> marks macOS, Windows, Linux, iOS
                and Android as Coming soon.
              </li>
              <li>Model endpoints are OpenAI-compatible chat completions. Anthropic and Responses endpoints are not wired.</li>
              <li>
                Computers are real Instabox machines, allocated per bot. The bot cannot run commands on one from a chat
                yet; tool calling is the next piece.
              </li>
              <li>
                Pricing is <Link href="/pricing">free while in development</Link>, and there is no paid plan.
              </li>
            </ul>
            <p>If something here stops matching the app, the app is right and this page is wrong.</p>
          </div>
        </section>
      </article>

      <nav className="doc-nav" aria-label="On this page">
        <p className="eyebrow">On this page</p>
        <ul className="plain-list">
          {contents.map((entry) => (
            <li key={entry.id}>
              <a href={`#${entry.id}`}>{entry.label}</a>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
