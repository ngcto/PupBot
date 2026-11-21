import { describe, expect, it } from "vitest";
import { assertPublicEndpointUrl, isPrivateOrLocalHost } from "../lib/outbound.ts";

/**
 * The WHATWG parser canonicalises an IPv4-mapped literal to hex, so
 * `[::ffff:127.0.0.1]` arrives as `[::ffff:7f00:1]`. Both spellings have to be
 * refused, or the probe reaches loopback and the LAN.
 */
describe("outbound destination checks", () => {
  it("refuses IPv4 dressed up as IPv6", () => {
    for (const host of [
      "::ffff:7f00:1",
      "::ffff:a00:1",
      "::ffff:a9fe:a9fe",
      "::7f00:1",
      "::ffff:0:7f00:1",
    ]) {
      expect(isPrivateOrLocalHost(host), host).toBe(true);
    }
  });

  /**
   * On a host whose egress is a NAT64 gateway, `64:ff9b::/96` is read as IPv4,
   * so a private tail reaches the internal network even though the literal is
   * not a mapped address.
   */
  it("refuses NAT64 literals carrying a private IPv4", () => {
    for (const host of [
      "64:ff9b::7f00:1",
      "64:ff9b::a00:1",
      "64:ff9b::c0a8:10a",
      "64:ff9b::a9fe:a9fe",
      "64:ff9b:1::7f00:1",
    ]) {
      expect(isPrivateOrLocalHost(host), host).toBe(true);
    }
    expect(() => assertPublicEndpointUrl("http://[64:ff9b::7f00:1]:8080/v1")).toThrow(/private/);
    expect(() => assertPublicEndpointUrl("http://[64:ff9b::a00:1]/v1")).toThrow(/private/);
  });

  it("still allows a NAT64 literal carrying a public IPv4", () => {
    expect(isPrivateOrLocalHost("64:ff9b::808:808")).toBe(false);
    expect(assertPublicEndpointUrl("http://[64:ff9b::808:808]/v1")).toContain("64:ff9b::808:808");
  });

  it("refuses dotted private hosts, localhost and link-local IPv6", () => {
    for (const host of ["127.0.0.1", "10.0.0.1", "192.168.1.10", "169.254.169.254", "localhost", "::1", "fe80::1", "fc00::1"]) {
      expect(isPrivateOrLocalHost(host), host).toBe(true);
    }
  });

  it("allows public IPv4 and IPv6", () => {
    for (const host of ["8.8.8.8", "2606:4700:4700::1111", "api.openai.com"]) {
      expect(isPrivateOrLocalHost(host), host).toBe(false);
    }
  });

  it("refuses a mapped literal before any request is made", () => {
    expect(() => assertPublicEndpointUrl("http://[::ffff:127.0.0.1]:8080/v1")).toThrow(/private/);
    expect(() => assertPublicEndpointUrl("http://[::ffff:10.0.0.1]:8080/v1")).toThrow(/private/);
    expect(() => assertPublicEndpointUrl("http://[::1]:8080/v1")).toThrow(/private/);
    expect(assertPublicEndpointUrl("http://[::ffff:8.8.8.8]:8080/v1")).toContain("::ffff:808:808");
  });
});

/**
 * The guard has to be able to make a request at all. On Node 26 an `Agent` from
 * undici 6 fails the handover to the global `fetch` with
 * `InvalidArgumentError: invalid onError method` before a socket opens, which
 * turned every guarded call — model listings and connection tests included — into
 * an opaque "fetch failed". This asserts the dispatcher dispatches.
 */
describe("publicOnlyFetch can actually dispatch", () => {
  /**
   * Opt in with OUTBOUND_LIVE=1. It reaches the network, so it stays out of the
   * default suite: a machine with no egress would fail `pnpm test` for a reason
   * that has nothing to do with the code. The private-address check below runs
   * everywhere, because it makes no request at all.
   */
  it.skipIf(process.env.OUTBOUND_LIVE !== "1")(
    "sends a real request through the guard and gets the origin's answer",
    async () => {
      const { publicOnlyFetch } = await import("../lib/outbound.ts");
      // `example.com` is IANA-reserved for documentation and always public.
      const response = await publicOnlyFetch("https://example.com/", {
        method: "GET",
        signal: AbortSignal.timeout(20_000),
      });
      expect(response.status).toBeGreaterThan(0);
      await response.body?.cancel().catch(() => undefined);
    },
    30_000,
  );

  it("still refuses a private destination before any request is made", async () => {
    const { publicOnlyFetch } = await import("../lib/outbound.ts");
    await expect(publicOnlyFetch("http://127.0.0.1:8080/v1/models")).rejects.toThrow(/public host/);
  });
});
