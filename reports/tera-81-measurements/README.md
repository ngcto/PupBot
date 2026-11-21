# TERA-81 harness measurements

Every number in [`../TERA-81.md`](../TERA-81.md) marked "mine" came from these scripts. Nothing
here is used by the product; they exist so the report's numbers can be re-run rather than
believed.

Run from this directory with the repo's own tsx and node, with `ANTHROPIC_API_KEY` and
`ANTHROPIC_BASE_URL` set (crew machines have both).

## Token counts

    ../../node_modules/.bin/tsx measure2.mts   # fixed cost of each representation
    ../../node_modules/.bin/tsx measure3.mts   # cost of each result shape
    ../../node_modules/.bin/tsx measure4.mts   # codemode tool, with and without the index

Counts come from `POST /v1/messages/count_tokens` on `claude-sonnet-5-5` through whichever
endpoint `ANTHROPIC_BASE_URL` names. A different tokenizer moves these by a few percent, not by
the order of magnitude the report relies on.

`dump-index.mts` writes `index.json` from the CUA `tool-index.ts`, which lives in PR #38's
branch until it merges; a copy is committed here as `tool-index.ts` and is the input that
mattered. `decls.mts` renders pi-style TypeScript declarations for the 26 tools — the 3,984-token
number that argues against shipping declarations for the whole surface.

## Sandbox

    npm init -y && npm i quickjs-wasi@3.7.0
    node bench.mjs    # wasm compile, VM create, interrupt, capability surface
    node filter.mjs   # 10k-row filter inside the VM vs injecting the rows

`bench.mjs` and `filter.mjs` read `node_modules/quickjs-wasi/quickjs.wasm` from the current
directory.

## Image probe — the measurement that failed

    node image-probe.mjs   # needs /tmp/shot.png, /tmp/big2.png, /tmp/big1.png

This is the evidence for §1.3's claim that this endpoint cannot price an image honestly: image
blocks are accepted but their pixels are not forwarded, so the token deltas do not track image
size or content. Kept so the conclusion is checkable, not to be relied on for a budget.

## What the inputs are

- **Anthropic tools block 3,546** — `schemas.ts`, my rendering of the 26 typed signatures in
  `handoffs/ngs-79-cua-interface.md`. Representative, not byte-identical to what TERA-74 ships.
- **Index 1,200 / codemode 46 / with index 1,232** — the last two measured through a real
  `tools` block; the first as text, so the delta from 1,232 is wire overhead only.
- **294,592 for a 10,000-row table** — a plausible spread-of-a-sheet result, 1.18 MB as JSON.
- **31,921 for a screenshot** — a 95,728-byte capture (TERA-74's measured live size) as base64
  **text**, which is why the report labels it a text measurement.
