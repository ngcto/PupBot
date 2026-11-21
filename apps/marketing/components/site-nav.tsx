import Link from "next/link";
import { navLinks, signInUrl } from "../site.ts";
import { Wordmark } from "./wordmark.tsx";

export function SiteNav() {
  return (
    <header className="nav">
      <div className="site-wrap nav-inner">
        <Link href="/" aria-label="Terabot home">
          <Wordmark />
        </Link>

        <nav aria-label="Main" className="nav-links">
          {navLinks.map((link) => (
            <Link key={link.href} href={link.href} className="nav-link">
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="nav-actions">
          <a href={signInUrl()} className="nav-link">
            Sign in
          </a>
          <Link href="/download" className="btn btn-primary btn-sm">
            Download
          </Link>
        </div>
      </div>
    </header>
  );
}
