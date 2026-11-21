# Harness v2 research — code mode by default

**Thread** TERA-81 · **Issue** NGS-81 · **Date** 2026-11-21

The brief asked for `reports/TERA-76.md`; this thread's code is TERA-81 and the issue is
NGS-81, so the file is named after the thread. Say the word and I rename it.

This is phase 1: reading, measuring our own surface, and a design with its trade-offs. No
harness code is written yet. Every number below is labelled with who measured it — **mine**
means I ran it in this thread on this machine on 2026-11-21, and the command or script is
reproducible from the notes in §1.2.

---

## 0. The short version

1. Our tool surface is 26 functions today and grows. As schemas it costs **3,546 tokens per
   request** (mine). As an index it costs **1,200**, as names only **81**, and a code-mode
   tool with a one-line description **46**.
2. The bigger number is not the schemas, it is results: a 10,000-row read is **294,592
   tokens** through the model and **149** filtered in code (mine). That ratio is the whole
   argument for code mode and it is 2,000×, not 2×.
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

Scripts: `~/.capy/work/research/{schemas.ts,measure2.mts,measure3.mts,bench.mjs}` on this
machine. Token counts come from `POST /v1/messages/count_tokens` on `claude-sonnet-5-5`
through our configured Anthropic-compatible endpoint. They measure *the text*, so the number
for a tools block includes the wire-format JSON overhead of the schemas themselves. The 26
schemas are **my** rendering of the typed signatures in `handoffs/ngs-79-cua-interface.md`
(that package is not on `main` yet), so they are representative, not byte-identical to what
TERA-74 will ship.

**Fixed cost per request, by representation:**

| Representation | Tokens |
|---|---|
| 26 schemas, Anthropic `tools` block | **3,546** |
| 26 schemas, OpenAI chat `tools` block | 3,734 |
| 26 schemas, OpenAI Responses `tools` block | 3,650 |
| pi-style `declare const tools` TypeScript declarations | 3,984 |
| Tool index: name + description + `when[]` + cost | **1,200** |
| Tool index: names only | 81 |
| One `codemode` tool, one-line description (in a real `tools` block) | **46** |
| One `codemode` tool + the full index in its description (real `tools` block) | **1,232** |

**Variable cost, by result shape:**

| Result | Tokens |
|---|---|
| A 75-row accessibility tree, as JSON | **3,119** |
| The same tree, as `[token] role "label"` lines | **1,213** |
| A 10,000-row table as JSON (1.18 MB of characters) | **294,592** |
| That table filtered in code: "137 pending, here are 5" | **149** |
| A 95 KB screenshot as base64 (TERA-74's measured capture size) | **31,921** |

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
- **Images are the single most expensive thing we can return.** One screenshot is 31,921
  tokens — nine `codemode` tool definitions. This is why the CUA index marks `screenshot` as
  `expensive`, and it is why the harness must cap them structurally, not by asking the model
  to be careful.

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
performance before the agent starts. On our surface: 3,546 → 46 (bare) or 1,232 (with the
index inline), i.e. a 2.9× to 77× reduction in the fixed term.

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
- **The idempotency key** `<runId>:<callId>` passed to every tool. Ours is the run id plus a
  monotonic call index, which our `run_event.seq` already provides.

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
the same VM runs on the bot's box, next to the driver daemon.**

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
3. **A successful program's output is one `message.completed`, not N.** The message row is the
   program's `text()` output plus its return value, which is exactly what the model sees, so a
   replay shows the same thing the model saw. Individual tool calls are visible in the log for
   the UI's activity row, but they are not message parts — otherwise a 20-call program becomes
   a 20-bubble message.
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
- **The index travels with it**, at 1,200 tokens, because a model that has to make a discovery
  call before it can act pays a turn for it. 1,200 cached tokens (≈120 token-equivalents at
  Sonnet 5.5 cache-read pricing) is cheaper than one extra turn. **This is a deliberate
  departure from "47 tokens"** and the reason is the turn, not the token.
  *Measured:* index inline **1,232** vs bare **46**. *Cheaper than:* one round trip, which costs the
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
  tools:   codemode(code) + the 1,200-token capability index      ← breakpoint 1
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
  kind: "refused" | "failed" | "invalid_input" | "limit" | "timeout";
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

### 7.5 What I will measure in phase 3

Ten fixed tasks, both harnesses, same model, same prompts:

1. chat needing no tool (a greeting, a follow-up) — both should be one turn.
2. one computer action (launch an app, confirm it opened).
3. a browser page read (navigate, extract a value, report it).
4. a vault fill (read a secret, type it into a field, confirm).
5. a big-result task (a 10k-row read, filtered to a number) — the 294,592→149 case.
6. a loop task (retry until a condition, e.g. a window title appears).
7. a multi-action desktop task (the Thunar filter from TERA-74's live proof).
8. a gated page (a CAPTCHA state must be reported as state, not success).
9. an unresolvable task (the bot must say so, not flail).
10. a long conversation (12 turns, to exercise compaction and cache).

Columns: input tokens (cached and uncached separately), output tokens, model turns, tool calls,
wall-clock, and cost. **Two arms**: (A) the current harness, which has no tool loop at all, so
it can only do tasks 1, 9 and 10 — and (B) a wall-of-schemas loop I build *as a measurement
control*, 26 schemas and one call per turn, which is what the current code would become if
TERA-74's loop landed without this work. Arm B is the honest "before" for tool tasks; arm A is
the honest "before" for chat. Reporting only (A) would be a fake win.

A harness change with no before/after numbers is not done, per the brief — so the table ships
with the implementation, not before it.

---

## 8. Open questions for the Captain

1. **Two placements or one?** I propose the VM in our process by default and on the box for
   computer-heavy runs (§Q2). One placement is simpler; two is ~50× faster on tool latency for
   the case that matters most and safer on escape. The cost is a runner on the box and a
   transport abstraction. **I recommend two, with the box placement built second** so we can
   ship the loop with one placement and measure the difference.
2. **The index inline or fetched?** I propose inline (1,221 tokens) because a discovery call
   costs a whole turn. Cloudflare's codemode passes the whole API as TypeScript in the tool
   description, which is the same bet at a larger size.
3. **Native tool calling for simple tools, alongside code mode?** Anthropic and pi both keep
   the plain tool path usable. I propose **code mode only** for the model-facing surface and
   native calling only as a fallback for endpoints whose function-calling is unreliable, since
   two paths double the prompt budget and the test matrix.
