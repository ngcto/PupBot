import Link from "next/link";
import { signInUrl, signUpUrl } from "../site.ts";
import { Wordmark } from "./wordmark.tsx";

export function SiteFooter() {
  return (
    <footer className="footer">
      <div className="site-wrap">
        <div className="footer-grid">
          <div>
            <Link href="/" aria-label="Terabot home">
              <Wordmark />
            </Link>
            <p className="small" style={{ marginTop: 14, maxWidth: 260 }}>
              Bots that each get their own computer.
            </p>
          </div>

          <div className="footer-col">
            <h2>Product</h2>
            <ul>
              <li>
                <Link href="/">Overview</Link>
              </li>
              <li>
                <Link href="/pricing">Pricing</Link>
              </li>
              <li>
                <Link href="/download">Download</Link>
              </li>
              <li>
                <Link href="/docs">Docs</Link>
              </li>
            </ul>
          </div>

          <div className="footer-col">
            <h2>App</h2>
            <ul>
              <li>
                <a href={signInUrl()}>Sign in</a>
              </li>
              <li>
                <a href={signUpUrl()}>Create an account</a>
              </li>
              <li>
                <Link href="/download">Desktop and mobile</Link>
              </li>
            </ul>
          </div>
        </div>

        <div className="rule" style={{ marginBlock: 36 }} />

        <p className="small">© 2026 Terabot. Free while in development.</p>
      </div>
    </footer>
  );
}
