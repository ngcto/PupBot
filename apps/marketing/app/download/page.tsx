import type { Metadata } from "next";
import Link from "next/link";
import { ReleaseRow } from "../../components/release-row.tsx";
import { releasesOfKind } from "../../releases.ts";
import { signInUrl } from "../../site.ts";

export const metadata: Metadata = {
  title: "Download",
  description:
    "Desktop builds for macOS, Windows and Linux, and the mobile app for iOS and Android. No build is published yet, and the buttons say so.",
  alternates: { canonical: "/download" },
  openGraph: {
    type: "website",
    title: "Download — Terabot",
    description:
      "Desktop builds for macOS, Windows and Linux, and the mobile app for iOS and Android. No build is published yet.",
    url: "/download",
    images: [{ url: "/og/download.png", width: 1200, height: 630, alt: "Download Terabot for desktop and mobile" }],
  },
};

const desktop = releasesOfKind("desktop");
const mobile = releasesOfKind("mobile");

export default function DownloadPage() {
  return (
    <>
      <section className="section section-tight" style={{ borderTop: 0 }}>
        <div className="site-wrap">
          <h1 className="display">Download</h1>
          <p className="lede" style={{ marginTop: 20, maxWidth: 660 }}>
            The desktop app comes to macOS, Windows and Linux. The mobile app comes to iOS and Android. Neither build
            is published yet, so every button below says Coming soon rather than sending you to a file that is not
            there.
          </p>
        </div>
      </section>

      <section className="section" id="desktop" style={{ borderTop: 0, paddingTop: 0 }}>
        <div className="site-wrap split">
          <div>
            <h2 className="h2">Desktop</h2>
            <p className="copy" style={{ marginTop: 14, maxWidth: 420 }}>
              The full product: every bot, every conversation, and the rail that shows each bot&apos;s computer.
            </p>
          </div>
          <div className="stack-12">
            {desktop.map((release) => (
              <ReleaseRow key={release.id} release={release} />
            ))}
          </div>
        </div>
      </section>

      <section className="section" id="mobile">
        <div className="site-wrap split">
          <div>
            <h2 className="h2">Mobile</h2>
            <p className="copy" style={{ marginTop: 14, maxWidth: 420 }}>
              The same bots, on a phone. Store links go here when the builds are accepted.
            </p>
          </div>
          <div className="stack-12">
            {mobile.map((release) => (
              <ReleaseRow key={release.id} release={release} />
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="site-wrap split">
          <div>
            <h2 className="h2">When a build lands</h2>
            <p className="copy" style={{ marginTop: 14, maxWidth: 460 }}>
              A published build appears in the list above with its version and a working link, and the button stops
              saying Coming soon. Until then there is nothing to install.
            </p>
          </div>
          <div className="hero-actions" style={{ marginTop: 0, alignSelf: "end" }}>
            <a className="btn btn-primary" href={signInUrl()}>
              Sign in
            </a>
            <Link className="btn btn-quiet" href="/docs">
              Read the docs
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
