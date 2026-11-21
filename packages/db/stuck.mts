import { Client } from "pg";
const c = new Client({ connectionString: process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL });
await c.connect();
const q = async (l: string, s: string) => { const r = await c.query(s); console.log(l, JSON.stringify(r.rows)); };
await q("binding bots:", `select b.id, b.name, b.updated_at from bot b where b.computer_state='binding'`);
await q("unclaimed jobs:", `select id, name, state, data, created_on from pgboss.job where name='computer-provision'`);
await q("binding updated:", `select computer_state, count(*) from bot group by computer_state`);
await c.end();
