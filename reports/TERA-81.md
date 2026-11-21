# Harness v2 research — code mode by default

**Thread** TERA-81 · **Issue** NGS-81 · **Date** 2026-11-21

The brief asked for `reports/TERA-76.md`; this thread's code is TERA-81 and the issue is
NGS-81, so the file is named after the thread. Say the word and I rename it.

This is phase 1: reading, measuring our own surface, and a design with its trade-offs. No
harness code is written yet.

**Corrections after review (2026-11-21):** three claims in the first draft were wrong and are
fixed in place rather than deleted, so the mistake stays visible. (a) The screenshot token
figure is a *text* measurement, and this endpoint cannot give an honest image measurement —
see §1.3. (b) `run_event.seq` cannot supply a retry-stable call identity; §7.6 defines one the
program supplies instead. (c) Program output must be a tool result, not a `message.completed` —
§Q4 item 3 explains what that would have broken. A fourth: I described a box-side vault fill as
"one crossing" when it is **two** (box→host request, then host→box to drive the driver), so the
box placement is justified by computer tools alone and a vault-heavy task is not the one it wins
— §7.7 states that plainly.

Every number below is labelled with who measured it — **mine** means I ran it in this thread on
this machine on 2026-11-21, and the command or script is reproducible from the notes in §1.2.

---

## 0. The short version

1. Our tool surface is 26 functions today and grows. As schemas it costs **3,546 tokens per
   request** (mine). As an index it costs **1,759** in full and **1,255** without result notes,
   as names only **81**, and a code-mode tool with a one-line description **46**.
2. The bigger number is not the schemas, it is results: a 10,000-row read is **294,592
   tokens** through the model and **149** filtered in code (mine). That ratio is the whole
   argument for code mode and it is about 2,000×, not 2×.
3. The right sandbox for us is **QuickJS compiled to WebAssembly, in a worker thread**, with
   the tool calls RPC'd to the real implementations. It is MIT, free, has no service, boots
   in **5.7 ms + 7.4 ms** (mine), and its capability surface is closed at the wasm imports —
   `setTimeout`, `fetch`, `process`, `require` and `WebAssembly` are all `undefined` inside
   (mine).
4. The one thing the research does **not** support for us is treating code mode as a pure
   win. It breaks three things we already built: resumability (our `run_event` log), per-call
   permission checks (our `abort_requested` poll), and honest result reporting (our CUA
   `effect` field). §6 is about paying for those.
5. Proposed architecture is in §7 and the interface TERA-74 needs to code against is in §7.4.

---

## 1. What I read, and what it actually claims

### 1.1 Sources

| Source | The claim I take from it | Whose number |
|---|---|---|
| Anthropic, *Code execution with MCP* ([link](https://www.anthropic.com/research/code-execution-with-mcp)) | Presenting MCP servers as a code API lets the agent load only the tools it needs and filter data in the execution environment. Their Google-Drive→Salesforce example holds the whole 2-hour transcript in code instead of passing it through the model twice. | Anthropic measured 150,000 → 2,000 tokens (**98.7%**) for tool-definition loading. |
| Cloudflare, *Code Mode* ([link](https://blog.cloudflare.com/code-mode/)) | Convert the tools to a TypeScript API and ask the model to write code that calls it. The stated reason agents handle more tools this way is training-set exposure: they have seen a lot of real TypeScript and very few contrived tool calls. | No hard token number; the claim is "agents handle many more tools, and more complex tools". |
| Claude Code, *Code Mode* docs ([link](https://code.claude.com/docs/en/code-mode)) | The limitations list is the useful part: resume works only with code mode on; auto-mode's classifier reviews the **code**, not each tool call; waiting code stops after **ten minutes**, background code runs up to **two hours**; hooks see code, and a tool call refused by a hook surfaces as a hook failure; computer use and Claude-in-Chrome are unavailable in code mode. | Anthropic, quoting their own product limits. |
| *The Harness Effect* ([link](https://arxiv.org/html/2607.06906v1)) | A controlled harness swap over 22 locked tasks and 6 models, changing only the orchestration layer: **−38% tokens** (14.2k→8.8k), **−41% cost** ($0.21→$0.12), **−44% median wall-clock** (48s→27s), quality a wash (0.78→0.81 at n=22). Six mechanism families: cache-shape discipline, structured compaction, context offload, zero-token waiting, failure-spend governance, a model-agnostic floor. | Writer, Inc., 2026. Their measurement, not mine. |
| Same paper, §4.3 | The concrete offload rules: shell output beyond **20K chars** is head-and-tail previewed with the full output in a workspace file *under a banner forbidding the model to infer success from the preview*; web fetches inline **8K chars**; oversized file reads are **rejected with guidance** rather than silently truncated. Compaction at **80%** of the input budget, folding a typed checkpoint forward, live tail of 4–12 messages ≤30% of budget. | Writer, Inc. |
| Same paper, §3 | Agent workloads are **input-dominated**; production agents report input:output near **100:1**, so the input term is nearly the whole bill. Cache reads price at roughly **0.1×** base. | Writer, Inc. citing their own production and provider pricing. |
| LangChain, *Anatomy of an Agent Harness* ([link](https://www.langchain.com/blog/the-anatomy-of-an-agent-harness)) | Names the primitives: filesystem for durable storage, bash/code as one general tool, sandboxes, and — for our problem — **compaction**, **tool-output offloading** (keep head and tail, full output on the filesystem), and **skills-style progressive disclosure** whose whole point is that tool/MCP front-matter loaded at start degrades performance before the agent begins. Also: changing only the harness moved their coding agent from outside the Top 30 to Top 5 on TerminalBench 2.0. | LangChain's own benchmark claim. |
| Phil Schmid, *The importance of Agent Harness in 2026* ([link](https://www.philschmid.de/agent-harness-2026)) | Model = CPU, context = RAM, harness = OS. The bitter-lesson test: build to delete. Manus refactored its harness five times in six months to remove assumptions. | No numbers of his own; synthesis. |
| Vercel, *We removed 80% of our agent's tools* ([link](https://vercel.com/blog/we-removed-80-percent-of-our-agents-tools)) | For a text-to-SQL agent, replacing ~16 specialised tools with one bash tool over a filesystem of well-documented files: **100% success vs 80%**, **274.8s → 77.4s**, **~102k → ~61k tokens**, **~12 → ~7 steps**, on 5 queries. | Vercel, n=5 queries. Small sample — treat as a direction, not a rate. |
| Anthropic, *Prompt caching* ([link](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)) | The cache covers `tools`, `system`, `messages` **in that order** up to the breakpoint; default lifetime **5 minutes**; Sonnet 5.5 base input $2/MTok, 5m cache write $2.50, 1h write $4, **cache read $0.10** — i.e. 0.05× base. | Anthropic pricing table. |
| pi, `packages/codemode` ([link](https://github.com/earendil-works/pi/blob/main/packages/codemode/README.md)) | QuickJS-in-WASM in a worker thread; the VM's only imports are a WASI shim (clock, random, discarded stdout) and one host-call entry. `tools.<name>`, `ALL_TOOLS`, `text()`, `image()`, `exit()`, `store()`/`load()`; nested calls never enter the model's context; a script waiting on a promise nothing can settle **fails immediately instead of hanging**; `// @options:` first line; measured **20 ms per execution including VM creation**; Cloudflare measurement: a script computing for **10 s** delayed every other request to the session object by the full 10 s when colocated, **~50 ms** when in a separate Worker. | pi's own measurements. |
| opencode, `packages/codemode` ([link](https://github.com/anomalyco/opencode/blob/dev/packages/codemode/README.md)) | A purpose-built interpreter for a JS subset instead of a sandboxed real engine: only implemented language features run, so there is no escape surface to audit. `UnsupportedSyntax` diagnostics carry a source location. `maxToolCalls`, hooks around every host call where a failing `before` denies the call, suspend/resume with a JSON snapshot, `Tool.idempotent` / `Tool.durable({start,wait,cancel})`. | No token claims; it is a design document. |

### 1.2 What I measured on our own surface

Scripts: **[`reports/tera-81-measurements/`](tera-81-measurements/)** in this repo, with a
README giving the exact commands, the committed inputs (`schemas.ts`, `tool-index.ts`,
`index.json`) and the node/tsx versions used. They read `ANTHROPIC_API_KEY` and
`ANTHROPIC_BASE_URL` from the environment; no key is in the tree. Re-run them rather than
trusting the tables: `tsx measure2.mts` reproduces the 3,546, `node bench.mjs` reproduces the sandbox numbers after
one `npm i quickjs-wasi@3.7.0`, and `node image-probe.mjs` reproduces the image measurement's
*failure*.

Token counts come from `POST /v1/messages/count_tokens` on `claude-sonnet-5-5` through our
configured Anthropic-compatible endpoint. They measure *the text*, so the number
for a tools block includes the wire-format JSON overhead of the schemas themselves. The 26
schemas are **my** rendering of the typed signatures in `handoffs/ngs-79-cua-interface.md`
(that package is not on `main` yet), so they are representative, not byte-identical to what
TERA-74 will ship. When `packages/cua` merges, `schemas.ts` should be replaced by a generator
that reads the real exports, and the numbers re-run — the delta is the check on how
representative they are.

**Fixed cost per request, by representation:**

| Representation | Tokens |
|---|---|
| 26 schemas, Anthropic `tools` block | **3,546** |
| 26 schemas, OpenAI chat `tools` block | 3,734 |
| 26 schemas, OpenAI Responses `tools` block | 3,650 |
| pi-style `declare const tools` TypeScript declarations | 3,984 |
| Tool index: name + description + `when[]` + cost, no result notes | **1,200** |
| Tool index: names only | **81** |
| One `codemode` tool, one-line description (in a real `tools` block) | **46** |
| One `codemode` tool + the index, no per-tool result notes | **1,255** |
| One `codemode` tool + the index, 10 load-bearing result notes | **1,584** |
| One `codemode` tool + the index, every result note (what `packages/tools` renders) | **1,759** |

**Variable cost, by result shape:**

| Result | Tokens |
|---|---|
| A 75-row accessibility tree, as JSON | **3,119** |
| The same tree, as `[token] role "label"` lines | **1,213** |
| A 10,000-row table as JSON (1.18 MB of characters) | **294,592** |
| That table filtered in code: "137 pending, here are 5" | **149** |
| A 95 KB screenshot as **base64 text** — not as an image block (see §1.3) | **31,921** |

**Sandbox cost, `quickjs-wasi@3.7.0`:**

| Measurement | Result |
|---|---|
| WASM binary size | 638,148 bytes |
| `WebAssembly.compile` once | **5.7 ms** |
| `QuickJS.create()` from a compiled module | **7.4 ms** average of 5 |
| Trivial async script, create→result | 3.5 ms |
| Filter + sort 10,000 rows already in the VM, return 2 fields | **8.2 ms** |
| Handing the same 10,000 rows into the VM (`hostToHandle`) | 136 ms once |
| `interruptHandler` stops `while(true){}` | **49 ms**, 637 handler invocations |
| `typeof setTimeout / fetch / process / require / WebAssembly` inside | `undefined × 5` |

### 1.3 What these numbers mean for us, stated plainly

- **The tool wall is real but modest.** 3,546 tokens is 1.4% of a 256k window. It is not a
  reason to panic; it *is* a reason not to grow the surface, because the CUA set alone is 26
  and the product will add vault, GitHub, Composio and whatever else — Anthropic's example is
  "thousands of tools", and the growth is the problem, not today's number.
- **The result wall is not modest.** 294,592 tokens is more than a context window. One
  unfiltered spreadsheet read is a failed run. Code mode is the only mechanism in the reading
  that addresses it structurally rather than by truncation.
- **Tree-vs-JSON is a free 2.6× on the most frequent call we make.** The 75-row tree costs
  3,119 tokens as JSON and 1,213 as text lines. We already have the text form
  (`observeWindow`'s compact outline); the harness must not re-JSON it.
- **Images are the most expensive thing we can return, but not by the number in that table.**
  The 31,921 is a 95 KB capture expressed as **base64 text** — what happens if a screenshot is
  ever JSON-stringified into a result. It is not the cost of *sending an image*, and I could not
  measure that cost honestly on this endpoint: a real `{type:"image"}` block for a 9.8 KB PNG
  priced at 128–305 input tokens; a 1.4 MB PNG and a 6.2 MB PNG both priced at the same 128;
  and asked to describe a flat two-tone UI mock I generated, the model answered "a green parrot
  perched on a branch". The endpoint accepts image blocks without appearing to forward their
  pixels, so **any pixel-level token number from this machine would be fabricated.** Treat the
  image budget in §7.1 as a conservative cap from provider pricing, not a measurement, until it
  is measured against a real vision path. What *is* measured and load-bearing: never let image
  bytes travel in a text field, because that path is 31,921 tokens for one capture.

---

## 2. Mechanisms that measurably cut tokens and turns

Ordered by how much of *our* bill they touch, with the mechanism stated so it can be built.

**M1 — One primary tool that runs code, and results filtered in code.**
The mechanism: the model's output is a program; tool calls inside it are RPC to the real
implementation; only what the program `text()`s or returns enters the context. Anthropic's
claim is 150k→2k for definitions and "the agent sees five rows instead of 10,000" for results;
mine on our shapes is 294,592→149 for a table. This is the only mechanism with a
thousand-fold on our largest result class.

**M2 — Progressive disclosure: a searchable index, not a wall.**
Mechanism: the request carries a capability index (name, situation phrases, cost) and the
model asks for signatures only when it needs them. Anthropic describe a `detail` parameter on
`search_tools` (name-only / name+description / full definition); LangChain call the same thing
skills-style progressive disclosure and say the point is that upfront front-matter degrades
performance before the agent starts. On our surface: 3,546 → 46 (bare) or 1,759 (with the full
index inline), i.e. a 2× to 77× reduction in the fixed term — and the index is where the
situations live, which is what makes discovery work at all.

**M3 — Cache-shape discipline.**
Mechanism: a byte-stable prefix (tools, then system, then the append-only transcript) with
breakpoints placed on it, and everything that changes per turn confined to a volatile tail
that is structurally banned from the prefix. Writer measured 99.9% of prompt tokens served as
cache reads (7,876 of 7,886). With Anthropic's table a cached read is 0.05× base for Sonnet
5.5, so the fixed term becomes nearly free *in money* — which is why M3 and M2 are not
substitutes: M2 reduces the tokens the model must attend to, M3 reduces what you pay for the
tokens you keep. The 5-minute default TTL matters to us specifically: our slowest tool call is
~0.5 s and a 24-call computer task is ~12 s of tool time, so a run that pauses for a human, or
a box that takes 30 s to wake, can fall out of cache between turns. 1-hour writes cost 2× base
on Sonnet 5.5, so latching a 1-hour policy per conversation is only worth it for long ones.

**M4 — Spill bulky output to a file with head/tail preview and a pointer.**
Mechanism: above a character cap, the harness returns head + tail + a file pointer in the
workspace, and the preview carries a banner forbidding the model to infer success from it.
Writer's caps: 20K chars for shell output, 8K inline for web fetches, and oversized file reads
*rejected with guidance* rather than truncated. LangChain describe the same head/tail
mechanism. Our translation: CUA tree reads above ~8K characters spill, screenshots never
inline more than one, and any tool result over the cap returns a pointer the program can
re-read in code.

**M5 — Compaction with a typed checkpoint, co-designed with the cache.**
Mechanism: at a budget fraction, fold old history into a durable checkpoint (decisions,
constraints, rejected approaches, current state, next steps, verbatim user requirements), keep
a live tail verbatim, fold the *previous* checkpoint forward so cost stays incremental, run the
summariser on a cheaper model, and abort the compaction rather than persisting a degraded
summary. It is what turns the quadratic transcript term linear: Writer's Eq. 3 is
`Σ T_in ≈ kS + k(k−1)/2·m̄ + kḠ + Σ R`, so full replay is O(k²) and harness-managed context is
O(k).

**M6 — Bounded execution as a token mechanism, not just a safety one.**
Mechanism: wall-clock cap, call cap, and a typed error the model can recover from — plus a
circuit breaker on byte-identical repeated calls. Writer cap the loop at 50 iterations and
tool parallelism at 4 and call re-issuing a byte-identical failing tool call three times a
stop condition. opencode's `maxToolCalls` is the same idea inside the program. A flailing run
is a token multiplier that no per-token discount fixes.

**M7 — Fewer tools is itself an accuracy mechanism.**
Cloudflare's explanation is that models have seen far more real code than contrived tool
calls; Vercel's measurement is that deleting 80% of a toolset improved success 80%→100% and
cut steps ~42% (n=5). For us the actionable version is narrower: **one tool that runs code**
instead of 26 that must each be chosen, and the index ordered by situation ("the page is gated
and clicks do nothing") rather than by verb.

---

## 3. Which mechanisms do not transfer to a product harness, and why

- **"Just give it bash and a filesystem" (Vercel, LangChain).** Their agent's data was already
  well-documented files on a filesystem it owned. A consumer product's bot has no repository
  and no bash; its capabilities are a computer, a browser and a vault behind typed functions.
  Copying the *conclusion* ("delete tools") without the *precondition* ("the data layer is
  already legible as files") gives you a bot that cannot do anything. We copy the mechanism
  (one general entry point) and keep the typed functions behind it.
- **Filesystem-as-memory for context.** For a coding agent the filesystem is the work product
  and the memory. For us the workspace is the bot's box, which is per-bot and ephemeral from
  the product's point of view; a spill file there is not durable across a box reimage. Our
  spill target should be our own storage behind a `read_file`-shaped tool, so a pointer
  survives the box.
- **Sub-agents as context firewalls.** Writer cap a child's return at 8 KB and cite as their
  win; they also measured Anthropic's own result that multi-agent systems consume ~15× the
  tokens of chat, with token volume explaining ~80% of performance variance. That is a
  capability buy at a token premium. It is not the lever we need first, and for a product
  whose runs are short it is mostly overhead. Deferred.
- **Zero-token waiting.** Writer suspend durably at zero cost and resume on an ingress event.
  Correct for an enterprise runtime with a queue; ours already has pg-boss and a `run` row, so
  the mechanism is available — but our tools are *synchronous and slow* (0.5 s exec round
  trip), not *long-running background jobs*, so the win is small next to the cost of building
  resumable execution. Deferred; see §6.3.
- **Claude Code's ten-minute code cap, as-is.** That cap exists because a human is watching a
  terminal and can press Esc. Our run is an HTTP request with a `maxDuration` and a client
  that reconnects to `run_event`. A ten-minute in-request code execution is a dead request.
  Our cap must be derived from the request budget, not copied.
- **Token-level prompt compression.** Out of scope: it is a per-call technique, not an
  orchestration one, and it fights the cache.

---

## 4. What pi and opencode do that we should copy, and what we should not

### pi (`earendil-works/pi/packages/codemode`)

**Copy:**
- **The VM choice**: QuickJS compiled to WebAssembly, one fresh instance per execution, whose
  only imports are a WASI shim and one host-call entry. My measurement confirms the sealed
  surface: no timers, no `fetch`, no `process`, no `require`, no `WebAssembly` inside.
- **Nested calls never enter the model's context.** Only `text()`/`image()` output and the
  return value do. This is the property the whole design rests on, and it must be stated in
  the type of the result, not just in the implementation.
- **The hang failure mode**: "a script that waits on a promise nothing can settle (no tool
  call pending, and the VM has no timers or I/O) fails right away instead of hanging." For a
  product this is worth more than the timeout — a hang looks like "the bot froze", a fast
  error looks like "the bot made a mistake".
- **`renderDeclarations()`**: turn schemas into TypeScript for the description. My measurement
  is the caution: the pi-style declarations for our 26 tools cost **3,984 tokens**, *more*
  than the raw schemas (3,546). Rendering declarations is right for the tools you have loaded,
  not for the whole surface — so we render them per-capability, on demand, not up front.
- **The store contract**: the sandbox persists nothing; the host passes values in and receives
  `storeWrites` back. That is exactly the shape our event log needs (§6.4).
- **Deterministic `start()`** with a seeded clock and random, applied results in order. This is
  the mechanism that makes a resumed program actually resume rather than diverge.
- **The bundled-host caveat**: a bundler removes the wasm file and the worker file, so both
  must be passed explicitly (`wasm`, `workerUrl`). We build with Turborepo and deploy to
  Vercel; we will hit this on the first deploy, not in tests.

**Do not copy:**
- **Its Cloudflare placement.** They push the VM into a separate Worker because QuickJS runs
  synchronously and their measurement is that a 10 s synchronous script delayed every other
  request to the same object by 10 s. On Cloudflare that is a platform constraint. Ours is not
  Cloudflare, but the lesson transfers as a *placement rule*: **never run the VM on the thread
  that serves the run**. A worker thread per execution, which is pi's own Node answer, is the
  right shape for us.
- **`@earendil-works/pi-codemode` as a dependency.** We do not vendor another agent's package
  (CREW: own harness, no vendored forks). We depend on `quickjs-wasi`, which is the engine, and
  write the ~200-line prelude and host bridge ourselves. That keeps the blast radius of a
  dependency small and makes the tool-loop contract ours.
- **`InlineCodemodeSandbox`** on the calling thread, except as a test double.

### opencode (`anomalyco/opencode/packages/codemode`)

**Copy:**
- **`maxToolCalls` as a first-class limit**, counted in the run's metadata so a resumed run
  keeps it. A cap is a token mechanism (§M6), and it belongs to the execution, not to the
  prompt.
- **Hooks around every host call where a failing `before` denies it.** `tool.before` sees
  `{name, input, key}` *before* the host function is called, and a throw denies the call, with
  the program catching it as a thrown error. This is how we enforce per-call policy without
  the sandbox knowing about policy — and it is how we keep our `abort_requested` semantics
  (§6.2).
- **Diagnostics with a source location.** `UnsupportedSyntax` carries where. A model that gets
  "line 4: not supported" corrects itself; one that gets "execution failed" flails.
- **REPL-style result**: no `return` means the last top-level expression is the result;
  `undefined` becomes `null`. Cheap, and it removes a common model mistake.
- **Argument marshalling rules stated explicitly** (a `Date` becomes its ISO string, a `Set`
  its items, `Map`/`RegExp` become `{}`, and a promise or function inside an argument fails
  the call). We want these *documented in the tool description* so the model does not have to
  discover them.
- **A stable identity per call**, passed to every tool. opencode use `<runId>:<callId>`.
  **`run_event.seq` cannot supply ours**: `EventLog.primeFromDatabase()` continues from the last
  saved event, so re-running the same program gives the same action a *new* seq, and matching
  by position breaks as soon as the model rewrites the program. The identity must come from the
  program, not the log — §7.6.

**Do not copy:**
- **The interpreter.** Implementation effort aside, the product risk is the subset. Our models
  will write `map`/`filter`/`??=`/optional chaining and template literals, and every
  unsupported construct is a failed run that reads as "the bot is dumb". QuickJS runs real
  JavaScript, so the model is never wrong about the language. opencode's own README says the
  point of the subset is that "there is no escape surface to audit" — but we get the same
  property from wasm imports, with real JS semantics.
- **Effect as the host abstraction.** Our repo is Drizzle + Hono + plain async. Taking
  `@opencode/codemode` would bring an Effect runtime into the agent package to get suspend/
  resume, which is a large dependency for one feature.
- **Suspend/resume for our current runs.** See §6.3; it is the right mechanism for the wrong
  layer of our stack today.

### The four questions, answered

#### Q1 — Real JS engine, or our own interpreter?

**Real JS engine: QuickJS via `quickjs-wasi`, MIT, no service.** Reasons, in order of weight:

1. **The model cannot be wrong about the language.** With a subset, a `??=` or a `for…of` over
   a `Map` is a failed run; with QuickJS it is fine. Our models are consumer-grade and will be
   swapped (BYO endpoint — CREW), so we must not depend on a model that guesses our dialect.
2. **The escape surface is closed at the wasm boundary, not at our parser.** My measurement:
   `setTimeout`, `fetch`, `process`, `require`, `WebAssembly` are all `undefined`. Everything
   else is what we register.
3. **Bundle and cold start are trivial.** 638 KB wasm, 5.7 ms to compile once, 7.4 ms to create
   a VM (mine). pi independently measure ~20 ms per execution *including* VM creation.
4. **`maxToolCalls` and timeouts do not need the interpreter.** Both are host-side: the call
   count is ours to enforce in `call()`, and the deadline is a `setTimeout` plus
   `interruptHandler`, which I measured stopping a tight loop in 49 ms.

The cost we accept: QuickJS is an interpreter, not a JIT. Glue code and filtering are fast
enough (pi say so explicitly); heavy computation is slower than V8. For "filter 10,000 rows
and print five" that is irrelevant — the sort took milliseconds in my measurement of an
equivalent loop.

#### Q2 — Where does the sandbox actually run?

**Default: in our process, in a worker thread. For a run whose tool set is the bot's computer,
the same VM runs on the bot's box, next to the driver daemon.** §7.0 states the scope of the
argument that justifies this, and its limits. Read that first.

The number that decides this is TERA-74's, measured on a live box: **an in-box call costs
~10 ms; an exec round trip costs ~0.5 s.** The daemon owns the session, so a call is local
either way — what differs is the hop between our process and the box. A 20-call program is
then **~0.2 s** in the box versus **~10 s** from our process, and 10 s is not an abstract cost:
it is 10 s of a request's `maxDuration` and 10 s of a person watching a spinner.

What each placement costs:

| Placement | Tool latency | Blast radius if the sandbox is escaped | What breaks |
|---|---|---|---|
| In our process, worker thread | 0.5 s/call for CUA, ~ms for our own tools | **our server**: every tenant's data | synchronous scripts must never run on the request thread (pi: a 10 s script delayed every other request by 10 s when colocated) |
| On the bot's box, next to the daemon | ~10 ms/call for CUA | **that bot's box only** — one bot per box, its own workspace, its own X session | needs a runner on the box; the box must be awake before code can start; a Vault secret must not live on the box |
| Separate runner service | either | one bot | a service to pay for and operate — **out of scope, free plan only** |

Reading the table honestly: **running the program in the box is the safer placement, not the
riskier one.** The wasm VM has no ambient capability in either location, so the difference is
only what an escape would reach — and "the bot's own box" is a materially smaller blast radius
than "our multi-tenant server process". The reason not to make it the only placement is that
most of our tools are *not* the box's: messages, vault entries, storage and the model itself
are ours, and a program in the box would need a network path back to us, which is precisely
the ambient capability the sandbox exists to deny.

So the rule is: **the sandbox goes where the tools are.** A computer task's tool set is the
CUA functions, so the VM goes to the box. A chat-with-a-tool task's tool set is ours, so the
VM stays in our process. One script API, one result shape, two placements — which is exactly
the pattern pi uses for Node vs Cloudflare (three sandbox classes, one API, one environment,
one result type).

Consequences to design for now, because they are cheap now and expensive later:
- The prelude and result format must be **identical** across placements, so a script written
  for one runs on the other.
- A tool call is **`call(name, args)` over a transport**: a worker postMessage in-process, the
  driver socket on the box. Nothing else in the loop may assume which.
- Vault and storage tools are **host-side only**. If a program running in the box asks for
  `vault.get`, the answer is a typed refusal, not a proxy. The vault never becomes reachable
  from the box.

#### Q3 — Do we need suspend/resume?

**Not in phase 2, and the reason is specific.** Suspend/resume exists to survive two things:
a long tool call that outlives the process, and a wait on a human or an ingress event. Our
current run is an HTTP request that already keeps its progress in `run_event`, and our abort is
a poll of `run.abort_requested` that cancels the in-flight HTTP stream — a mechanism that
already gives us "interruptible runs" as CREW requires. What suspend/resume would *add* is
survival across a process death mid-program, and our worst case there is one code execution of
seconds, not a 40-turn run.

What we do need instead, and what I would build:
- **A wall-clock cap derived from the request budget** (§M6), so a program cannot outlive the
  response.
- **A typed `timeout` error** the model can recover from by writing a smaller program, and the
  partial output, which pi and opencode both keep.
- **Idempotency keys on every call** (`<runId>:<callIndex>`), so that when we *do* add resume
  the tools are already safe to re-run, and a retried run does not double-click a button.

The failure it prevents when we skip it: a program that dies mid-way after three of five side
effects has no record. Mitigation without a full resume: every call is appended to
`run_event` as it happens (§6.4), so the loop can tell the model "these three calls completed,
this one did not" in the *next* turn. That is cheaper than a snapshot and it is enough for
short programs. This is the one place I disagree with the opencode design for our stack: their
snapshot solves a problem our event log already solves at a coarser granularity.

#### Q4 — How do `store`/`load` and durable tools change our event shape?

I read `packages/agent/src/run.ts` and `apps/api/src/routes/runs.ts` before answering. The
current contract is precise and I will not break it: `EventLog` appends a monotonic `seq` per
run, `run.completed` and `message.completed` are written **before** the terminal run row
("a client that sees a terminal status is guaranteed to find `message.completed` and
`run.completed` already in the log"), and the SSE route replays `where seq > cursor` and stops
only when the status is terminal *and* no rows remain.

Changes, and what each costs:

1. **New event types, not new tables.** `tool.call` (`{callId, name, argsDigest, ok, effect?}`)
   and `tool.result` (`{callId, preview, spilled?}`) appended through the same `EventLog`. A
   client that does not know them ignores them; the replay invariant is unchanged because
   they are just more rows before `message.completed`.
2. **The sandbox's `store` becomes a column, not a file.** pi's contract is the one to copy:
   the host passes the store in and receives `storeWrites` back, and a failed execution reports
   **no writes**. In our shape that is a `run.output` JSON column written only on a successful
   program, plus a `conversation.state` column that survives the turn. The reason not to put it
   on the box's filesystem is §3: the box is per-bot and reimageable.
3. **A successful program's output is a tool result, never a `message.completed`.** This is a
   correction to an earlier draft of this report, which had it wrong and would have broken two
   things: `packages/api-client/src/reducers.ts` turns `message.completed` into a
   `role: "assistant"` chat message, so it would render as the bot's answer; and
   `buildChatContext` replays saved assistant messages back to the model as its own prior
   turns. Program output is model-facing evidence, so it belongs exactly where a tool result
   goes today: a `tool` message in the conversation and a `tool_call` event in the log. The
   user-facing message stays the model's own answer, written after it has read the result. The
   one-line call records stay in the log for the UI's activity row; they are never message
   parts, or a 20-call program becomes a 20-bubble message.
4. **Durable tools do not change the shape yet, because we have none.** `runSteps` is one fast
   call; the slow thing is a box that takes seconds to wake, which is a tool call that blocks,
   not a job that outlives the request. When a genuinely long tool appears (a CAPTCHA solver
   round trip already takes seconds), the pattern is pg-boss plus a `tool.call`
   `{state:"pending"}` — and the event shape above already allows it, because a pending call is
   a logged state rather than a suspended VM.
5. **The abort path needs one new check.** Today `abort_requested` aborts the model stream. With
   a program running, the same poll must also abort the *sandbox* and the in-flight tool call,
   or a user's "new message" leaves a program clicking buttons. The opencode `tool.before` hook
   is the right place: it runs before every host call, so the check is one flag read per call.

---

## 5. What still surprises me in the sources

Two things, both worth building for:

- **Anthropic's 150k→2k is about definitions, and it is not our ratio.** We are 3,546→47 on a
  surface of 26. Our real ratio is on results (294,592→149), which Anthropic also mention but
  do not headline. Anyone quoting "98.7% fewer tokens" at us is quoting a case we are not in.
- **The three sources disagree about whether a big toolset is the problem.** Cloudflare say
  models handle *more* tools in code form; Vercel say delete 80% of your tools and get
  *better*; Anthropic say present them as a filesystem. The reconciliation that matters to us:
  code mode makes a large surface *usable*, and the index makes it *findable*, but neither
  makes a **badly factored** tool good. `runSteps` (one call for N actions) is a better tool
  than `click`, and no harness fixes a `click`-only surface.

---

## 6. What breaks, and what we pay

Code mode is not free. From Claude Code's own limitations list plus our shape:

1. **Resumability.** Their resume requires code mode on. Ours: the `run_event` log is per-call
   and replayable, so a replay after a restart shows the program's output and its calls, but
   the VM is not restored. A program that was half-way through is re-run from the top by the
   next turn's model, which is why every call needs an idempotency key (§Q3).
2. **Per-call permission checks.** Their auto-mode classifier reviews the code, not each call,
   and does not see values computed at run time — "a path taken from search output" is
   invisible to it. Our version is worse in one way: the model's program can compute a target
   from a tool result and click it. That is precisely what the CUA `effect` ladder exists to
   catch, so the mitigation is not a classifier; it is (a) the typed `effect` never being
   flattened to a boolean (§7.3), and (b) vault-side capabilities being host-checked per call
   in `tool.before`.
3. **Long-running code.** Their waiting path stops at ten minutes and their background path
   runs two hours. Ours has a request budget; the cap must be the budget minus the model time.
   A synchronous script blocks its thread (pi's Cloudflare measurement: 10 s of synchronous
   compute delayed every other request to the object by 10 s), so the VM runs in a worker and
   never on the request thread.
4. **Hooks see code, not calls.** Their `PreToolUse` hook fires under the tool's usual name, but
   `Bash` rules see `cd 'app' && git push`. For us: our loop's policy hooks must be **inside**
   the call bridge (`tool.before`), not in a pre-execution hook on the code string. A hook on
   the code string can only pattern-match prose.
5. **Feature loss.** Their computer use and Chrome extension are unavailable in code mode. Ours
   is the opposite — computer use is the *reason* we need code mode, because 20 calls at 0.5 s
   each is 10 s of turns in the old shape. But it means our code-mode path must be the supported
   path for computer tasks, not a variant.

---

## 7. Proposed architecture

### 7.0 Placement: the box is justified by computer tools alone

Read this before quoting any latency number at someone: **the case for running a program on the
bot's box is the CUA call rate, and nothing else.** It is not a general-purpose fast path, and a
task that is mostly vault fills is *not* the task the box placement wins.

The number, and its exact scope:

- In-box CUA call ≈ **10 ms**; the same call over exec ≈ **0.5 s** (TERA-74, measured on a live
  box). A program making ~20 observation and click calls is therefore **~0.2 s** in the box
  against **~10 s** from our process. That is the whole argument, and it applies only to tools
  that live on the box.
- A **vault fill is two crossings** from a box-side program — box→host for the request, then
  host→box to drive the driver to type — against **one** exec if the program runs host-side. The
  fill has to be applied by whatever holds the credential, so it cannot be local to the box.
- Every host-side tool (storage, messages, our own data) is a crossing *or* a refusal when the
  program is in the box, depending on whether that tool is allowed to be reached.

So the rule is stated as a rule, not as an optimisation: **the sandbox goes where the tools are.**
A computer task's tool set is the CUA functions, so the VM goes to the box. A task whose tools are
ours stays in our process. If the tool set is mixed, in-process is the default and the box is
chosen only when the CUA calls dominate — which is measurable per task with the call counts the
sandbox already returns.

An earlier revision of this report described a box-side fill as "one crossing" and let the
0.2 s-versus-10 s figure imply general placement advice. Both were wrong. If this page is ever
cited to justify running everything on the box, it is being cited against itself.

### 7.1 Shape

```
model ──1 tool──▶ codemode({ code })  ──▶ Sandbox (QuickJS/wasm, worker thread)
                                              │  tools.<name>(args)  ── host bridge ──▶ ToolRuntime
                                              │                                          ├─ CUA (socket/exec)
                                              │                                          ├─ vault, storage, messages
                                              │                                          └─ vision, files
                                              ▼
                                     text()/return ──▶ one message, one event
```

- **One primary tool** `codemode({ code })`, **46** tokens.
- **The index travels with it**, at 1,759 tokens, because a model that has to make a discovery
  call before it can act pays a turn for it. 1,759 cached tokens (≈176 token-equivalents at
  Sonnet 5.5 cache-read pricing) is cheaper than one extra turn. **This is a deliberate
  departure from "47 tokens"** and the reason is the turn, not the token.
  *Measured:* index inline **1,759** vs bare **46**, with the breakdown of what the notes cost —
  **504** tokens for every `resultNote`, **1,584** for the ten that prevent a wrong action, **1,255**
  for none. Kept in full, because a note that stops one wrong click is worth more than the ~25
  token-equivalents it costs at cache-read pricing. *Cheaper than:* one round trip, which costs the
  whole replayed prefix again.
- **Signatures on demand**: a `describe(names)` capability that returns pi-style declarations
  for the 2–5 tools a program actually wants, rendered per-capability rather than for all 26
  (my measurement: all 26 as declarations is 3,984 tokens, *worse* than raw schemas).
- **Progressive disclosure by capability**, using TERA-74's `when[]` situation phrases rather
  than verbs, because that is how the model describes being stuck.
- **Caps**: wall clock from the request budget; call cap 24 per program (TERA-74's suggested
  per-run number); output cap 16 KB of text with spill; 1 screenshot per program; heap cap
  32 MiB; concurrency 4 inside a program.
- **Cache layout**: `[tools codemode+index][stable system prompt][append-only transcript]` as a
  byte-stable prefix with a breakpoint after each, then a volatile tail (clock, box state, plan)
  rebuilt per turn and structurally excluded from the prefix.

### 7.1a One measurement that changes the tool contract

Handing a 1.18 MB result *into* the VM costs **136 ms** (mine, `hostToHandle` + `setProp`),
while filtering it once inside costs **8.2 ms**. So a 10,000-row read is cheap to filter but not
free to inject, and the cost lands on the host before any code runs. Two consequences:

- **Large results cross as a pointer, not as data.** Above ~256 KB the bridge returns
  `{ spilled: true, pointer: "..." , head, tail }` and the program re-reads through a
  `read_result(pointer, query)` tool that the *host* evaluates. The VM only ever holds the
  slice the program asked for. This is cheaper than one injection and it doubles as the spill
  mechanism from §M4, so it is one mechanism, not two.
- **Below that, inject directly.** 136 ms once is not worth a round trip; a 1.18 MB table is
  far past the size where anything else would be cheaper either.

### 7.2 The two-zone prompt, concretely

```
zone 1 (cached, byte-stable):
  tools:   codemode(code) + the 1,759-token capability index      ← breakpoint 1
  system:  bot instructions + harness rules + result-reading rules  ← breakpoint 2
  history: append-only, tool calls as one-line records              ← breakpoint 3 (sliding)
zone 2 (rebuilt every turn, never cached):
  clock · box state (awake/asleep, window count) · remaining call budget · one-shot reminders
```

Rule enforced in code, not by convention: nothing in zone 2 may be serialised before a
breakpoint, and the loop refuses to place a breakpoint at or after the first volatile message.

### 7.3 How a program branches on `effect`, and why the harness must not flatten it

TERA-74's contract is that `ok` is **false** for `unverifiable`, `stale_element_token` carries
**no** escalation, and `refusal` is never success. A code-mode harness that returns
`{ok:true}` to the program throws all three away. The rule:

- `tools.click(...)` resolves to the **whole** `CuaActionResult`. The program branches on
  `effect` and reads `escalation.recommended`. That is the point of code mode: the branching
  happens in code, at 10 ms per decision, instead of in a model turn.
- The harness adds **no** `ok` convenience field and no boolean coercion. It may add a helper
  *in the prelude* — `retryForeground(fn)` that re-runs one action with `delivery:"foreground"`
  when `escalation.recommended === "foreground"`, and a `reobserve()`-on-`stale_element_token`
  helper — because those two moves are mechanical and repeating them in every program wastes
  the model's attention.
- The result the model reads when the program ends must state what was *confirmed* versus
  merely *delivered*, because the model writes the sentence the user reads.

### 7.4 The loop interface — for TERA-74, so we do not build two loops

```ts
// packages/agent/src/tools.ts  (the harness side; TERA-74's functions sit behind it)

/** What the model can discover. No JSON Schema here — that is `describe`. */
export interface ToolDescriptor {
  name: string;                 // identifier form: tools.observeWindow
  description: string;          // one line
  when?: string[];              // situation phrases, from the CUA index
  cost?: "cheap" | "moderate" | "expensive";
  signatures?: string;          // TypeScript declarations, rendered on demand
}

export interface CallContext {
  runId: string;
  /** `<runId>:<callIndex>`, stable across retries: the idempotency key. */
  key: string;
  signal: AbortSignal;
  /** Calls left in this execution's budget. */
  remaining: number;
}

export type ToolOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: ToolFailure };

export interface ToolFailure {
  kind: "refused" | "unavailable_here" | "unconfirmed" | "failed" | "invalid_input" | "limit" | "timeout";
  message: string;
  /** Model-facing recovery advice: "observe again", "use delivery:'foreground'". */
  hint?: string;
  /** The tool's own result, unflattened: CUA `effect`, `escalation`, `refusal`. */
  detail?: unknown;
}

export interface ToolRuntime {
  /** The index, for the prompt and for search. */
  list(): ToolDescriptor[];
  search(query: string): ToolDescriptor[];
  /** Declarations for named tools, for the `describe` capability. */
  declarations(names: string[]): string;
  call(name: string, args: Record<string, unknown>, ctx: CallContext): Promise<ToolOutcome>;
}

/** One code execution. Same API in-process and on the box. */
export interface Sandbox {
  run(code: string, opts: RunOptions): Promise<SandboxResult>;
  close(): Promise<void>;
}
export interface RunOptions {
  signal: AbortSignal;
  tools: ToolRuntime;
  timeoutMs: number;
  maxToolCalls: number;
  maxOutputChars: number;
  heapBytes: number;
  store: Record<string, unknown>;
}
export type SandboxResult =
  | { ok: true; output: OutputItem[]; value: unknown; calls: CallRecord[]; storeWrites: StoreWrites }
  | { ok: false; error: SandboxError; output: OutputItem[]; calls: CallRecord[]; storeWrites: null };
export type SandboxError = {
  kind: "script" | "timeout" | "aborted" | "limit" | "sandbox";
  message: string;
  line?: number;          // from QuickJS frames, so the model can correct itself
  stack?: string;
};
```

Two decisions in that interface worth flagging:

- **`call()` is the only enforcement point.** Every cap — call count, deadline, policy, the
  abort flag — is checked in `call()` (the opencode `tool.before` idea), so the sandbox holds
  no policy and policy cannot be bypassed by a clever program.
- **`storeWrites: null` on failure**, so a failed program cannot persist half a thought.

### 7.6 Call identity, since the event log cannot supply it

The promise "idempotency keys stop a double-click" is only worth making if the key is stable
across a retry, and `run_event.seq` is not: `EventLog.primeFromDatabase()` seeds the counter
from the last saved row, so a re-run mints new sequence numbers for the same actions. The key
must therefore be derived from something the *model* controls:

- **The program names its side effects.** Tools with observable effects on the world —
  `click`, `typeText`, `setValue`, `runSteps`, `browserClick`, `browserType`, `vault_fill`,
  `vault_totp` — take an explicit `idempotencyKey` string the program supplies, and the host
  refuses a second call with a key it has already executed in this conversation, returning the
  first call's saved result and `status: "duplicate"` instead of acting again.
- **The prelude can supply one for the common case.** `withKey(name, fn)` derives
  `sha256(conversationId + name + JSON(args))`, so `tools.click(args)` called twice with the
  same arguments in the same conversation is refused the second time without the model having
  to think about it, and a program that means to click twice in the same place passes
  `{ again: 2 }` or its own key.
- **An uncertain outcome is not a success.** This is the CUA ladder again: a call that ended
  `unverifiable` may or may not have landed, so a retry with the same key returns the first
  result *plus* `uncertainCarriedForward: true` and the harness tells the model to re-observe
  rather than to re-click. A `confirmed` call replays its saved result verbatim; a `refused`
  call is re-run because nothing happened.
- **Keys are scoped to the conversation, not the run**, because the double-click we must
  prevent is the one across a retried run — a fresh run id would otherwise hand out a fresh
  key set and re-click the button.

### 7.7 Secret fill across the sandbox boundary

Three questions, answered from the code rather than from the design intent. The wiring is
`apps/api/src/vault-tools.ts` → `vaultTools({sink})` → the `VAULT_FILL` handler in
`packages/vault/src/tools-run.ts` → `fillFromVault` → `sink.fill({value})`.

**1. Where the decrypted value goes: into a host process, never into the VM.** The whole
sequence runs inside a `RunTool.handler`, which is host code: `fillFromVault` calls
`vault.reveal()`, gets the plaintext, and hands it straight to `request.sink.fill({value})`.
The handler's *return* is `filled.message` — one sentence built from `FillResult`, whose fields
are an item id, a field name, a length and a host. So under code mode `tools.vault_fill(...)` is
an RPC to that same host handler and only the sentence crosses back. **The value is never a
value the program holds, and `vault_fill` is not a tool that returns a secret to type** — the
alternative the Captain worried about does not exist in this code, and the type is what enforces
it: `FillResult` has no field a value could travel in.

**2. It does not weaken the two-placement answer — but the number must be stated for what it
is.** The 0.2 s-versus-10 s figure was always a **CUA-only** number: ~20 observation and click
calls at ~10 ms in-box against ~0.5 s over exec. A vault fill is one call either way. What I got
wrong in the last revision was calling it "one crossing": in the box placement a fill is **two**
crossings — the program's request goes box→host, and the host's sink then drives the driver
box-side to type — against **one** exec in the host placement. That is a real asymmetry and it
is the price of the box placement, so it should be said rather than smoothed: *the box placement
is justified by computer tools alone, and a task that is mostly vault fills is not the task it
wins.* For the tasks it does win — many observations and clicks around a single sign-in — the
ratio is still overwhelming, and no task in §7.8 flips.

One consequence worth writing down: the sink must stay a **host-side interface**
(`VaultFillSink`), never become a sandbox-visible function taking a value. If a future revision
ever exposes it to the VM, both the secret guarantee and the placement argument die together,
which makes `VaultFillSink` a boundary worth a test that fails if a value-shaped field appears on
`FillResult`.

**What the program sees, and how it tells the two denials apart.** Three distinct outcomes, and
they must not collapse (the same rule as `effect`):

| Tool failure kind | Meaning | What a program should do |
|---|---|---|
| `refused` | policy says **never, anywhere**: the item's domain does not match the page, the field does not exist on that kind | pick a different item or stop; retrying cannot help |
| `unavailable_here` | **wrong placement, or it just went away**: a host-only tool reached from a box-side program, no driver attached, the box asleep, the driver session ended | report it honestly; do not retry the same call, and do not try to reach the capability another way |
| `unconfirmed` | it was attempted and the outcome cannot be proven (a delivered event the app may not have applied) | re-observe before claiming or repeating |

**The distinction a model must be able to make**, since the Captain asked for it explicitly: the
two are different in *recoverability*, and the wording must carry that, not just the code.

- `refused` is stable and the program is allowed to be there — it is a property of the *request*.
  The message names the wrong thing and the right move: "that login is saved for github.com and
  this page is evil.test; save a separate item for this site". Nothing about the environment is
  broken.
- `unavailable_here` is a property of the *environment*, and it is the one a program must not
  paper over. The message names what is missing and says it cannot be worked around: "a vault
  fill has to be applied by the process holding the credential, and this program is running on
  the computer; ask for it from a step that runs on the server, or tell the user". Crucially it
  must **not** suggest a substitute — a model told "no driver, try something else" will invent a
  path, and there is no path.

Discovery is what keeps `unavailable_here` rare, and this is the design point: `list()` and
`ALL_TOOLS` filter by placement, so the index in the request names only the tools that exist
*here*. A model that never sees `vault_fill` in its list does not call it. `unavailable_here` then
survives for exactly one honest case — a tool that *was* listed and stopped working mid-run (the
box went to sleep, the driver session ended, a lease expired) — which is precisely the case a
program must not loop on. Without the filter the two cases collapse into one and the model has to
guess; with it, a listed tool failing this way means the environment changed under the program,
and that is a distinct thing to say.

`unavailable_here` does not exist today: `tools-run.ts` answers *"this bot has no computer driver
attached, so a value cannot be typed anywhere"* — accurate, but a sentence, so nothing can branch
on it.

**One harness obligation the vault names and cannot enforce itself — and my first version of this
guard was too narrow.** `FillResult.mayShowOnScreen` is `false` for a password or a CVC because a
capture taken after a fill can contain the value when the site fails to mask its own field.
Blocking *the next* capture is not enough: if the page leaves the field visible, one refusal
removes nothing, and a later turn is free to capture the same window and put the secret in
context. The guard must be a state, not a counter:

- A fill where `mayShowOnScreen` is false puts **that window** into a `sensitive` state on the
  run. While it is sensitive, `screenshot`, `observeDesktop`, and `observeWindow({screenshot:true})`
  for that window are refused with `unconfirmed`-style honesty — a refusal naming the reason and
  the way out, never a blank image, because a silently stripped screenshot reads as a broken app.
- The state clears on evidence, not on a call count: a successful `setValue`/`typeText` into that
  field with `replace: true` (cleared), a navigation away from the host, a window close, or the
  end of the run. Re-observing the **element tree** is always allowed — it is text, and a tree
  read of a masked field returns a value of `••••`, not the secret.
- A capture that is allowed anyway (a different window, or after the state cleared) is logged as
  `screenshot.allowed` with the reason, so "why did the bot not see my screen" is answerable.
- The same state also blocks `vault_fill` into a *different* field of the same window while one
  is already sensitive, since a second fill on an unmasked page compounds the exposure.

Two things this deliberately does not do: it does not try to detect masking in the image (that is
a vision problem we have no honest measurement for, §1.3), and it does not rely on the site
setting `type="password"` — the failure case is precisely a site that does not.

**One seam risk in the shipped loop.** `run.ts` promotes a tool result into the user-visible
message text when a tool ends the run (`if (!text.trim() && outcome.result.trim()) text =
outcome.result`). For `vault_request` that is correct — its result is a sentence. It becomes a
leak the moment any tool whose result could contain a value ends a run, so the rule should be
that promotion applies only to results the tool marks as answer-shaped, not to every `endRun`.

### 7.8 What I will measure in phase 3

**Arm A is PR #39 pinned at `c2c280c`, not the code on `main`.** Be precise about this, because a
first draft of this section said "shipped" and that was wrong: `main`'s `executeRun` streams one
model response and has no tool registry, no tool loop and no `tools` parameter at all — so no
task that needs a tool can run from `main` today, and arm A is a *future baseline* rather than
the current one. Concretely, the three arms are:

| Arm | What it is | Run from |
|---|---|---|
| **A** | PR #39 at `c2c280c`: `executeRun` with `tools?: RunTool[]`, a registry, replayed `tool` results, `MAX_TOOL_STEPS = 8`; fed the 26 CUA schemas + the vault's 5 | branch `capy/encrypted-logins-cards-and` at that commit |
| **B** | code mode: one `codemode` tool, index inline, results filtered in code | the phase-2 work |
| **C** | arm A with the step cap removed | same branch, cap patched |

For anyone re-running this: arm A needs PR #39 merged or checked out, and needs the CUA tool
wrappers registered into its registry — that adapter does not exist yet and is part of phase 2,
so **arm A is not runnable from a clean `main` checkout** and the table below says which tasks
each arm can attempt rather than implying all three are equally available. Tasks no arm can
attempt (no tool exists for them in any tree, e.g. a big-table read) are marked
*not attemptable*, not scored as failures.

Ten fixed tasks, all arms, same model, same prompts, three repetitions, median:

| # | Task | Shape it covers | Needs the CUA adapter? |
|---|---|---|---|
| 1 | "hello" and one follow-up | chat, no tools | no — runs on `main` too |
| 2 | launch an app and confirm its window opened | one computer action | yes (`launchApp`) |
| 3 | read a page and report one value | one browser page | yes (`readPage`) |
| 4 | sign in to a saved login | **vault fill** | yes (`vault_fill`, no CUA needed) |
| 5 | sum a 10,000-row table and report the top five | **a result too big for context** | no — no tool exists in any arm; B can only do it once a table tool lands |
| 6 | read a window and find one labelled button | **a tree that needs filtering** | yes (`observeWindow`) |
| 7 | fill and submit a form with three fields | **many small calls in sequence** | yes (`runSteps` for B, one call per turn for A/C) |
| 8 | look at the screen and describe it | **one screenshot** | yes (`screenshot`) |
| 9 | a page behind a CAPTCHA | state, not success | yes (`readPage` reports gated) |
| 10 | "where do I save a file with this app?" | **a tool it has to discover** | index-dependent: A/C pick from 31 schemas, B searches the index |

Task 5 is the headline case and is the one no arm can currently run, because we have no table or
spreadsheet tool — the 294,592-token figure in §1.2 is a measurement of the *shape* using
synthetic rows, not a task either harness can attempt today. I would rather say that than
quietly swap in a task that flatters the result; when a table tool lands, task 5 becomes the
first thing measured against it.

Fixed seed, the same model for all arms, three repetitions per task, median reported.
Gated pages and CAPTCHAs are a live-service dependency: if the challenge does not appear on the
day, task 9 is reported as *not exercised* rather than passed.

Columns: input tokens (cached and uncached reported separately), output tokens, model turns,
tool calls, wall-clock, cost. Three arms, because two would hide something:

- **A — PR #39 at `c2c280c`.** Its `executeRun` loop with the CUA and vault schemas registered
  (the adapter is phase-2 work). This is the "before".
- **B — code mode.** One `codemode` tool, the index inline, results filtered in code.
- **C — a wall-of-schemas loop with no code mode *and no step cap*.** Arm A caps at 8 steps, so
  on task 7 it fails for a reason that is not the harness's prompt cost. C removes the cap and
  shows what the same wall costs when it is allowed to finish, which is the honest comparison
  for turns and tokens rather than for failures.

Every number is reported per arm. Where a column cannot be measured honestly it says so instead
of being filled in — the image column is the known case (§1.3).

A harness change with no before/after numbers is not done, per the brief — so the table ships
with the implementation, not before it.

---

## 8. Questions for the Captain (1–2 decided 2026-11-21; 3 open)

1. **Two placements or one? — DECIDED: two, box second, not built until in-process is measured.** I propose the VM in our process by default and on the box for
   computer-heavy runs (§Q2). One placement is simpler; two is ~50× faster on tool latency for
   the case that matters most and safer on escape. The cost is a runner on the box and a
   transport abstraction. **I recommend two, with the box placement built second** so we can
   ship the loop with one placement and measure the difference.
2. **The index inline or fetched? — DECIDED: inline.** I propose inline (**1,759** tokens) because a discovery
   call costs a whole turn. Cloudflare's codemode passes the whole API as TypeScript in the tool
   description, which is the same bet at a larger size.
3. **Native tool calling for simple tools, alongside code mode?** Anthropic and pi both keep
   the plain tool path usable. I propose **code mode only** for the model-facing surface and
   native calling only as a fallback for endpoints whose function-calling is unreliable, since
   two paths double the prompt budget and the test matrix.
