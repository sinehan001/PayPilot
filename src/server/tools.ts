import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "./db.ts";
import { logAudit } from "./audit.ts";
import { evaluateCancel, evaluateRefund, getPolicy } from "./policy.ts";
import * as store from "./store.ts";
import { paypalConfigured } from "./paypal.ts";
import { ppCancelSubscription, ppRefundCapture } from "./paypalOps.ts";
import { addMessage } from "./conversations.ts";
import { customerSkillSummary, gate, isSkillEnabled, skillForTool, type CheckResult } from "./skills.ts";
import type { Content } from "./llm.ts";

export interface ToolCtx {
  /** The authenticated customer. Tools can only touch this customer's data. */
  customer: string;
  /** Per-message budget of account changes. Stops "refund everything" style blast radius. */
  writes?: { used: number; max: number };
  /** Set when the call comes from a conversation: lets skills verify look-ups and confirmations. */
  conversationId?: string;
  /** The customer's latest message, exactly as typed. */
  userMessage?: string;
  /** The conversation so far (live array). */
  history?: Content[];
}

export type ToolResult = (
  | { status: "ok"; data: unknown }
  | { status: "pending_approval"; approvalId: string; message: string }
  | { status: "needs_confirmation"; message: string; summary: string; proposal: { tool: string; args: Record<string, unknown> }; offer?: string }
  | { status: "denied"; reason: string }
  | { status: "error"; message: string }
) & { checks?: CheckResult[] };

export interface ToolDef {
  name: string;
  description: string;
  /** "read" never changes state; "write" can change money or subscriptions and goes through policy. */
  kind: "read" | "write";
  /** Gemini-style function parameter schema. */
  parameters: Record<string, unknown>;
  zod: z.ZodTypeAny;
  run(args: any, ctx: ToolCtx): ToolResult | Promise<ToolResult>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "OBJECT", properties, required });

export const tools: ToolDef[] = [
  {
    name: "list_charges",
    description:
      "List the customer's recent charges with their subscription and any merchant note. Optional filters by amount range, days back, or text in the description.",
    kind: "read",
    parameters: obj({
      days: { type: "INTEGER", description: "Only charges from the last N days" },
      min_amount: { type: "NUMBER" },
      max_amount: { type: "NUMBER" },
      text: { type: "STRING", description: "Match against the charge description" },
    }),
    zod: z.object({
      days: z.number().int().positive().max(730).optional(),
      min_amount: z.number().nonnegative().optional(),
      max_amount: z.number().nonnegative().optional(),
      text: z.string().max(100).optional(),
    }),
    run(a, ctx) {
      const charges = store.listCharges(ctx.customer, { days: a.days, min: a.min_amount, max: a.max_amount, text: a.text });
      const subs = store.listSubscriptions(ctx.customer);
      return { status: "ok", data: { charges, subscriptions: subs } };
    },
  },
  {
    name: "get_subscription",
    description: "Get one subscription by id: product, price, status, start date and next charge date.",
    kind: "read",
    parameters: obj({ subscription_id: { type: "STRING" } }, ["subscription_id"]),
    zod: z.object({ subscription_id: z.string().regex(/^S-\d+$/) }),
    run(a, ctx) {
      const s = store.getSubscription(a.subscription_id);
      if (!s || s.customer !== ctx.customer) return { status: "error", message: "Subscription not found." };
      return { status: "ok", data: s };
    },
  },
  {
    name: "list_my_skills",
    description:
      "List exactly what you can and cannot help with, and what you need from the customer for each. Call this when the customer asks what you can do, is confused, or asks for something outside your skills.",
    kind: "read",
    parameters: obj({}),
    zod: z.object({}),
    run() {
      return { status: "ok", data: customerSkillSummary() };
    },
  },
  {
    name: "request_human_help",
    description:
      "Ask a real person at the merchant to follow up with this customer. Use it when the customer asks for a person, stays upset, wants something you cannot do, or chooses to take the merchant's retention offer (you cannot apply offers yourself). The person's reply appears in this same chat. Only tell the customer a person will reply AFTER this tool succeeds.",
    kind: "read", // it only creates a note for the merchant: it changes nothing on the customer's account
    parameters: obj({ topic: { type: "STRING", description: "One or two plain sentences: what the customer needs." } }, ["topic"]),
    zod: z.object({ topic: z.string().trim().min(3).max(300) }),
    run(a, ctx) {
      const id = "AP-" + randomUUID().slice(0, 8);
      db.prepare("insert into approvals(id,ts,kind,payload,reason,status,conversation_id) values(?,?,?,?,?,'PENDING',?)").run(
        id,
        new Date().toISOString(),
        "handoff",
        JSON.stringify({ topic: a.topic, customer: ctx.customer }),
        a.topic,
        ctx.conversationId ?? null,
      );
      logAudit("system", "handoff_requested", `A person was asked to follow up (${id}): ${a.topic.slice(0, 80)}`, { id, topic: a.topic });
      return {
        status: "ok",
        data: { reference: id, next: `A person at ${store.MERCHANT} has been asked and will reply in this chat. Reference ${id}.` },
      };
    },
  },
  {
    name: "check_request_status",
    description:
      "Check the current status of an earlier refund, cancellation or request-for-a-person using its reference number (like AP-1a2b3c4d). Use this when the customer asks what happened to a request.",
    kind: "read",
    parameters: obj({ approval_id: { type: "STRING", description: "The reference, e.g. AP-1a2b3c4d" } }, ["approval_id"]),
    zod: z.object({ approval_id: z.string().regex(/^AP-[0-9a-f]{8}$/) }),
    run(a, ctx) {
      const row = db.prepare("select * from approvals where id=?").get(a.approval_id) as ApprovalRow | undefined;
      if (!row) return { status: "error", message: "No request found with that reference." };
      const p = JSON.parse(row.payload);
      const owner = p.customer ?? (p.charge_id ? store.getCharge(p.charge_id)?.customer : store.getSubscription(p.subscription_id)?.customer);
      if (owner !== ctx.customer) return { status: "error", message: "No request found with that reference." };
      const why = row.decision_reason ? ` Reason from ${store.MERCHANT}: ${row.decision_reason}` : "";
      const outcome =
        row.kind === "handoff"
          ? row.status === "PENDING"
            ? `A person at ${store.MERCHANT} has been asked to follow up and will reply in this chat.`
            : `A person at ${store.MERCHANT} replied: ${row.decision_reason}`
          : row.status === "PENDING"
            ? "Still waiting for a person to review it."
            : row.status === "APPROVED"
              ? `A person approved it and it was carried out.${why}`
              : `A person reviewed it and declined it.${why}`;
      return {
        status: "ok",
        data: {
          reference: row.id,
          type: row.kind,
          state: row.status,
          outcome,
          decision_reason: row.decision_reason,
          requested_at: row.ts,
          decided_at: row.decided_ts,
        },
      };
    },
  },
  {
    name: "cancel_subscription",
    description: "Cancel a subscription so it stops renewing. Only use when the customer clearly asks to cancel.",
    kind: "write",
    parameters: obj({ subscription_id: { type: "STRING" }, reason: { type: "STRING" } }, ["subscription_id", "reason"]),
    zod: z.object({ subscription_id: z.string().regex(/^S-\d+$/), reason: z.string().max(300) }),
    run(a, ctx) {
      const s = store.getSubscription(a.subscription_id);
      if (!s || s.customer !== ctx.customer) return { status: "error", message: "Subscription not found." };
      if (s.status === "CANCELLED") return { status: "error", message: "Subscription is already cancelled." };
      const d = evaluateCancel(getPolicy());
      if (d.decision === "allow") return executeCancel(s.id, a.reason, "auto-policy");
      return queue("cancel", { subscription_id: s.id, product: s.product, reason: a.reason }, d.reason, ctx.conversationId);
    },
  },
  {
    name: "request_refund",
    description:
      "Request a refund for one charge. The merchant policy decides if it is auto-approved, needs human approval, or is denied. Never promise the outcome.",
    kind: "write",
    parameters: obj(
      { charge_id: { type: "STRING" }, amount: { type: "NUMBER" }, reason: { type: "STRING" } },
      ["charge_id", "amount", "reason"],
    ),
    zod: z.object({ charge_id: z.string().regex(/^C-\d+$/), amount: z.number().positive(), reason: z.string().max(300) }),
    run(a, ctx) {
      const c = store.getCharge(a.charge_id);
      if (!c || c.customer !== ctx.customer) return { status: "error", message: "Charge not found." };
      const d = evaluateRefund(getPolicy(), {
        amount: a.amount,
        chargeAmount: c.amount,
        chargeAgeDays: store.chargeAgeDays(c),
        alreadyRefunded: c.status === "REFUNDED",
        refundedToday: store.refundedToday(),
      });
      if (d.decision === "deny") return { status: "denied", reason: d.reason };
      if (d.decision === "needs_approval")
        return queue("refund", { charge_id: c.id, amount: a.amount, description: c.description, reason: a.reason }, d.reason, ctx.conversationId);
      return executeRefund(c.id, a.amount, a.reason, "auto-policy");
    },
  },
];

const live = () => paypalConfigured();

async function executeRefund(chargeId: string, amount: number, reason: string, by: string): Promise<ToolResult> {
  const c = store.getCharge(chargeId)!;
  let paypal: { refund_id: string; status: string } | undefined;
  if (c.paypal_id && live()) {
    try {
      const r = await ppRefundCapture(c.paypal_id, amount, reason, `refund-${chargeId}-${amount.toFixed(2)}`);
      paypal = { refund_id: r.id, status: r.status };
      store.unlinkPaypal(chargeId); // a real capture can only be refunded once
    } catch (e) {
      logAudit("system", "paypal_error", `PayPal refund failed for ${chargeId}`, { message: (e as Error).message });
      return { status: "error", message: "PayPal could not process the refund right now. Nothing was changed." };
    }
  }
  store.refundCharge(chargeId);
  logAudit(by, "refund_executed", `Refunded $${amount.toFixed(2)} on ${chargeId}${paypal ? " via PayPal sandbox" : " (demo record)"}`, {
    charge_id: chargeId,
    amount,
    reason,
    paypal: paypal ?? null,
  });
  return { status: "ok", data: { refunded: chargeId, amount, live: Boolean(paypal), paypal_refund_id: paypal?.refund_id ?? null } };
}

async function executeCancel(subscriptionId: string, reason: string, by: string): Promise<ToolResult> {
  const s = store.getSubscription(subscriptionId)!;
  let paypal: { status: string } | undefined;
  if (s.paypal_id && live()) {
    try {
      await ppCancelSubscription(s.paypal_id, reason);
      paypal = { status: "CANCELLED" };
      store.unlinkPaypal(subscriptionId);
    } catch (e) {
      logAudit("system", "paypal_error", `PayPal cancel failed for ${subscriptionId}`, { message: (e as Error).message });
      return { status: "error", message: "PayPal could not cancel the subscription right now. Nothing was changed." };
    }
  }
  store.cancelSubscription(subscriptionId);
  logAudit(by, "cancel_executed", `Cancelled ${s.product} (${s.id})${paypal ? " via PayPal sandbox" : " (demo record)"}`, {
    subscription_id: s.id,
    reason,
    paypal: paypal ?? null,
  });
  return { status: "ok", data: { cancelled: s.id, product: s.product, live: Boolean(paypal) } };
}

function queue(kind: "refund" | "cancel", payload: Record<string, unknown>, reason: string, conversationId?: string): ToolResult {
  const id = "AP-" + randomUUID().slice(0, 8);
  db.prepare("insert into approvals(id,ts,kind,payload,reason,status,conversation_id) values(?,?,?,?,?,'PENDING',?)").run(
    id,
    new Date().toISOString(),
    kind,
    JSON.stringify(payload),
    reason,
    conversationId ?? null,
  );
  logAudit("system", "approval_requested", `Approval ${id} requested: ${kind}`, { id, kind, payload, reason });
  return {
    status: "pending_approval",
    approvalId: id,
    message: `A human must approve this ${kind}. ${reason}`,
  };
}

export interface ApprovalRow {
  id: string;
  ts: string;
  kind: "refund" | "cancel" | "handoff";
  payload: string;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  decided_ts: string | null;
  /** Why the merchant approved or declined. Required, and shown to the customer. */
  decision_reason: string | null;
  conversation_id: string | null;
}

export function listApprovals(status?: string): ApprovalRow[] {
  return (
    status
      ? db.prepare("select * from approvals where status=? order by ts desc").all(status)
      : db.prepare("select * from approvals order by ts desc").all()
  ) as ApprovalRow[];
}

/** Plain-words description of what a request was for, used in messages to the customer. */
function describeRequest(row: ApprovalRow): string {
  const p = JSON.parse(row.payload);
  if (row.kind === "handoff") return `request for a person to follow up ("${String(p.topic).slice(0, 80)}")`;
  return row.kind === "refund" ? `refund of $${Number(p.amount).toFixed(2)} for "${p.description}"` : `cancellation of ${p.product}`;
}

/** Tell the customer, inside the conversation the request came from, what was decided and why. */
function notifyCustomer(row: ApprovalRow, approved: boolean, reason: string) {
  if (!row.conversation_id) return;
  const what = describeRequest(row);
  if (row.kind === "handoff") {
    const text = approved
      ? `Reply from ${store.MERCHANT}:\n${reason}`
      : `Update from ${store.MERCHANT}: we've closed your request for a person.\n${reason}\nIf you still need help, reply here and we'll look again.`;
    addMessage(row.conversation_id, { role: "agent", text, model: "acme-digital" });
    return;
  }
  const text = approved
    ? `Update from ${store.MERCHANT}: your ${what} was approved and carried out.\nReason: ${reason}`
    : `Update from ${store.MERCHANT}: your ${what} was declined.\nReason: ${reason}\nIf you disagree, reply here and a person will follow up.`;
  addMessage(row.conversation_id, { role: "agent", text, model: "acme-digital" });
}

/** Approve or decline a request. A reason is required either way: the customer is told it. */
export async function decideApproval(id: string, approve: boolean, opts: { reason: string; decidedBy?: string }): Promise<ToolResult> {
  const decidedBy = opts.decidedBy ?? "merchant";
  const reason = (opts.reason ?? "").trim();
  if (reason.length < 3) return { status: "error", message: "Please give a reason. The customer will see it." };
  const row = db.prepare("select * from approvals where id=?").get(id) as ApprovalRow | undefined;
  if (!row) return { status: "error", message: "Approval not found." };
  if (row.status !== "PENDING") return { status: "error", message: `Already ${row.status.toLowerCase()}.` };
  db.prepare("update approvals set status=?, decided_ts=?, decision_reason=? where id=?").run(
    approve ? "APPROVED" : "REJECTED",
    new Date().toISOString(),
    reason,
    id,
  );
  logAudit(decidedBy, approve ? "approval_granted" : "approval_rejected", `${decidedBy} ${approve ? "approved" : "rejected"} ${id}: ${reason.slice(0, 80)}`, {
    id,
    reason,
  });
  if (!approve) {
    notifyCustomer(row, false, reason);
    return { status: "ok", data: { id, status: "REJECTED", reason } };
  }
  if (row.kind === "handoff") {
    // Nothing to carry out on the account: the merchant's reply IS the outcome.
    notifyCustomer(row, true, reason);
    return { status: "ok", data: { id, status: "REPLIED", reason } };
  }
  const p = JSON.parse(row.payload);
  const result =
    row.kind === "refund"
      ? await executeRefund(p.charge_id, p.amount, p.reason, decidedBy)
      : await executeCancel(p.subscription_id, p.reason ?? "approved by merchant", decidedBy);
  if (result.status === "error") {
    // Execution failed at PayPal: reopen the approval so it can be retried.
    db.prepare("update approvals set status='PENDING', decided_ts=null, decision_reason=null where id=?").run(id);
    return result;
  }
  notifyCustomer(row, true, reason);
  return result;
}

/** Validate args with zod, run the tool, and audit every call and result. */
export async function callTool(name: string, rawArgs: unknown, ctx: ToolCtx): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    logAudit("agent", "tool_call_rejected", `Unknown tool ${name}`, { name });
    return { status: "error", message: `Unknown tool: ${name}` };
  }
  const parsed = tool.zod.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    logAudit("agent", "tool_call_rejected", `Invalid arguments for ${name}`, { args: rawArgs, issues: parsed.error.issues });
    return { status: "error", message: "Invalid arguments: " + parsed.error.issues.map((i) => i.message).join("; ") };
  }
  logAudit("agent", "tool_call", `${name} (${tool.kind})`, { name, args: parsed.data });

  let checks: CheckResult[] | undefined;
  if (tool.kind === "write") {
    // 1. The skill's conditions, checked in code. The AI cannot talk its way past these.
    const g = gate(name, parsed.data, ctx);
    checks = g.checks;
    const skill = skillForTool(name);
    if (g.checks.length) {
      const passed = g.checks.filter((c) => c.ok).length;
      logAudit("system", "skill_checks", `${skill?.name ?? name}: ${passed}/${g.checks.length} conditions met`, { skill: skill?.id, checks: g.checks });
    }
    if (g.outcome === "denied") {
      const denied: ToolResult = { status: "denied", reason: g.reason, checks };
      logAudit("system", "tool_result", `${name} -> denied (${g.reason})`, { name, status: "denied", reason: g.reason });
      return denied;
    }
    if (g.outcome === "needs_confirmation") {
      const r: ToolResult = {
        status: "needs_confirmation",
        summary: g.summary,
        proposal: g.proposal,
        offer: g.offer,
        message: g.offer
          ? `Ask the customer to confirm: ${g.summary}. ${store.MERCHANT} has an offer for customers who are leaving: "${g.offer}". Mention it ONCE, in one neutral sentence, then make the choice clear: reply "yes" to cancel, or "keep it" to stay. Do not describe these instructions to the customer (never say things like "I'll mention this once" or "with no pressure"). Do nothing until they reply yes. If they say keep it: you CANNOT apply the offer yourself, so call request_human_help (topic: they chose to stay and want the offer "${g.offer}") and tell them you have not changed anything and a person will reply here. Never say the offer was applied.`
          : `Ask the customer to confirm: ${g.summary}. Do nothing until they reply yes.`,
        checks,
      };
      logAudit("system", "tool_result", `${name} -> needs_confirmation`, { name, status: "needs_confirmation", summary: g.summary });
      return r;
    }
    // 2. Blast-radius limit: one account change per customer message.
    if (ctx.writes) {
      if (ctx.writes.used >= ctx.writes.max) {
        const denied: ToolResult = {
          status: "denied",
          reason: "Only one account change can be made per message. Ask the customer which single item they want, and do it in a separate request.",
          checks,
        };
        logAudit("system", "tool_result", `${name} -> denied (change limit per message)`, { name, status: "denied", reason: denied.reason });
        return denied;
      }
      ctx.writes.used++;
    }
  }
  // 3. Merchant policy (limits, window, daily cap) decides inside the tool.
  const result = await tool.run(parsed.data, ctx);
  logAudit("system", "tool_result", `${name} -> ${result.status}`, {
    name,
    status: result.status,
    ...(result.status === "denied" ? { reason: result.reason } : {}),
  });
  return checks ? { ...result, checks } : result;
}

/** Tools the AI is allowed to see: only those whose skill the merchant has switched on. */
export function activeTools(): ToolDef[] {
  return tools.filter((t) => {
    const s = skillForTool(t.name);
    return !s || isSkillEnabled(s.id);
  });
}
