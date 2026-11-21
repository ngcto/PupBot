# Migrations

Drizzle owns the schema (`src/schema.ts`) and the migrations (`drizzle/`). Two rules keep a
database that upgrades in place from drifting away from a database built from zero.

## 1. `pnpm db:generate` for every schema change

A schema edit with no generated migration fails CI. The `test` job runs `pnpm db:generate`
and fails if it produces a new file, so a column that only exists in TypeScript cannot merge.

```bash
pnpm db:generate   # writes drizzle/NNNN_name.sql + meta/NNNN_snapshot.json, updates _journal.json
pnpm db:migrate    # applies it to DATABASE_URL
```

Commit the `.sql`, the snapshot and the journal together. They are one change.

## 2. Never let a migration's timestamp interleave with one already merged

This is the subtle one, and it has bitten this repo twice.

Drizzle's migrator decides what to run like this:

```sql
select id, hash, created_at from drizzle.__drizzle_migrations
  order by created_at desc limit 1
```

```ts
if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis) {
  // apply
}
```

It compares **one highest timestamp**, not the set of applied ids. So when two branches each add a
migration and their `when` values interleave, a database that already ran the later one will never
run the earlier one — it is not greater than the newest timestamp, so the migrator skips it
**forever**, silently.

The shape of the bug. Two branches each record migrations while both are open:

| | branch `main` | branch `feature` |
| --- | --- | --- |
| records | `0003`…`0005`, `when` = T3, T4, T5 | `0006`, `when` = T6, where T3 < T4 < T6 < T5 |

`T6` sits **between** main's T4 and T5. A database that applies `feature` records `created_at = T6`.
When it later pulls `main`, the migrator takes the newest row (`T6`) and applies a migration only
when its `when` is greater than that. Main's `0005` (`T5`) is greater, so it runs — but main's `0004`
(`T4`) is *less* than `T6`, so it is never applied: silently, with no error, and never revisited. The
migration that lands in the gap is the one that gets dropped, which is why the timestamps in a
single branch must always keep increasing.

This is not hypothetical. `drizzle/0007_model_gateway_backfill.sql` is the repair for exactly that
occurrence: a database that ran the hosting branch before main's model-gateway work landed skipped
`0003`–`0005`, so `usage_event.cost` kept its zero default, `model_endpoint` never gained its model
list, and the endpoint enum kept a kind the product had dropped. `0007` states those end states
idempotently because ordering alone cannot repair the damage.

`0006` and `0007` are one millisecond apart (`1795245420686`, `1795245420687`) — one migration split
in two, generated in order on one branch. That is safe; interleaving with another branch's range is
what is not.

### The check

`packages/db/scripts/check-journal-order.mjs` runs in the `test` job and needs no database. It
verifies three properties:

1. `idx` is exactly `0..n-1` in order — no gaps, no duplicates. A renumbering or a bad merge shows
   up here.
2. `when` is strictly increasing with `idx`. Interleaving timestamps show up here.
3. every entry has its `NNNN_name.sql` and `meta/NNNN_snapshot.json` on disk.

Run it directly:

```bash
node packages/db/scripts/check-journal-order.mjs
```

### When it fails

**You are the second branch to merge.** Regenerate your migration against the current `main` so its
timestamp lands after everything already merged:

```bash
git fetch origin main && git rebase origin/main
# if your migration is still unapplied anywhere you control:
rm drizzle/<your>.sql drizzle/meta/<your>_snapshot.json
# drop its entry from meta/_journal.json, then
pnpm db:generate
```

**A migration was already applied in an environment you cannot rebuild** (a shared staging or
production database). Do not renumber it — that re-runs SQL against a database that already has the
objects. Add a new migration that brings the database to the intended state, and record the id so it
is applied in sequence.

**An entry is missing entirely.** Restore it from `main`; the journal is append-only.
