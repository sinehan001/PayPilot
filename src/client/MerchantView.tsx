import { useEffect, useState } from "react";
import { MessageBubble, type Msg } from "./Chat";
import { ApprovalsPanel, AuditPanel, PolicyPanel } from "./Panels";
import { api, type ConversationSummary, type MerchantSummary, type SkillInfo, type State, type StoredMessage } from "./api";

type MTab = "approvals" | "skills" | "conversations" | "audit" | "policy";

const money = (n: number) => `$${n.toFixed(2)}`;
function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function Kpi({ label, value, hint, accent }: { label: string; value: string; hint: string; accent?: boolean }) {
  return (
    <div className={`rounded-2xl border p-4 shadow-sm ${accent ? "border-amber-300 bg-amber-50" : "border-line bg-white"}`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-0.5 text-xs text-muted">{hint}</p>
    </div>
  );
}

/** What the AI is allowed to do, the conditions the system checks first, and an on/off switch for each. */
function SkillsPanel({ refreshKey, onChanged }: { refreshKey: number; onChanged: () => void }) {
  const [list, setList] = useState<SkillInfo[]>([]);
  useEffect(() => {
    api<SkillInfo[]>("/api/skills")
      .then(setList)
      .catch(() => {});
  }, [refreshKey]);

  const toggle = async (s: SkillInfo) => {
    setList(await api<SkillInfo[]>(`/api/skills/${s.id}`, { method: "PUT", body: JSON.stringify({ enabled: !s.enabled }) }));
    onChanged();
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Skills are everything the AI is allowed to do. Before any skill acts, the system checks its conditions in code. The AI cannot
        skip a condition, and a skill you switch off disappears from the AI completely.
      </p>
      {list.map((s) => (
        <article key={s.id} className={`rounded-xl border p-4 ${s.enabled ? "border-line bg-white" : "border-dashed border-slate-300 bg-surface"}`}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold">{s.name}</h3>
              <span
                className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${
                  s.kind === "write"
                    ? "bg-amber-50 text-amber-800 ring-amber-200"
                    : s.kind === "conduct"
                      ? "bg-blue-50 text-accent-dark ring-blue-200"
                      : "bg-emerald-50 text-emerald-700 ring-emerald-200"
                }`}
              >
                {s.kind === "write" ? "Changes the account" : s.kind === "conduct" ? "How the AI behaves" : "Read only"}
              </span>
            </div>
            {s.locked ? (
              <span className="shrink-0 rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200">Always on</span>
            ) : (
              <button
                role="switch"
                aria-checked={s.enabled}
                aria-label={`${s.name} skill`}
                onClick={() => toggle(s)}
                className={`relative h-7 w-12 shrink-0 rounded-full transition ${s.enabled ? "bg-accent" : "bg-slate-300"}`}
              >
                <span
                  className={`absolute left-0.5 top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${s.enabled ? "translate-x-5" : "translate-x-0"}`}
                />
              </button>
            )}
          </div>
          <p className="mt-2 text-sm">{s.description}</p>
          <p className="mt-1 text-xs text-muted">Used when: {s.whenToUse}</p>
          {s.conditions.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                {s.kind === "conduct" ? "How it treats every customer" : "Must all be true first"}
              </p>
              <ul className="mt-1.5 space-y-1">
                {s.conditions.map((c) => (
                  <li key={c} className="flex gap-2 text-sm">
                    <span className="text-emerald-600" aria-hidden="true">
                      ✓
                    </span>
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="mt-3 text-xs text-muted">
            {s.kind === "conduct" ? "If it gets difficult" : "If a condition fails"}: {s.escalation}
          </p>
        </article>
      ))}
    </div>
  );
}

/** Read-only look at what customers asked and what the AI did. */
function ConversationsReview({ refreshKey }: { refreshKey: number }) {
  const [list, setList] = useState<ConversationSummary[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);

  useEffect(() => {
    api<ConversationSummary[]>("/api/conversations")
      .then(setList)
      .catch(() => {});
  }, [refreshKey]);

  const open = async (id: string) => {
    const r = await api<{ messages: StoredMessage[] }>(`/api/conversations/${id}`);
    setMsgs(r.messages.map((m) => ({ role: m.role, text: m.text, events: m.events, model: m.model ?? undefined, error: m.error })));
    setOpenId(id);
  };

  if (openId)
    return (
      <div>
        <button
          onClick={() => setOpenId(null)}
          className="mb-3 min-h-11 rounded-lg border border-line bg-white px-3 text-sm font-medium hover:border-slate-400"
        >
          Back to all conversations
        </button>
        <p className="mb-3 text-xs text-muted">Read-only transcript. The customer is priya@example.com.</p>
        <div className="space-y-4">
          {msgs.map((m, i) => (
            <MessageBubble key={i} m={m} />
          ))}
        </div>
      </div>
    );

  if (!list.length)
    return (
      <div className="px-4 py-10 text-center">
        <p className="text-sm font-medium">No customer conversations yet</p>
        <p className="mt-1 text-sm text-muted">They appear here as customers talk to the AI.</p>
      </div>
    );

  return (
    <ul className="divide-y divide-line rounded-xl border border-line bg-white">
      {list.map((c) => (
        <li key={c.id}>
          <button
            onClick={() => open(c.id)}
            className="flex min-h-14 w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-surface"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{c.title}</span>
              <span className="block text-xs text-muted">
                {c.count} message{c.count === 1 ? "" : "s"} · {ago(c.updated_at)}
              </span>
            </span>
            <span className="shrink-0 text-xs font-semibold text-accent-dark">Open</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export default function MerchantView({ state, tick, onChanged }: { state: State; tick: number; onChanged: () => void }) {
  const [tab, setTab] = useState<MTab>("approvals");
  const [sum, setSum] = useState<MerchantSummary | null>(null);
  useEffect(() => {
    api<MerchantSummary>("/api/merchant/summary")
      .then(setSum)
      .catch(() => {});
  }, [tick]);

  const pending = state.approvals.filter((a) => a.status === "PENDING").length;
  const tabs: { id: MTab; label: string; badge?: number }[] = [
    { id: "approvals", label: "Approvals", badge: pending },
    { id: "skills", label: "AI skills" },
    { id: "conversations", label: "Conversations" },
    { id: "audit", label: "Audit log" },
    { id: "policy", label: "Policy" },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Acme Digital: merchant view</h2>
        <p className="text-sm text-muted">What customers asked the AI, what it did on its own, and what needs you.</p>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Waiting for you" value={String(sum?.pending ?? pending)} hint="needs a person to approve" accent={(sum?.pending ?? pending) > 0} />
        <Kpi label="Refunded today" value={money(sum?.refundedToday ?? 0)} hint="issued through PayPal" />
        <Kpi label="Handled by AI" value={String(sum?.handledByAI ?? 0)} hint="within your policy, no human" />
        <Kpi label="Blocked by policy" value={String(sum?.blockedByPolicy ?? 0)} hint="risky requests stopped" />
      </div>
      <section className="rounded-2xl border border-line bg-white shadow-sm">
        <nav className="no-scrollbar flex gap-1 overflow-x-auto border-b border-line p-1.5" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`min-h-11 shrink-0 rounded-lg px-3.5 text-sm font-medium transition ${
                tab === t.id ? "bg-blue-50 text-accent-dark" : "text-muted hover:text-ink"
              }`}
            >
              {t.label}
              {!!t.badge && <span className="ml-1.5 rounded-full bg-amber-400 px-1.5 text-xs font-bold text-ink">{t.badge}</span>}
            </button>
          ))}
        </nav>
        <div className="p-4">
          {tab === "approvals" && <ApprovalsPanel approvals={state.approvals} onDecided={onChanged} />}
          {tab === "skills" && <SkillsPanel refreshKey={tick} onChanged={onChanged} />}
          {tab === "conversations" && <ConversationsReview refreshKey={tick} />}
          {tab === "audit" && <AuditPanel refreshKey={tick} />}
          {tab === "policy" && <PolicyPanel policy={state.policy} onSaved={onChanged} />}
        </div>
      </section>
    </div>
  );
}
