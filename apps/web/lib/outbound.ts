import { lookup } from "node:dns/promises";

/**
 * Where the server is allowed to send a request it makes on a user's behalf.
 *
 * A saved provider may point anywhere — a local llama.cpp or a LAN gateway is a
 * legitimate BYO endpoint, and the chat adapters reach it. The *test* paths are
 * different: they are a fresh outbound connection to whatever the caller just
 * typed, so they refuse anything that is not a public destination, including a
 * hostname that only resolves to a private address and a redirect that escapes
 * one.
 */

const MAX_REDIRECTS = 3;

function parseIpv4(host: string): number[] | null {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  const parts = host.split(".").map(Number);
  return parts.every((part) => part >= 0 && part <= 255) ? parts : null;
}

export function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase().replace(/\.$/, "");
}

export function isPrivateOrLocalHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (!host) return true;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    (!host.includes(".") && !host.includes(":"))
  ) {
    return true;
  }

  const ipv4 = parseIpv4(host);
  if (ipv4) {
    const [a, b] = ipv4;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a === 169 && b === 254) return true; // link-local / metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true; // multicast/reserved
    return false;
  }

  if (host.includes(":")) {
    if (host === "::1" || host === "::") return true;
    if (host.startsWith("fc") || host.startsWith("fd")) return true; // ULA fc00::/7
    if (/^fe[89ab]/.test(host)) return true; // fe80::/10 link-local
    if (host.startsWith("::ffff:")) {
      const mapped = host.slice(7);
      if (parseIpv4(mapped)) return isPrivateOrLocalHost(mapped);
    }
  }

  return false;
}

function parseHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("the base URL is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("the base URL must use http or https");
  }
  return url;
}

/** Literal-host check: no DNS, no request. */
export function assertPublicEndpointUrl(raw: string): string {
  const url = parseHttpUrl(raw);
  if (isPrivateOrLocalHost(url.hostname)) {
    throw new Error("the base URL must point to a public host, not localhost or a private network");
  }
  return url.toString();
}

/**
 * Literal check plus one DNS resolution, so `evil.example` cannot stand in for
 * `127.0.0.1`. Every address the name resolves to has to be public.
 */
export async function assertPublicDestination(raw: string): Promise<string> {
  const url = parseHttpUrl(raw);
  const host = normalizeHost(url.hostname);
  if (isPrivateOrLocalHost(host)) {
    throw new Error("the base URL must point to a public host, not localhost or a private network");
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new Error(`the host ${host} could not be resolved`);
  }
  if (addresses.length === 0) throw new Error(`the host ${host} could not be resolved`);
  if (addresses.some((entry) => isPrivateOrLocalHost(entry.address))) {
    throw new Error(`${host} resolves to a private address, which cannot be reached from here`);
  }
  return url.toString();
}

/**
 * `fetch` for the test paths: validates the destination (including DNS) before
 * every request, and follows only same-host redirects so a public URL cannot
 * bounce the request into the private network.
 */
export const publicOnlyFetch: typeof globalThis.fetch = async (input, init) => {
  const target = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  let current = await assertPublicDestination(target);
  const origin = new URL(current);

  for (let hop = 0; ; hop += 1) {
    const response = await fetch(current, { ...init, redirect: "manual" });
    const location = response.headers.get("location");
    if (!location || ![301, 302, 303, 307, 308].includes(response.status)) return response;

    await response.body?.cancel().catch(() => undefined);
    if (hop >= MAX_REDIRECTS) throw new Error("the endpoint redirected too many times");
    const next = new URL(location, current);
    if (normalizeHost(next.hostname) !== normalizeHost(origin.hostname)) {
      throw new Error(
        `${origin.host} redirected to ${next.host}; use the final address as the base URL`,
      );
    }
    current = await assertPublicDestination(next.toString());
  }
};
