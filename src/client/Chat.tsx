import { useEffect, useRef, useState } from "react";
import type { AgentEvent, ConversationSummary, SkillInfo } from "./api";
import type { Suggestion } from "./suggestions";

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export interface Msg {
  role: "user" | "agent";
  text: string;
  events?: AgentEvent[];
  error?: boolean;
  /** Which model answered, e.g. "gemini:gemini-3-flash-preview" or "demo-mock". */
  model?: string;
}

const TOOL_LABEL: Record<string, string> = {
  list_charges: "Looked up your charges",
  get_subscription: "Checked a subscription",
  cancel_subscription: "Requested a cancellation",
  request_refund: "Requested a refund",
  check_request_status: "Checked a request",
  list_my_skills: "Checked what I can help with",
  request_human_help: "Asked a person to follow up",
};

/** What a successful result is called, so "Done" is never vague. */
const OK_LABEL: Record<string, string> = {
  cancel_subscription: "Cancelled",
  request_refund: "Refunded",
  check_request_status: "Status found",
  list_my_skills: "Found",
  get_subscription: "Found",
  request_human_help: "Sent to a person",
};

const RESULT: Record<string, { label: string; cls: string }> = {
  ok: { label: "Done", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  pending_approval: { label: "Sent for approval", cls: "bg-amber-50 text-amber-800 ring-amber-200" },
  needs_confirmation: { label: "Waiting for your confirmation", cls: "bg-blue-50 text-accent-dark ring-blue-200" },
  denied: { label: "Blocked by safety rules", cls: "bg-red-50 text-red-700 ring-red-200" },
  error: { label: "Failed, nothing changed", cls: "bg-slate-100 text-slate-700 ring-slate-200" },
};

/** Tiny formatter: turns **bold** into bold and "* item" into a bullet, so stray markdown never shows. */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*)/g).map((p, i) =>
        p.startsWith("**") && p.endsWith("**") && p.length > 4 ? (
          <strong key={i}>{p.slice(2, -2)}</strong>
        ) : (
          <span key={i}>{p.replace(/^\s*[*-]\s+/gm, "• ")}</span>
        ),
      )}
    </>
  );
}

function Chips({ events }: { events: AgentEvent[] }) {
  const items = events.filter((e) => e.type === "tool_call" || e.type === "tool_result");
  if (!items.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Agent actions">
      {items.map((e, i) => {
        if (e.type === "tool_call")
          return (
            <span key={i} className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700 ring-1 ring-slate-200">
              {e.kind === "write" ? "Action: " : ""}
              {TOOL_LABEL[e.name] ?? e.name}
            </span>
          );
        if (e.type === "tool_result" && e.name !== "list_charges") {
          const r = RESULT[e.result.status] ?? RESULT.error;
          return (
            <span key={i} className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${r.cls}`}>
              {e.result.status === "ok" ? (OK_LABEL[e.name] ?? r.label) : r.label}
            </span>
          );
        }
        return null;
      })}
    </div>
  );
}

/** The conditions the system verified before the AI could act. Collapsed by default. */
function Checks({ events }: { events: AgentEvent[] }) {
  const lists = events.flatMap((e) => (e.type === "tool_result" && e.result.checks?.length ? [e.result.checks] : []));
  if (!lists.length) return null;
  const last = lists[lists.length - 1];
  const met = last.filter((c) => c.ok).length;
  return (
    <details className="mt-2 rounded-lg bg-white/70 px-3 py-2 text-xs ring-1 ring-slate-200">
      <summary className="min-h-6 cursor-pointer font-medium text-slate-700">
        Safety checks: {met} of {last.length} met
      </summary>
      <ul className="mt-2 space-y-1.5">
        {last.map((c) => (
          <li key={c.id} className="flex gap-2">
            <span className={c.ok ? "text-emerald-600" : "text-red-600"} aria-hidden="true">
              {c.ok ? "✓" : "✗"}
            </span>
            <span className="min-w-0">
              <span className={c.skipped ? "text-slate-400" : "text-slate-700"}>{c.label}</span>
              {!c.ok && c.detail && <span className="block text-red-700">{c.detail}</span>}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function MessageBubble({ m }: { m: Msg }) {
  return (
    <div className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[88%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed ${
          m.role === "user"
            ? "bg-accent text-white"
            : m.error
              ? "border border-red-200 bg-red-50 text-red-800"
              : m.model === "acme-digital"
                ? "border border-blue-200 bg-blue-50 text-ink"
                : "border border-line bg-surface text-ink"
        }`}
      >
        {m.model === "acme-digital" && <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-accent-dark">Message from Acme Digital</p>}
        <Rich text={m.text} />
        {m.events && <Chips events={m.events} />}
        {m.events && <Checks events={m.events} />}
        {m.model === "demo-mock" && (
          <p className="mt-2 text-xs text-amber-700">Live AI was slow, so the scripted demo AI answered. Policy checks still ran.</p>
        )}
      </div>
    </div>
  );
}

export default function Chat({
  messages,
  busy,
  disabled,
  onSend,
  conversations,
  activeId,
  onSelect,
  onNew,
  pendingCount,
  onReview,
  skills,
  suggestions,
}: {
  messages: Msg[];
  busy: boolean;
  disabled: boolean;
  onSend: (t: string) => void;
  conversations: ConversationSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  pendingCount: number;
  onReview: () => void;
  skills: SkillInfo[];
  /** Dynamic suggested questions, built from the live account and the conversation. */
  suggestions: Suggestion[];
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const active = conversations.find((c) => c.id === activeId);
  const end = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** A suggestion only fills the box. The customer can edit it, then press Send. */
  const fill = (t: string) => {
    setText(t);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(t.length, t.length);
    });
  };
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);

  const submit = () => {
    const t = text.trim();
    if (!t || busy || disabled) return;
    setText("");
    onSend(t);
  };

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col rounded-2xl border border-line bg-white shadow-sm" aria-label="Chat">
      <div className="relative flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 border-b border-line px-3 py-2">
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="shrink-0 rounded-lg border border-line bg-white px-3 py-2 text-sm font-medium hover:border-slate-400"
        >
          History ({conversations.length}) {open ? "▴" : "▾"}
        </button>
        {/* On phones the title gets its own full-width line, so it never squeezes the two buttons. */}
        <span className="order-last w-full truncate text-left text-xs text-muted sm:order-none sm:w-auto sm:min-w-0 sm:flex-1 sm:text-center sm:text-sm">
          {active ? active.title : "New conversation"}
        </span>
        <button
          onClick={() => {
            setOpen(false);
            onNew();
          }}
          disabled={busy}
          className="shrink-0 rounded-lg bg-blue-50 px-3 py-2 text-sm font-semibold text-accent-dark hover:bg-blue-100 disabled:opacity-50"
        >
          + New chat
        </button>
        {open && (
          <ul className="absolute left-2 right-2 top-full z-10 mt-1 max-h-80 overflow-y-auto rounded-xl border border-line bg-white shadow-lg">
            {conversations.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted">No saved conversations yet.</li>}
            {conversations.map((c) => (
              <li key={c.id} className="border-b border-line last:border-0">
                <button
                  onClick={() => {
                    setOpen(false);
                    onSelect(c.id);
                  }}
                  className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-surface ${c.id === activeId ? "bg-blue-50" : ""}`}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{c.title}</span>
                    <span className="block text-xs text-muted">
                      {c.count} message{c.count === 1 ? "" : "s"} · {ago(c.updated_at)}
                    </span>
                  </span>
                  {c.id === activeId && <span className="shrink-0 text-xs font-semibold text-accent-dark">Open</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-4 sm:p-5" aria-live="polite">
        {messages.length === 0 && (
          <div className="mx-auto max-w-md pt-6 text-center">
            <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-accent text-xl font-bold text-white">P</div>
            <h2 className="text-lg font-semibold">Hi Priya, how can I help with your billing?</h2>
            <p className="mt-1 text-sm text-muted">I'm an AI assistant for Acme Digital billing. This is exactly what I can help with:</p>
            <ul className="mx-auto mt-4 max-w-sm space-y-2 text-left" aria-label="What I can help with">
              {skills
                .filter((s) => s.kind !== "conduct" && s.enabled)
                .map((s) => (
                  <li key={s.id} className="rounded-xl border border-line bg-surface px-3.5 py-2.5">
                    <p className="text-sm font-semibold">{s.name}</p>
                    <p className="text-xs text-muted">{s.description}</p>
                  </li>
                ))}
            </ul>
            <p className="mx-auto mt-3 max-w-sm text-xs text-muted">
              I can't change plans or prices, promise a refund (the merchant's policy and a person decide, and you'll be told why), or help with
              anything outside billing. If I can't help, I'll pass you to a person.
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              {suggestions.map((s) => (
                <button
                  key={s.label}
                  onClick={() => fill(s.text)}
                  disabled={busy || disabled}
                  className="rounded-full border border-line bg-white px-3.5 py-2 text-sm text-ink transition hover:border-accent hover:text-accent disabled:opacity-50"
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="space-y-4">
          {messages.map((m, i) => (
            <MessageBubble key={i} m={m} />
          ))}
          {busy && (
            <div className="flex justify-start">
              <div className="flex items-center gap-1.5 rounded-2xl border border-line bg-surface px-4 py-3" aria-label="Agent is typing">
                <span className="dot h-2 w-2 rounded-full bg-muted" />
                <span className="dot h-2 w-2 rounded-full bg-muted" />
                <span className="dot h-2 w-2 rounded-full bg-muted" />
              </div>
            </div>
          )}
          <div ref={end} />
        </div>
      </div>
      {pendingCount > 0 && (
        <button
          type="button"
          onClick={onReview}
          className="mx-3 mb-1 mt-3 flex min-h-11 items-center justify-between gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2 text-left text-sm font-medium text-amber-900 lg:hidden"
        >
          <span>
            {pendingCount} request{pendingCount === 1 ? "" : "s"} with Acme Digital for review
          </span>
          <span className="shrink-0 font-semibold text-accent-dark">View</span>
        </button>
      )}
      {messages.length > 0 && (
        <div className="no-scrollbar flex gap-2 overflow-x-auto border-t border-line px-3 pt-2.5" aria-label="Suggested questions">
          {suggestions.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => fill(s.text)}
              disabled={busy || disabled}
              className="shrink-0 rounded-full border border-line bg-white px-3.5 py-2 text-[13px] text-ink sm:py-1.5 sm:text-xs transition hover:border-accent hover:text-accent disabled:opacity-50"
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
      <form
        className={`flex gap-2 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] ${messages.length > 0 ? "" : "border-t border-line"}`}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask about a charge, a refund, or a cancellation"
          aria-label="Message"
          maxLength={1000}
          className="min-w-0 flex-1 rounded-xl border border-line bg-white px-4 py-2.5 text-base placeholder:text-slate-400 sm:text-[15px]"
        />
        <button
          type="submit"
          disabled={!text.trim() || busy || disabled}
          className="min-h-11 rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-accent-dark disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </section>
  );
}
