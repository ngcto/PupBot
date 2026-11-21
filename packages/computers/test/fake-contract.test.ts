import { contractSuite } from "./contract-suite.ts";
import { FakeComputerProvider } from "../src/index.ts";

contractSuite("fake", async () => new FakeComputerProvider());
