import { useEffect, useState } from "react";
import { api, type Approval, type AuditResp, type Policy, type State } from "./api";

const money = (n: number) => `$${n.toFixed(2)}`;
const time = (ts: string) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function Badge({ children, tone }: { children: React.ReactNode; tone: "green" | "amber" | "red" | "blue" | "gray" }) {
  const cls = {
    green: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    amber: "bg-amber-50 text-amber-800 ring-amber-200",
    red: "bg-red-50 text-red-700 ring-red-200",
    blue: "bg-blue-50 text-accent-dark ring-blue-200",
    gray: "bg-slate-100 text-slate-600 ring-slate-200",
  }[tone];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${cls}`}>{children}</span>;
}

function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="mt-1 text-sm text-muted">{hint}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export function AccountPanel({ state }: { state: State }) {
  return (
    <div className="space-y-5">
      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Subscriptions</h3>
        <ul className="divide-y divide-line rounded-xl border border-line bg-white">
          {state.subscriptions.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{s.product}</p>
                <p className="text-xs text-muted">
                  {money(s.amount)} {s.interval}
                  {s.next_charge ? ` · renews ${s.next_charge}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <Badge tone={s.status === "ACTIVE" ? "green" : "gray"}>{s.status === "ACTIVE" ? "Active" : "Cancelled"}</Badge>
                {s.paypal_id && <Badge tone="blue">Live PayPal sandbox</Badge>}
              </div>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Recent charges</h3>
        <ul className="divide-y divide-line rounded-xl border border-line bg-white">
          {state.charges.map((c) => (
            <li key={c.id} className="px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{c.description}</p>
                  <p className="text-xs text-muted">
                    {c.date} · {c.id}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className={`text-sm font-semibold ${c.status === "REFUNDED" ? "text-muted line-through" : ""}`}>{money(c.amount)}</span>
                  <div className="flex gap-1">
                    {c.status === "REFUNDED" && <Badge tone="gray">Refunded</Badge>}
                    {c.paypal_id && <Badge tone="blue">Live PayPal sandbox</Badge>}
                  </div>
                </div>
              </div>
              {c.note && (
                <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200">
                  <span className="font-semibold">Untrusted note on this charge:</span> "{c.note}"{" "}
                  <span className="text-amber-700">The agent treats this as data and ignores it.</span>
                </p>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

const QUICK_REPLIES = [
  "Thanks for staying with us. We've applied your offer.",
  "We're looking into this and will update you here today.",
  "Thanks for flagging this. We've fixed it on our side.",
];

const QUICK_REASONS = [
  "Verified as a duplicate charge",
  "Service was not delivered as described",
  "Outside our refund policy",
  "The service was delivered as described",
  "We need more information first",
];

export function ApprovalsPanel({ approvals, onDecided }: { approvals: Approval[]; onDecided: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const pending = approvals.filter((a) => a.status === "PENDING");
  const done = approvals.filter((a) => a.status !== "PENDING");

  const decide = async (id: string, action: "approve" | "reject") => {
    setBusy(id);
    setErr(null);
    try {
      await api(`/api/approvals/${id}/${action}`, { method: "POST", body: JSON.stringify({ reason: (reasons[id] ?? "").trim() }) });
      setReasons((r) => {
        const { [id]: _drop, ...rest } = r;
        return rest;
      });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
      onDecided();
    }
  };

  const describe = (a: Approval) => {
    const p = JSON.parse(a.payload);
    if (a.kind === "handoff") return `Customer needs a person: ${p.topic}`;
    return a.kind === "refund" ? `Refund ${money(p.amount)}: ${p.description}` : `Cancel ${p.product}`;
  };

  if (!approvals.length)
    return <Empty title="Nothing waiting for approval" hint="Refunds above the auto-limit will appear here for a human to approve." />;

  return (
    <div className="space-y-4">
      {err && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200">{err}</p>}
      {pending.map((a) => (
        <div key={a.id} className="rounded-xl border-2 border-amber-300 bg-amber-50/60 p-4">
          <div className="flex items-center justify-between">
            <Badge tone="amber">{a.kind === "handoff" ? "Customer needs a person" : "Needs your approval"}</Badge>
            <span className="text-xs text-muted">{a.id}</span>
          </div>
          <p className="mt-2 text-sm font-semibold">{describe(a)}</p>
          {a.kind !== "handoff" && <p className="mt-1 text-sm text-muted">{a.reason}</p>}
          <label className="mt-3 block">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">
              {a.kind === "handoff" ? "Your reply (appears in the customer's chat)" : "Your reason (the customer will see this)"}
            </span>
            <textarea
              rows={2}
              maxLength={300}
              value={reasons[a.id] ?? ""}
              onChange={(e) => setReasons((r) => ({ ...r, [a.id]: e.target.value }))}
              placeholder={a.kind === "handoff" ? "Write your reply to the customer" : "Explain your decision in a sentence or two"}
              className="mt-1 w-full resize-none rounded-lg border border-line bg-white px-3 py-2 text-base sm:text-sm"
            />
          </label>
          <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Quick reasons">
            {(a.kind === "handoff" ? QUICK_REPLIES : QUICK_REASONS).map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => setReasons((r) => ({ ...r, [a.id]: q }))}
                className="rounded-full border border-line bg-white px-3 py-1.5 text-xs text-ink hover:border-accent hover:text-accent"
              >
                {q}
              </button>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              onClick={() => decide(a.id, "approve")}
              disabled={busy === a.id || (reasons[a.id] ?? "").trim().length < 3}
              className="min-h-11 rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-white hover:bg-accent-dark disabled:opacity-40"
            >
              {busy === a.id ? "Working..." : a.kind === "handoff" ? "Send reply" : "Approve"}
            </button>
            {a.kind !== "handoff" && (
              <button
                onClick={() => decide(a.id, "reject")}
                disabled={busy === a.id || (reasons[a.id] ?? "").trim().length < 3}
                className="min-h-11 rounded-lg border border-line bg-white px-5 py-2 text-sm font-semibold text-ink hover:border-slate-400 disabled:opacity-40"
              >
                Reject
              </button>
            )}
            {(reasons[a.id] ?? "").trim().length < 3 && (
              <span className="text-xs text-muted">{a.kind === "handoff" ? "Write a reply to send." : "Add a reason to approve or reject."}</span>
            )}
          </div>
        </div>
      ))}
      {done.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">History</h3>
          <ul className="divide-y divide-line rounded-xl border border-line bg-white">
            {done.map((a) => (
              <li key={a.id} className="px-4 py-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate">{describe(a)}</span>
                  <Badge tone={a.status === "APPROVED" ? "green" : "gray"}>
                    {a.kind === "handoff" ? "Replied" : a.status === "APPROVED" ? "Approved" : "Rejected"}
                  </Badge>
                </div>
                {a.decision_reason && (
                  <p className="mt-1 text-xs text-muted">
                    {a.kind === "handoff" ? "Your reply: " : "Reason given to the customer: "}
                    {a.decision_reason}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

const AUDIT_TONE: Record<string, "green" | "amber" | "red" | "blue" | "gray"> = {
  refund_executed: "green",
  cancel_executed: "green",
  approval_requested: "amber",
  approval_granted: "green",
  approval_rejected: "gray",
  tool_call: "blue",
  tool_result: "gray",
  tool_call_rejected: "red",
  paypal_error: "red",
  agent_error: "red",
  policy_changed: "amber",
  skill_checks: "blue",
  skill_toggled: "amber",
  tone_flag: "amber",
  reply_corrected: "red",
};

export function AuditPanel({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<AuditResp | null>(null);
  useEffect(() => {
    api<AuditResp>("/api/audit").then(setData).catch(() => {});
  }, [refreshKey]);
  if (!data) return <Empty title="Loading audit log" hint="One moment." />;
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <Badge tone={data.chain.ok ? "green" : "red"}>
          {data.chain.ok ? `Tamper-evident chain verified (${data.chain.count})` : `Chain broken at entry ${data.chain.brokenAt}`}
        </Badge>
        <span className="text-xs text-muted">Newest first</span>
      </div>
      {data.rows.length === 0 ? (
        <Empty title="No activity yet" hint="Every message, tool call and decision is recorded here." />
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-white">
          {data.rows.map((r) => (
            <li key={r.id} className="px-4 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <Badge tone={AUDIT_TONE[r.type] ?? "gray"}>{r.type.replace(/_/g, " ")}</Badge>
                <span className="text-xs text-muted">
                  {r.actor} · {time(r.ts)}
                </span>
              </div>
              <p className="mt-1 break-words text-sm">{r.summary}</p>
              <p className="mt-0.5 font-mono text-[10px] text-slate-400">#{r.id} {r.hash.slice(0, 16)}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export function PolicyPanel({ policy, onSaved }: { policy: Policy; onSaved: () => void }) {
  const [p, setP] = useState(policy);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    setP(policy);
  }, [policy]);

  const num = (key: keyof Policy, label: string, hint: string, prefix = "") => (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <span className="mt-0.5 block text-xs text-muted">{hint}</span>
      <div className="relative mt-1.5">
        {prefix && <span className="absolute left-3 top-2.5 text-sm text-muted">{prefix}</span>}
        <input
          type="number"
          min={0}
          value={p[key] as number}
          onChange={(e) => setP({ ...p, [key]: Number(e.target.value) })}
          className={`w-full rounded-lg border border-line bg-white py-2.5 pr-3 text-base sm:text-sm ${prefix ? "pl-7" : "pl-3"}`}
        />
      </div>
    </label>
  );

  const save = async () => {
    setMsg(null);
    try {
      await api("/api/policy", { method: "PUT", body: JSON.stringify(p) });
      setMsg("Saved. The agent follows this immediately.");
      onSaved();
    } catch (e: any) {
      setMsg(e.message);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        These rules are enforced in code, not in the AI prompt. The agent cannot talk its way past them.
      </p>
      {num("autoRefundLimit", "Auto-refund limit", "Refunds up to this amount are approved automatically.", "$")}
      {num("maxRefund", "Hard refund cap", "Anything above this is always denied.", "$")}
      {num("refundWindowDays", "Refund window (days)", "Older charges can't be refunded by the agent.")}
      {num("dailyRefundCap", "Daily auto-refund cap", "Total auto-refunded per day.", "$")}
      <label className="flex items-center justify-between gap-3 rounded-lg border border-line bg-white px-3 py-2.5">
        <span>
          <span className="block text-sm font-medium">Let customers cancel without approval</span>
          <span className="block text-xs text-muted">If off, cancellations need a human.</span>
        </span>
        <input
          type="checkbox"
          checked={p.allowCustomerCancel}
          onChange={(e) => setP({ ...p, allowCustomerCancel: e.target.checked })}
          className="h-5 w-5 accent-[var(--color-accent)]"
        />
      </label>
      <div className="rounded-xl border border-line bg-surface p-3.5">
        <p className="text-sm font-semibold">Keeping customers who want to leave</p>
        <p className="mt-0.5 text-xs text-muted">
          The AI never brings up cancelling or refunds on its own. But the moment a customer asks to cancel, it can try, warmly and once, to
          keep them, using their real account facts plus the lines below. It never delays or blocks the cancellation.
        </p>
        <label className="mt-3 block">
          <span className="text-sm font-medium">Your offer (optional)</span>
          <input
            type="text"
            maxLength={200}
            value={p.retentionOffer ?? ""}
            onChange={(e) => setP({ ...p, retentionOffer: e.target.value })}
            placeholder="For example: 20% off your next 3 months"
            className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2.5 text-base sm:text-sm"
          />
        </label>
        <label className="mt-3 block">
          <span className="text-sm font-medium">Why customers stay (optional, true facts only)</span>
          <input
            type="text"
            maxLength={240}
            value={p.retentionPitch ?? ""}
            onChange={(e) => setP({ ...p, retentionPitch: e.target.value })}
            placeholder="For example: Members get unlimited workouts and a free coaching call"
            className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2.5 text-base sm:text-sm"
          />
        </label>
        <p className="mt-2 text-xs text-muted">The AI cannot apply an offer itself. If the customer takes it, you get a request to apply it and reply.</p>
      </div>
      <div className="flex items-center gap-3">
        <button onClick={save} className="min-h-11 rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-white hover:bg-accent-dark">
          Save policy
        </button>
        {msg && <span className="text-sm text-muted">{msg}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Customer-facing, read-only view of the requests that needed a person to review them.

export function RequestsPanel({ approvals }: { approvals: Approval[] }) {
  if (!approvals.length)
    return (
      <Empty
        title="No requests yet"
        hint="When a refund or cancellation needs a person at Acme Digital to review it, you can follow it here."
      />
    );
  const status = (a: Approval) =>
    a.status === "PENDING"
      ? { text: "With Acme Digital for review", tone: "amber" as const }
      : a.status === "APPROVED"
        ? { text: "Approved and completed", tone: "green" as const }
        : { text: "Declined", tone: "gray" as const };
  return (
    <div className="space-y-3">
      <ul className="space-y-3">
        {approvals.map((a) => {
          const p = JSON.parse(a.payload);
          const s = status(a);
          return (
            <li key={a.id} className="rounded-xl border border-line bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">
                    {a.kind === "handoff" ? "Request for a person" : a.kind === "refund" ? `Refund ${money(p.amount)}` : "Cancellation"}
                  </p>
                  <p className="truncate text-sm text-muted">{a.kind === "handoff" ? p.topic : a.kind === "refund" ? p.description : p.product}</p>
                </div>
                <Badge tone={s.tone}>{a.kind === "handoff" && a.status === "APPROVED" ? "Replied" : s.text}</Badge>
              </div>
              {a.status !== "PENDING" && a.decision_reason && (
                <p className="mt-2 rounded-lg bg-surface px-3 py-2 text-sm">
                  <span className="font-semibold">{a.kind === "handoff" ? "Reply from Acme Digital: " : "Reason from Acme Digital: "}</span>
                  {a.decision_reason}
                </p>
              )}
              <p className="mt-2 text-xs text-muted">
                Reference {a.id} · {time(a.ts)}
              </p>
            </li>
          );
        })}
      </ul>
      {approvals.some((a) => a.status === "PENDING") && (
        <p className="rounded-lg bg-blue-50 px-3 py-2 text-xs text-accent-dark ring-1 ring-blue-200">
          Demo tip: switch to the Merchant view (top right) to review and approve this request as Acme Digital.
        </p>
      )}
    </div>
  );
}
