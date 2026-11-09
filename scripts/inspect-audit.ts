import "dotenv/config";
import { db } from "../src/server/db.ts";

// Dev helper: print a window of the audit log. Usage: tsx scripts/inspect-audit.ts [fromId] [toId]
const from = Number(process.argv[2] ?? 0);
const to = Number(process.argv[3] ?? 1e9);
const rows = db.prepare("select id, ts, actor, type, summary from audit where id between ? and ? order by id").all(from, to) as {
  id: number;
  ts: string;
  actor: string;
  type: string;
  summary: string;
}[];
for (const r of rows) console.log(r.id, r.ts.slice(11, 19), r.actor.padEnd(11), r.type.padEnd(18), r.summary.slice(0, 90));
