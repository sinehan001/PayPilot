import { randomUUID } from "node:crypto";
import { db } from "./db.ts";
import type { Content } from "./llm.ts";

/** Saved conversations: the visible messages plus the exact model context, so a chat can be resumed later. */

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}
export interface ConversationSummary extends Conversation {
  count: number;
}
export interface StoredMessage {
  id: number;
  ts: string;
  role: "user" | "agent";
  text: string;
  events: unknown[];
  model: string | null;
  error: boolean;
}

const DEFAULT_TITLE = "New conversation";

export function createConversation(title = DEFAULT_TITLE): Conversation {
  const now = new Date().toISOString();
  const c = { id: "CV-" + randomUUID().slice(0, 8), title, created_at: now, updated_at: now };
  db.prepare("insert into conversations(id,title,created_at,updated_at) values(?,?,?,?)").run(c.id, c.title, now, now);
  return c;
}

export function getConversation(id: string): Conversation | undefined {
  return db.prepare("select id,title,created_at,updated_at from conversations where id=?").get(id) as Conversation | undefined;
}

export function listConversations(): ConversationSummary[] {
  return db
    .prepare(
      `select c.id, c.title, c.created_at, c.updated_at,
              (select count(*) from messages m where m.conversation_id=c.id) as count
       from conversations c order by c.updated_at desc limit 100`,
    )
    .all() as ConversationSummary[];
}

export function getMessages(conversationId: string): StoredMessage[] {
  const rows = db.prepare("select * from messages where conversation_id=? order by id").all(conversationId) as any[];
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    role: r.role,
    text: r.text,
    events: JSON.parse(r.events),
    model: r.model,
    error: Boolean(r.error),
  }));
}

export function addMessage(
  conversationId: string,
  m: { role: "user" | "agent"; text: string; events?: unknown[]; model?: string; error?: boolean },
) {
  const ts = new Date().toISOString();
  db.prepare("insert into messages(conversation_id,ts,role,text,events,model,error) values(?,?,?,?,?,?,?)").run(
    conversationId,
    ts,
    m.role,
    m.text,
    JSON.stringify(m.events ?? []),
    m.model ?? null,
    m.error ? 1 : 0,
  );
  db.prepare("update conversations set updated_at=? where id=?").run(ts, conversationId);
  if (m.role === "user") {
    const t = m.text.replace(/\s+/g, " ").trim();
    db.prepare("update conversations set title=? where id=? and title=?").run(
      t.length > 52 ? t.slice(0, 49) + "..." : t,
      conversationId,
      DEFAULT_TITLE,
    );
  }
}

export function loadHistory(id: string): Content[] {
  const r = db.prepare("select history from conversations where id=?").get(id) as { history: string } | undefined;
  return r ? (JSON.parse(r.history) as Content[]) : [];
}

export function saveHistory(id: string, history: Content[]) {
  db.prepare("update conversations set history=? where id=?").run(JSON.stringify(history), id);
}

export function clearAllConversations() {
  db.exec("delete from messages; delete from conversations;");
}
