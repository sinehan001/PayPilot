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

export function ApprovalsPanel({ approvals, onDecided }: { approvals: Approval[]; onDecided: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const pending = approvals.filter((a) => a.status === "PENDING");
  const done = approvals.filter((a) => a.status !== "PENDING");

  const decide = async (id: string, action: "approve" | "reject") => {
    setBusy(id);
    setErr(null);
    try {
      await api(`/api/approvals/${id}/${action}`, { method: "POST" });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
      onDecided();
    }
  };

  const describe = (a: Approval) => {
    const p = JSON.parse(a.payload);
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
            <Badge tone="amber">Needs your approval</Badge>
            <span className="text-xs text-muted">{a.id}</span>
          </div>
          <p className="mt-2 text-sm font-semibold">{describe(a)}</p>
          <p className="mt-1 text-sm text-muted">{a.reason}</p>
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => decide(a.id, "approve")}
              disabled={busy === a.id}
              className="min-h-11 rounded-lg bg-accent px-5 py-2 text-sm font-semibold text-white hover:bg-accent-dark disabled:opacity-50"
            >
              {busy === a.id ? "Working..." : "Approve"}
            </button>
            <button
              onClick={() => decide(a.id, "reject")}
              disabled={busy === a.id}
              className="min-h-11 rounded-lg border border-line bg-white px-5 py-2 text-sm font-semibold text-ink hover:border-slate-400 disabled:opacity-50"
            >
              Reject
            </button>
          </div>
        </div>
      ))}
      {done.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">History</h3>
          <ul className="divide-y divide-line rounded-xl border border-line bg-white">
            {done.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <span className="min-w-0 truncate">{describe(a)}</span>
                <Badge tone={a.status === "APPROVED" ? "green" : "gray"}>{a.status === "APPROVED" ? "Approved" : "Rejected"}</Badge>
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
                  <p className="text-sm font-semibold">{a.kind === "refund" ? `Refund ${money(p.amount)}` : "Cancellation"}</p>
                  <p className="truncate text-sm text-muted">{a.kind === "refund" ? p.description : p.product}</p>
                </div>
                <Badge tone={s.tone}>{s.text}</Badge>
              </div>
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
