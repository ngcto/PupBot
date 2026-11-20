import { describe, expect, it } from "vitest";
import { ProviderError, StubComputerProvider } from "../src/index.ts";

describe("stub provider contract", () => {
  it("provisions a usable box and is idempotent on start", async () => {
    const provider = new StubComputerProvider();
    const ref = await provider.provision({ metadata: { botId: "bot-1" } });

    const first = await provider.start(ref);
    const second = await provider.start(ref);
    expect(first.ready).toBe(true);
    expect(second.ready).toBe(true);
  });

  it("treats sleep on a sleeping box as a no-op and destroy on a missing box as success", async () => {
    const provider = new StubComputerProvider();
    const ref = await provider.provision();

    await provider.sleep(ref);
    const again = await provider.sleep(ref);
    expect(again.state).toBe("sleeping");

    await provider.destroy(ref);
    await expect(provider.destroy(ref)).resolves.toBeUndefined();
  });

  it("returns a non-zero exec exit as a result, not an exception", async () => {
    const provider = new StubComputerProvider();
    const ref = await provider.provision();
    const result = await provider.exec(ref, "false");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("throws ProviderError for an unknown box", async () => {
    const provider = new StubComputerProvider();
    await expect(provider.status({ provider: "stub", account: "stub", id: "missing" })).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it("keeps files in the box and lists them", async () => {
    const provider = new StubComputerProvider();
    const ref = await provider.provision();
    await provider.putFile(ref, "/home/bot/notes.txt", "hello");
    const files = await provider.list(ref, "/home/bot");
    expect(files.map((file) => file.name)).toContain("notes.txt");
    expect(new TextDecoder().decode(await provider.getFile(ref, "/home/bot/notes.txt"))).toBe("hello");
  });
});
