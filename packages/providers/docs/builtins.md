# Built-in providers

A built-in is a provider whose base URL is fixed and known, so the user picks it from a
list and pastes a key. The URL lives in `src/builtins.ts` and nowhere else.

## The URL is server-only, by contract

**No built-in's base URL may reach the client.** Not in a rendered component, not in a
serialised prop, not in an action's return value, not in an API response.

This is a product promise, not a tidiness rule. The whole point of a built-in is that the
user never has to know the URL: they choose "OpenRouter", paste a key, and it works. A
leaked URL invites someone to paste it into a Custom endpoint, edit it, and quietly send
traffic somewhere OpenRouter is not — which is the exact failure the fixed table exists to
prevent. It also puts a URL we are responsible for into a payload we do not control, where
it can show up in devtools, in logs, and in anything that copies the page source.

Three places hold the line, in order of durability:

1. **`EndpointView.baseUrl` is `null` for a built-in.** `apps/web/lib/data.ts` sets
   `baseUrl: builtin ? null : row.baseUrl`, so the shape the client receives has no URL
   to leak. A custom endpoint still gets its own, because Settings has to identify it.
2. **The row's `kind` and `baseUrl` follow the table, not the stored row.**
   `endpointConfigForRow` is the only place a stored endpoint becomes a request config, so
   a hand-edited URL on a built-in's row cannot redirect its traffic.
3. **`apps/web/test/builtin-url-leak.test.ts` asserts it.** It calls `loadShellData` — the
   boundary both pages hand to client components — and checks that every endpoint with a
   `builtinId` has a null `baseUrl`, that no built-in's URL appears anywhere in the
   serialised payload, and that a custom endpoint's URL *is* still there. That last check
   is the control: a change that nulled every `baseUrl` fails instead of passing.

The test was verified by reverting the ternary in `data.ts` and confirming it fails with
`OpenRouter shipped its base URL to the client` while the control assertions stayed green.
If you change how endpoints reach the client, that test is what tells you the promise still
holds — and a failure means the boundary moved, not that the assertion is stale.

## Adding or fixing a provider

1. Read the base URL from the provider's own documentation, and record that page as
   `docsUrl` so the next person re-reads rather than trusts.
2. Probe it: `GET {baseUrl}/models` should answer, and a `chat/completions` call with a
   bad key should return the provider's own auth error. That is what distinguishes "this
   URL is wrong" from "this URL is a different version".
3. Add every header the documentation makes *necessary* to `headers`, and no others.
   OpenRouter's ranking headers are optional, so they are absent: a header we do not need
   is user data handed over for free. A header whose absence fails the request belongs
   here — OpenCode Go answers `400 MissingSessionID` without `x-opencode-session`.
4. If the id changes, saved rows keep the old one and become orphans. The id is stable for
   that reason; a rename is a migration, not an edit.
5. Add the row to `test/builtins.test.ts` and check the fixed-URL and header expectations
   still hold for every provider, not just the new one.

Probing with a real key is the one step nobody can currently automate: no key for any of
these four exists in this environment, so `pnpm --filter @terabot/providers smoke` reports
all four as fixture-only. A keyed call is the gap worth closing first when one becomes
available.
