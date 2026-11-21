import { lookup } from "node:dns/promises";
import { Agent } from "undici";

/**
 * Where the server is allowed to send a request it makes on a user's behalf.
 *
 * Chat reaches whatever provider the user saved, including a private BYO
 * gateway. Model listings and the test paths are different: they run before or
 * beside that commitment, so they refuse anything that is not a public
 * destination — including a hostname that only resolves to a private address,
 * an IPv4 address dressed up as IPv6, and a redirect that escapes the host.
 */

const MAX_REDIRECTS = 3;

function parseIpv4(host: string): number[] | null {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  const parts = host.split(".").map(Number);
  return parts.every((part) => part >= 0 && part <= 255) ? parts : null;
}

function toDotted(hi: number, lo: number): string {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
}

/**
 * `64:ff9b::/96` is the NAT64 well-known prefix and `64:ff9b:1::/48` its
 * local-use sibling: on a host whose only egress is a NAT64 gateway, these
 * literals are read by that gateway as IPv4, so a loopback or RFC 1918 tail
 * reaches the internal network. Read the embedded address back out (RFC 6052)
 * and let the caller judge it like any other IPv4.
 */
function ipv4FromNat64(hex: number[]): string | null {
  if (hex[0] !== 0x64 || hex[1] !== 0xff9b) return null;
  // The well-known prefix carries the address in its last 32 bits, so it can be
  // read and judged like any other IPv4. The local-use 64:ff9b:1::/48 spreads
  // the octets across the middle of the address; rather than trust a mapping
  // that depends on the gateway, that whole range is refused.
  if (hex.slice(2, 6).every((group) => group === 0)) return toDotted(hex[6] ?? 0, hex[7] ?? 0);
  return "0.0.0.0";
}

/** `::ffff:7f00:1` and `::ffff:127.0.0.1` are both `127.0.0.1`. */
function ipv4FromIpv6(host: string): string | null {
  if (!host.includes(":")) return null;
  const halves = host.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const hex = groups.map((group) => parseInt(group, 16));
  if (hex.some((value) => Number.isNaN(value) || value < 0 || value > 0xffff)) return null;
  const nat64 = ipv4FromNat64(hex);
  if (nat64) return nat64;
  // Only the IPv4-carrying shapes count: ::a.b.c.d, ::ffff:a.b.c.d and the
  // translated ::ffff:0:a.b.c.d all place the address in the last 32 bits.
  const first = hex.findIndex((value) => value !== 0);
  if (first === -1) return "0.0.0.0";
  const mapped =
    (first === 5 && hex[5] === 0xffff) ||
    (first === 4 && hex[4] === 0xffff && hex[5] === 0) ||
    first >= 6;
  if (!mapped) return null;
  return toDotted(hex[6] ?? 0, hex[7] ?? 0);
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
    const mapped = ipv4FromIpv6(host);
    if (mapped) return isPrivateOrLocalHost(mapped);
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

/** True when the destination is public; used to decide whether a listing may run at all. */
export async function isPublicDestination(raw: string): Promise<boolean> {
  try {
    await assertPublicDestination(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * The lookup the socket itself uses. Checking once and then handing the hostname
 * to fetch leaves a gap a rebinding answer can walk through, so every address a
 * connection resolves is checked here too.
 */
function guardedLookup(
  hostname: string,
  options: { family?: number; all?: boolean; hints?: number },
  callback: (...args: unknown[]) => void,
): void {
  lookup(hostname, { family: options?.family ?? 0, all: true, verbatim: true }).then(
    (addresses) => {
      if (addresses.length === 0) {
        callback(new Error(`the host ${hostname} could not be resolved`), "", 0);
        return;
      }
      if (addresses.some((entry) => isPrivateOrLocalHost(entry.address))) {
        callback(
          new Error(`${hostname} resolves to a private address, which cannot be reached from here`),
          "",
          0,
        );
        return;
      }
      if (options?.all) {
        callback(null, addresses);
        return;
      }
      callback(null, addresses[0]?.address ?? "", addresses[0]?.family ?? 4);
    },
    (error: Error) => callback(error, "", 0),
  );
}

/**
 * undici 7 is not a preference: on Node 26 the global `fetch` hands the request to
 * its own bundled dispatcher, and an `Agent` from undici 6 fails that handover with
 * `InvalidArgumentError: invalid onError method` before a socket is opened — every
 * guarded call failed, including a plain GET. Version 7 speaks the interface the
 * built-in fetch expects. `apps/web/package.json` carries the range.
 */
const publicDispatcher = new Agent({ connect: { lookup: guardedLookup as never } });

/**
 * `fetch` for the model-listing and test paths: validates the destination,
 * binds the connection to a checked address, and follows only same-host
 * redirects so a public URL cannot bounce the request into the private network.
 */
export const publicOnlyFetch: typeof globalThis.fetch = async (input, init) => {
  const target = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  let current = await assertPublicDestination(target);
  const origin = new URL(current);

  for (let hop = 0; ; hop += 1) {
    const response = await fetch(current, { ...init, redirect: "manual", dispatcher: publicDispatcher } as RequestInit);
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
