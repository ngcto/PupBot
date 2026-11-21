import type { Metadata } from "next";
import Link from "next/link";
import { ReleaseRow } from "../../components/release-row.tsx";
import { publishedVersion, releasesOfKind } from "../../releases.ts";
import { signInUrl } from "../../site.ts";

export const metadata: Metadata = {
  title: "Download",
  description:
    "Desktop builds for macOS, Windows and Linux, and the mobile app for iOS and Android. Every published build is a direct download.",
  alternates: { canonical: "/download" },
  openGraph: {
    type: "website",
    title: "Download — Terabot",
    description:
      "Desktop builds for macOS, Windows and Linux, and the mobile app for iOS and Android. Every published build is a direct download.",
    url: "/download",
    images: [{ url: "/og/download.png", width: 1200, height: 630, alt: "Download Terabot for desktop and mobile" }],
  },
};

const desktop = releasesOfKind("desktop");
const mobile = releasesOfKind("mobile");

export default function DownloadPage() {
  // The copy has to follow `released.version.json`, or the first real release
  // ships a page that still tells people nothing is available.
  const version = publishedVersion;
  return (
    <>
      <section className="section section-tight" style={{ borderTop: 0 }}>
        <div className="site-wrap">
          <h1 className="display">Download</h1>
          <p className="lede" style={{ marginTop: 20, maxWidth: 660 }}>
            {version
              ? `Version ${version} is out. The desktop app runs on Windows and Linux, and the Android build sideloads on a phone. A platform the release does not include still says Coming soon rather than sending you to a file that is not there.`
              : "The desktop app comes to macOS, Windows and Linux. The mobile app comes to iOS and Android. Nothing is published yet, so every button below says Coming soon rather than sending you to a file that is not there."}
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
              {version
                ? "Every build above downloads straight from this release. macOS, iOS and the stores come later; those buttons keep saying Coming soon until they are real."
                : "A published build appears in the list above with its version and a working link, and the button stops saying Coming soon. Until then there is nothing to install."}
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
