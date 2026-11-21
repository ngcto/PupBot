import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Metadata } from "next";
import Link from "next/link";
import { questions, tiers } from "../../content.ts";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Terabot is free while it is in development. You bring your own model key and your provider bills you for what your bots use. There is no paid plan.",
  alternates: { canonical: "/pricing" },
  openGraph: {
    type: "website",
    title: "Pricing — Terabot",
    description:
      "Terabot is free while it is in development. You bring your own model key and your provider bills you for what your bots use.",
    url: "/pricing",
    images: [{ url: "/og/pricing.png", width: 1200, height: 630, alt: "Terabot pricing: free while in development" }],
  },
};

export default function PricingPage() {
  return (
    <>
      <section className="section section-tight" style={{ borderTop: 0 }}>
        <div className="site-wrap">
          <h1 className="display">Pricing</h1>
          <p className="lede" style={{ marginTop: 20, maxWidth: 640 }}>
            One plan, and no charge from us while Terabot is in development. Your model provider bills you for what
            your bots use.
          </p>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0, borderTop: 0 }}>
        <div className="site-wrap">
          <div className="tiers">
            {tiers.map((tier) => (
              <article className="card" key={tier.id}>
                <div className="tier-head">
                  <h2 className="h3">{tier.name}</h2>
                  <span className="tag">{tier.availability === "available" ? "Available" : "Not yet"}</span>
                </div>
                <p className="price">{tier.price}</p>
                <p className="copy" style={{ marginTop: 10 }}>
                  {tier.summary}
                </p>

                {tier.included.length > 0 && (
                  <ul className="plain-list tier-list">
                    {tier.included.map((item) => (
                      <li key={item}>
                        <HugeiconsIcon icon={Tick02Icon} size={16} className="tier-tick" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                )}

                <ul className="plain-list tier-notes">
                  {tier.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section" id="api-key">
        <div className="site-wrap split">
          <div>
            <h2 className="h2">What the API key means</h2>
          </div>
          <div className="prose">
            <p>
              An API key is what a model provider gives you so software can call its models on your behalf and bill you
              for it. In Terabot you paste one into a bot&apos;s model settings, along with the provider&apos;s base URL
              and the model id.
            </p>
            <p>
              That is the whole arrangement: your key, your provider, your bill. Terabot does not resell model access,
              does not mark tokens up, and does not need a second account with us to spend money. The key is stored
              encrypted and only used to run your bots&apos; replies.
            </p>
            <p>
              <Link href="/docs">The docs describe where the setting lives</Link>.
            </p>
          </div>
        </div>
      </section>

      <section className="section" id="questions">
        <div className="site-wrap split">
          <div>
            <h2 className="h2">Questions</h2>
          </div>
          <dl className="spec">
            {questions.map((entry) => (
              <div className="spec-row spec-question" key={entry.question}>
                <dt>{entry.question}</dt>
                <dd>{entry.answer}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="section section-tight">
        <div className="site-wrap split">
          <div>
            <h2 className="h2">Nothing to buy today.</h2>
            <p className="copy" style={{ marginTop: 12, maxWidth: 520 }}>
              When there is something to install, it will be on the download page with its version.
            </p>
          </div>
          <div className="hero-actions" style={{ marginTop: 0, alignSelf: "end" }}>
            <Link className="btn btn-primary" href="/download">
              Go to download
            </Link>
            <Link className="btn btn-quiet" href="/docs">
              Read the docs
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
