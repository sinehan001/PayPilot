import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const path = process.env.DB_PATH ?? "data/paypilot.db";
if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

export const db = new Database(path);
db.pragma("journal_mode = WAL");

db.exec(`
create table if not exists subscriptions(
  id text primary key, customer text not null, merchant text not null, product text not null,
  amount real not null, interval text not null, status text not null, started text not null, next_charge text);
create table if not exists charges(
  id text primary key, subscription_id text, customer text not null, amount real not null,
  date text not null, description text not null, status text not null, note text);
create table if not exists audit(
  id integer primary key autoincrement, ts text not null, actor text not null, type text not null,
  summary text not null, detail text not null, prev_hash text not null, hash text not null);
create table if not exists approvals(
  id text primary key, ts text not null, kind text not null, payload text not null,
  reason text not null, status text not null, decided_ts text);
create table if not exists settings(key text primary key, value text not null);
create table if not exists conversations(
  id text primary key, title text not null, created_at text not null, updated_at text not null,
  history text not null default '[]');
create table if not exists messages(
  id integer primary key autoincrement, conversation_id text not null, ts text not null,
  role text not null, text text not null, events text not null default '[]', model text, error integer not null default 0);
create index if not exists idx_messages_conv on messages(conversation_id, id);
create table if not exists proposals(
  id text primary key, conversation_id text not null, tool text not null, key text not null,
  args text not null, turn integer not null, status text not null, created_at text not null);
`);

// Migration: every approval remembers which conversation it came from and why the merchant decided as they did.
for (const col of ["decision_reason", "conversation_id"]) {
  const cols = db.prepare("pragma table_info(approvals)").all() as { name: string }[];
  if (!cols.some((c) => c.name === col)) db.exec(`alter table approvals add column ${col} text`);
}

// Migration: demo rows can be linked to real PayPal sandbox objects.
for (const t of ["subscriptions", "charges"]) {
  const cols = db.prepare(`pragma table_info(${t})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "paypal_id")) db.exec(`alter table ${t} add column paypal_id text`);
}
