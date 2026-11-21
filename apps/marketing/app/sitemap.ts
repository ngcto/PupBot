import type { MetadataRoute } from "next";
import { absoluteUrl } from "../site.ts";

const routes = ["/", "/pricing", "/download", "/docs"] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  return routes.map((route) => ({
    url: absoluteUrl(route),
    changeFrequency: "monthly",
    priority: route === "/" ? 1 : 0.7,
  }));
}
