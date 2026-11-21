# The computer lifecycle

How a bot gets a machine, keeps it, and gives it back. This is the behaviour all of
`packages/computers`, the run harness and Settings › Computer implement together.

## A box is built on first use

A bot starts with no computer, and that is a normal, free state: it chats, answers, and
costs nothing. A machine appears the first time the bot actually needs one — when the
model calls the `run_command` tool during a run.

That moment is the only provisioning trigger. There is no button in the normal path and
no provisioning on a page load:

- `executeRun` offers `run_command` when the bot has a computer layer wired in and the
  model's catalogue entry does not say it cannot call tools.
- The tool calls `RunComputer.withLease(botId, fn)`, which calls
  `ComputerAllocator.ensureReady`.
- `ensureReady` reuses the bot's box if it has one and provisions one if it does not.

Pressing **Build it now** in a bot's settings calls the same allocator through a queue
job. It exists for the person who wants a machine before using one, and it cannot cause a
second box: the allocator's first act is to check for an existing binding.

### A bot never has two boxes

Two checks, at two levels, because either alone is insufficient:

1. `allocateForBot` runs under a per-bot in-process lock, so two messages arriving
   together in one process create one box.
2. The bind is a single `INSERT` against `bot_computer_active_idx`, a unique index on
   `bot_id` where `released_at is null`. Two *processes* — the web app and the worker, or
   two serverless instances — cannot both win. The loser destroys the box it just made.

## Every failure is a message, and the bot writes it

There is no card, no banner and no injected message. The only thing the user sees is the
bot's own reply. So a computer failure is a structured value the model reads, not a stack
trace and not a bare string:

```ts
interface Obstacle {
  code: "no_provider" | "no_plan" | "all_busy" | "provider_error" | "computer_lost";
  summary: string;    // what is wrong, one sentence
  detail: string;     // the cause: which provider, which limit
  resolution: string; // what the user would actually have to do
  userAction: "configure" | "plan" | "wait" | "none";
  retryable: boolean;
}
```

The wording is decided in `packages/computers/src/allocator/failures.ts`, because that is
the layer that knows the cause. `describeObstacle` renders it as the tool result, and
`obstacleInstruction` is appended to the run's context so the model explains it in its own
words rather than pasting an error.

The four ways a bot can be stopped, and what each tells the user:

| Situation | `code` | What the user is told they can do |
| --- | --- | --- |
| No provider configured and no deployment pool | `no_provider` | Add a provider in Settings › Computer |
| A deployment pool exists but needs a plan | `no_plan` | Choose a plan in Settings › Billing |
| Every provider is full or rate-limited | `all_busy` | Nothing to buy: it clears, or add a second provider |
| A provider answered with something unusable | `provider_error` | Check the provider key in Settings › Computer |

`all_busy` deliberately carries no purchase prompt: there is nothing to buy, and telling
someone to spend money because a machine is busy is a lie.

If the model produces no text after a refusal, the run writes one honest sentence taken
from the obstacle, so a blocked bot never ends with an empty bubble.

## Idle sleep, and what wakes the box

A box sleeps **10 minutes** (`ALLOCATOR_DEFAULTS.idleSeconds = 600`) after its last use,
and wakes when the bot next needs it.

Ten minutes is the smallest number that does not punish a person for reading a reply. A
run holds a lease for its whole duration, and a lease is renewed every maintenance tick
while it lives, so a long run never has its machine swept mid-work. Any gap longer than a
few minutes means the human went away; ten covers typing a follow-up without rebuilding
the box, and every minute past that is runtime someone pays for.

Two enforcers, armed with that one number by `createComputerRuntime`:

- **Ours, as the authority.** `sweepIdle` runs on the maintenance tick (once a minute),
  sleeps any box whose leases have all lapsed and whose idle window is past.
- **The provider's, as the backstop.** The same `idleSeconds` is passed to the provider
  factory, which turns it into Instabox's `autoSuspendAfterSeconds` at create time. This
  is what saves money when *our* process dies: a crashed worker or a paused deployment
  leaves a box that pauses itself instead of one that runs until its three-hour TTL.

Our reaper is the one that decides, because it is the only one that knows about leases —
a provider cannot see that a run is still streaming. The provider's clock exists so that
the decision still happens when ours is not running.

Waking is transparent: `ensureReady` calls the provider's `start`, which resolves only
once an exec would work, so a tool never loops on "not ready yet". The run shows **Using
the computer** while it happens, and a wake that fails is replaced or explained — never a
dead button.

## Destroy on delete

Deleting a bot destroys its box.

`deleteBot` calls `destroyForBot` **before** removing the row, and awaits it. The order
matters: the row is the only thing that says which box to delete, and `bot_computer`
cascades away with the bot, so deleting first would leave a machine running at the
provider with nothing pointing at it.

If the provider refuses, two things are true at once:

- **The bot deletion completes.** A user asked to remove a bot and must not be stuck with
  it because a provider is having a bad afternoon.
- **The box is recorded** in `computer_orphan`, with the account, the provider and the
  external id — everything a later delete needs — plus the attempt count and the error.

`reapOrphans` retries each one on the maintenance tick. A row that succeeds is deleted; a
row that keeps failing keeps its count and its error, so an operator can see exactly what
is still billing and why it will not go away. An orphan whose account row is gone is left
in place with a note, because there is no credential left to reach it and a human has to
delete it in the provider's dashboard.

Deleting a **workspace** takes the same path through `destroyForWorkspace`. That is why
`computer.workspace_id` is `on delete set null` rather than `cascade`: a cascade would
delete the row while the box kept running.

## One account per provider, several providers

A workspace may configure at most one account per provider, and as many different
providers as it likes. The second half is the point: allocation walks every provider, so
one being out of capacity does not fail the use.

The rule is a partial unique index, `computer_account_one_per_provider_idx`, on
`(workspace_id, provider)` where `managed = false`. A deployment-provided account is
`managed = true` with no `workspace_id`, so it is exempt — the deployment may hold many
pools, and they are not the workspace's rows to count.

`addComputerAccount` checks first so the user gets a sentence instead of an index name,
and the index is what actually holds when two tabs save at once.

## Which provider a box comes from

Deterministic, lowest rank first:

1. An account that already hosted this bot, so a bot that lost its box returns where its
   files are.
2. Managed pools before workspace-configured keys, so a free deployment pool is spent
   before someone's own paid one.
3. Lowest utilisation against capacity, which spreads boxes instead of filling the first
   account.
4. Provider name, then label.

Random ordering would make "the second provider was used" untestable and make two
identical accounts behave differently between runs.
