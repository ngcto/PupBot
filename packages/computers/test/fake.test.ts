import { describe, expect, it } from "vitest";
import { FakeComputerProvider } from "../src/index.ts";

describe("fake provider identity", () => {
  it("keeps a destroyed id destroyed even with adoption on", async () => {
    const fake = new FakeComputerProvider({ account: "a", adoptUnknownIds: true });
    const ref = await fake.provision();
    await fake.destroy(ref);

    await expect(fake.status(ref)).rejects.toMatchObject({ code: "not_found" });
    expect(fake.boxIds()).toHaveLength(0);
  });

  it("never hands out the same id twice, even from a second process", async () => {
    const one = new FakeComputerProvider({ account: "a" });
    const two = new FakeComputerProvider({ account: "a" });

    const ids = new Set([(await one.provision()).id, (await two.provision()).id, (await one.provision()).id]);

    expect(ids.size).toBe(3);
  });
});
