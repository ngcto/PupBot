import Link from "next/link";

export default function NotFound() {
  return (
    <section className="section section-tight">
      <div className="site-wrap">
        <p className="eyebrow">404</p>
        <h1 className="h2" style={{ marginTop: 14 }}>
          There is no page at that address.
        </h1>
        <p className="copy" style={{ marginTop: 12, maxWidth: 460 }}>
          The site has four pages: the product, pricing, downloads and docs.
        </p>
        <div className="hero-actions">
          <Link className="btn btn-primary" href="/">
            Back to the product
          </Link>
          <Link className="btn btn-quiet" href="/download">
            Download
          </Link>
        </div>
      </div>
    </section>
  );
}
