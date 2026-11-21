import { createComposioStubServer } from "./composio-stub.ts";

/**
 * The Composio stub runs as its own process so Playwright's webServer can wait for
 * it and the Next dev server can be handed its URL. Port 8799 is fixed because the
 * URL has to be known before either server starts.
 */
const PORT = Number(process.env.COMPOSIO_STUB_PORT ?? 8799);

const stub = createComposioStubServer();
const url = await stub.listen(PORT);
console.log(`composio-stub listening url=${url}`);

process.on("SIGTERM", () => {
  stub.server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  stub.server.close(() => process.exit(0));
});
