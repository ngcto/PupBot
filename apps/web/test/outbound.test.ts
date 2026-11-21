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
