#!/usr/bin/env node
/**
 * Guard the migration journal's ordering, which drizzle relies on and which
 * `drizzle-kit check` does not verify.
 *
 * Drizzle's migrator picks what to run with:
 *
 *   select id, hash, created_at from drizzle.__drizzle_migrations
 *     order by created_at desc limit 1
 *
 * then applies a migration only when `lastDbMigration.created_at < folderMillis`.
 * It compares a single highest timestamp, not a set of applied ids. So if two
 * branches record migrations whose `when` values interleave, a database that
 * applied the later one will skip the earlier one **forever** — it is never
 * looked at again, because its timestamp is not greater than the newest one.
 *
 * That has already happened twice in this repo: `0007`'s file documents the
 * first occurrence, and a branch recording `0009` before main's `0008` existed
 * silently dropped `0008` and lost a table on machines that had already run
 * `0009`.
 *
 * Three properties make that impossible, and all three are checkable from the
 * journal alone, with no database:
 *
 *   1. `idx` is exactly 0..n-1, in order — no gaps and no duplicates, which is
 *      what a renumbering or a botched merge produces.
 *   2. `when` is strictly increasing with `idx` — two branches' timestamps whose
 *      ranges interleave show up here as a decrease.
 *   3. every entry has its `NNNN_name.sql` and `NNNN_snapshot.json` on disk.
 *
 * Exits non-zero with an explanation of the fix, so CI reports something a
 * reviewer can act on instead of a bare stack.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dbPackage = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const drizzleDir = resolve(dbPackage, "drizzle");
const journalPath = resolve(drizzleDir, "meta", "_journal.json");

let journal;
try {
  journal = JSON.parse(readFileSync(journalPath, "utf8"));
} catch (error) {
  console.error(`cannot read ${journalPath}: ${error.message}`);
  process.exit(1);
}

const problems = [];

// A merge that drops or duplicates an entry is exactly the failure this guard is
// for, so a malformed journal must be reported, never thrown on.
const rawEntries = Array.isArray(journal.entries) ? journal.entries : [];
if (!Array.isArray(journal.entries)) problems.push("the journal has no `entries` array");
const entries = rawEntries.filter((entry) => entry !== null && typeof entry === "object");

if (entries.length === 0) {
  problems.push("the journal has no entries");
}
if (entries.length !== rawEntries.length) {
  problems.push(`${rawEntries.length - entries.length} journal entr(y/ies) are not objects`);
}

// 1. idx must be 0..n-1 in order.
entries.forEach((entry, position) => {
  if (entry.idx !== position) {
    problems.push(
      `entry #${position + 1} in the journal has idx ${entry.idx}; idx must count up from 0 with no gaps or repeats (a renumbering or a bad merge looks like this)`,
    );
  }
  if (typeof entry.tag !== "string" || entry.tag.length === 0) {
    problems.push(`entry #${position + 1} has no tag`);
    return;
  }
  if (!/^\d{4}_[a-z0-9_]+$/.test(entry.tag)) {
    problems.push(`entry #${position + 1} tag "${entry.tag}" is not in NNNN_name form`);
  }
  const prefix = entry.tag.slice(0, 4);
  if (prefix !== String(position).padStart(4, "0")) {
    problems.push(
      `entry #${position + 1} has tag "${entry.tag}" but sits at position ${position}; the number in the name must match the position`,
    );
  }
});

// 2. `when` must increase with idx. This is the property that makes drizzle's
//    "compare against the newest timestamp" logic equivalent to "compare
//    against the set of applied ids".
for (let i = 1; i < entries.length; i++) {
  const previous = entries[i - 1];
  const current = entries[i];
  if (typeof previous?.when !== "number" || typeof current?.when !== "number") {
    problems.push(`entry "${current?.tag ?? i}" has no numeric "when"`);
    continue;
  }
  if (current.when <= previous.when) {
    problems.push(
      `"${current.tag}" (when=${current.when}) does not come after "${previous.tag}" (when=${previous.when}). ` +
        `Drizzle compares only the newest created_at, so a database that ran "${current.tag}" would skip "${previous.tag}" forever. ` +
        `Regenerate the later migration so its timestamp lands after every migration that is already merged.`,
    );
  }
}

// 3. Each entry needs its SQL and its snapshot.
const files = new Set(readdirSync(drizzleDir));
const snapshots = new Set(
  (() => {
    try {
      return readdirSync(resolve(drizzleDir, "meta"));
    } catch {
      return [];
    }
  })(),
);
const tags = new Set(entries.map((entry) => entry.tag).filter((tag) => typeof tag === "string"));
for (const entry of entries) {
  if (typeof entry.tag !== "string") continue;
  if (!files.has(`${entry.tag}.sql`)) problems.push(`missing ${entry.tag}.sql`);
  if (!snapshots.has(`${entry.tag.slice(0, 4)}_snapshot.json`)) {
    problems.push(`missing meta/${entry.tag.slice(0, 4)}_snapshot.json`);
  }
}

// 4. And the reverse: a .sql on disk with no journal entry is never applied, and
//    the check above cannot see it because it only walks entries. A conflict
//    resolved by keeping both sides' files and one side's journal lands here.
for (const file of files) {
  if (!file.endsWith(".sql")) continue;
  const tag = file.slice(0, -".sql".length);
  if (!tags.has(tag)) {
    problems.push(
      `${file} exists but no journal entry lists it, so drizzle would never run it — the journal and the migration files disagree`,
    );
  }
}

if (problems.length > 0) {
  console.error("The migration journal is not safe to apply:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    "\nSee packages/db/docs/migrations.md for how to add a migration that cannot be skipped.",
  );
  process.exit(1);
}

console.log(`${entries.length} migrations, idx 0..${entries.length - 1}, timestamps strictly increasing`);
for (const entry of entries) {
  console.log(`  ${entry.tag}  when=${entry.when}`);
}
