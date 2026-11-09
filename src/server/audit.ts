import { createHash } from "node:crypto";
import { db } from "./db.ts";

/** Append-only audit log. Each row hashes the previous row, so edits are detectable. */

export interface AuditRow {
  id: number;
  ts: string;
  actor: string;
  type: string;
  summary: string;
  detail: string;
  prev_hash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

function digest(prev: string, ts: string, actor: string, type: string, summary: string, detail: string) {
  return createHash("sha256").update([prev, ts, actor, type, summary, detail].join("|")).digest("hex");
}

export function logAudit(actor: string, type: string, summary: string, detail: unknown = {}): AuditRow {
  const ts = new Date().toISOString();
  const d = JSON.stringify(detail);
  const last = db.prepare("select hash from audit order by id desc limit 1").get() as { hash: string } | undefined;
  const prev = last?.hash ?? GENESIS;
  const hash = digest(prev, ts, actor, type, summary, d);
  const info = db
    .prepare("insert into audit(ts,actor,type,summary,detail,prev_hash,hash) values(?,?,?,?,?,?,?)")
    .run(ts, actor, type, summary, d, prev, hash);
  return { id: Number(info.lastInsertRowid), ts, actor, type, summary, detail: d, prev_hash: prev, hash };
}

export function listAudit(limit = 200): AuditRow[] {
  return db.prepare("select * from audit order by id desc limit ?").all(limit) as AuditRow[];
}

export function verifyChain(): { ok: boolean; brokenAt?: number; count: number } {
  const rows = db.prepare("select * from audit order by id asc").all() as AuditRow[];
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev || r.hash !== digest(prev, r.ts, r.actor, r.type, r.summary, r.detail)) {
      return { ok: false, brokenAt: r.id, count: rows.length };
    }
    prev = r.hash;
  }
  return { ok: true, count: rows.length };
}
