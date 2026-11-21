import type { Metadata } from "next";
import Link from "next/link";
import { botParts, steps } from "../content.ts";
import { site } from "../site.ts";

export const metadata: Metadata = {
  title: "Bots that each get their own computer",
  description: site.description,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    title: `${site.name} — bots that each get their own computer`,
    description: site.description,
    url: "/",
    images: [{ url: "/og/home.png", width: 1200, height: 630, alt: `${site.name}: a bot's conversation beside its own computer` }],
  },
};

const endpointRows = [
  {
    term: "Endpoints",
    value: "An OpenAI-compatible chat endpoint, with the base URL and model id your provider gives you.",
  },
  {
    term: "Your key",
    value: "Stored encrypted with AES-256-GCM, and used only to run your bots' replies.",
  },
  {
    term: "Model metadata",
    value: "Context window and pricing come from models.dev, so the app knows what a model can take before a run starts.",
  },
  {
    term: "Billing",
    value: "Your provider bills you directly. Terabot does not resell model access.",
  },
];

export default function LandingPage() {
  return (
    <>
      <section className="hero">
        <div className="hero-glow" aria-hidden="true" />
        <div className="site-wrap">
          <h1 className="display" data-enter="">
            Bots that each get their own computer.
          </h1>
          <p className="lede hero-lede" data-enter="2" style={{ marginTop: 24 }}>
            Terabot is a chat app for bots you set up yourself. A bot has a name, a face and a standing brief. It
            answers through the model you point it at, and it is bound to a cloud computer of its own.
          </p>
          <div className="hero-actions" data-enter="3">
            <Link className="btn btn-primary" href="/download">
              Download the desktop app
            </Link>
            <Link className="btn btn-quiet" href="/download#mobile">
              Get it on mobile
            </Link>
          </div>
          <p className="small hero-fact" data-enter="4">
            Free while in development. You bring your own model key.
          </p>
        </div>

        <div className="site-wrap hero-shot" data-enter="4">
          <div className="shot">
            <img
              src="/shots/app-shell.png"
              alt="The Terabot app with a bot's conversation in the middle, the bot list on the left, and the bot's rail on the right showing that its computer is awake."
              width={2880}
              height={1800}
            />
          </div>
        </div>
      </section>

      <section className="section" id="what-a-bot-is">
        <div className="site-wrap split">
          <div>
            <h2 className="h2">A bot is three things.</h2>
            <ul className="plain-list stack-32" style={{ marginTop: 36 }}>
              {botParts.map((part) => (
                <li key={part.title}>
                  <h3 className="h3">{part.title}</h3>
                  <p className="copy" style={{ marginTop: 6 }}>
                    {part.body}
                  </p>
                </li>
              ))}
            </ul>
          </div>
          <figure className="shot">
            <img
              src="/shots/chat-detail.png"
              alt="A bot answering in its conversation: a question in the accent colour on the right, the reply in a bubble on the left with a three-item list."
              width={1646}
              height={780}
              loading="lazy"
            />
          </figure>
        </div>
      </section>

      <section className="section" id="how-it-works">
        <div className="site-wrap">
          <h2 className="h2">How it works</h2>
          <p className="lede" style={{ marginTop: 16, maxWidth: 560 }}>
            Three steps. The last one is a button, because a bot without a computer tells you what it needs instead of
            failing quietly.
          </p>
          <ol className="plain-list cols-3" style={{ marginTop: 56 }}>
            {steps.map((step, index) => (
              <li key={step.title}>
                <p className="eyebrow">{String(index + 1).padStart(2, "0")}</p>
                <h3 className="h3" style={{ marginTop: 12 }}>
                  {step.title}
                </h3>
                <p className="copy" style={{ marginTop: 8 }}>
                  {step.body}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="section" id="models">
        <div className="site-wrap split">
          <div>
            <h2 className="h2">Your key, your models.</h2>
            <p className="lede" style={{ marginTop: 18 }}>
              Terabot does not sell model access. You connect a provider you already pay for, and the key stays in the
              bot's settings, not in ours.
            </p>
          </div>
          <dl className="spec">
            {endpointRows.map((row) => (
              <div className="spec-row" key={row.term}>
                <dt>{row.term}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="section" id="where-it-runs">
        <div className="site-wrap split">
          <div>
            <h2 className="h2">Where it runs</h2>
            <p className="copy" style={{ marginTop: 16, maxWidth: 560 }}>
              Terabot is a desktop app for macOS, Windows and Linux, and a mobile app for iOS and Android. Both are
              being built. No build is published yet, and the download page says so on every button instead of sending
              you to a missing file. <Link href="/docs#status">The docs list what is wired today.</Link>
            </p>
          </div>
          <div className="stack-12" style={{ alignSelf: "end" }}>
            <div className="hero-actions" style={{ marginTop: 0 }}>
              <Link className="btn btn-primary" href="/download">
                See what is available
              </Link>
              <Link className="btn btn-quiet" href="/pricing">
                About pricing
              </Link>
            </div>
            <p className="small">One plan, free while the product is in development.</p>
          </div>
        </div>
      </section>
    </>
  );
}
