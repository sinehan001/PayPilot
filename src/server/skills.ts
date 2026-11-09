import { randomUUID } from "node:crypto";
import { db } from "./db.ts";
import type { Content } from "./llm.ts";
import { getPolicy } from "./policy.ts";
import * as store from "./store.ts";
import { MERCHANT } from "./store.ts";

/**
 * Skills: named capabilities the AI is given. Each skill has a playbook (what to do),
 * conditions the SYSTEM checks in code before anything changes (not the AI's say-so),
 * and what to do when a condition fails. The merchant can switch each skill on or off.
 */

export interface CheckResult {
  id: string;
  label: string;
  ok: boolean;
  detail?: string;
  /** True when the check does not apply (for example, no conversation in a unit test). */
  skipped?: boolean;
}

export interface SkillCtx {
  customer: string;
  conversationId?: string;
  /** The customer's latest message, exactly as typed. Used to verify explicit confirmation. */
  userMessage?: string;
  /** The conversation so far, to verify the AI looked things up before acting. */
  history?: Content[];
}

interface CheckRun {
  ok: boolean;
  detail?: string;
  skip?: boolean;
}

export interface SkillCheck {
  id: string;
  label: string;
  run(args: any, ctx: SkillCtx): CheckRun;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  whenToUse: string;
  /** "conduct" skills have no tools: they set how the AI behaves with people. */
  kind: "read" | "write" | "conduct";
  /** Locked skills are always on and cannot be switched off by the merchant. */
  locked?: boolean;
  tools: string[];
  playbook: string[];
  checks: SkillCheck[];
  /** Write skills need the customer to say yes in a separate message before anything happens. */
  requiresConfirmation: boolean;
  escalation: string;
}

// --- helpers used by checks ----------------------------------------------------------------

function seenIds(history?: Content[]) {
  const charges = new Set<string>();
  const subs = new Set<string>();
  for (const c of history ?? [])
    for (const p of c.parts) {
      const r = p.functionResponse?.response?.result;
      if (r?.status !== "ok") continue;
      const d = r.data;
      d?.charges?.forEach((x: any) => charges.add(x.id));
      d?.subscriptions?.forEach((x: any) => subs.add(x.id));
      if (p.functionResponse.name === "get_subscription" && d?.id) subs.add(d.id);
    }
  return { charges, subs };
}

const money = (n: number) => `$${Number(n).toFixed(2)}`;
const reasonOk = (a: any) => ({ ok: typeof a.reason === "string" && a.reason.trim().length >= 3, detail: "Say why the customer wants this." });

// --- the skills ---------------------------------------------------------------------------

export const skills: Skill[] = [
  {
    id: "conduct",
    name: "Stay calm and in scope",
    description: "How the AI treats every customer: patient and kind, honest about what it can and cannot do, and always within billing.",
    whenToUse: "Every message, especially when the customer is upset, rude, confused or asks for something outside billing.",
    kind: "conduct",
    locked: true,
    tools: ["list_my_skills"],
    playbook: [
      "Stay calm and kind even if the customer is angry, rude or scolding. Never argue, never insult, never be sarcastic, never lecture.",
      "Acknowledge the feeling in one short sentence (for example: I understand this is frustrating), then move straight to fixing the problem.",
      "Be honest and specific about what you can do. If the customer asks what you can do, or asks for something you cannot do, call list_my_skills and explain from its answer. Never invent abilities.",
      "Never promise a refund or any result. Explain that the merchant's policy and a person decide, and say what happens next.",
      "You only help with Acme Digital billing. For anything else, say so kindly and list what you can help with.",
      "If the customer stays upset or needs something you cannot do, offer to have a person at Acme Digital follow up, and stop there.",
    ],
    checks: [],
    requiresConfirmation: false,
    escalation: "Offer a person at Acme Digital. Never match the customer's tone.",
  },
  {
    id: "explain_charges",
    name: "Explain a charge",
    description: "Tell the customer what a charge is, in plain words.",
    whenToUse: "The customer asks why they were charged, what something is, or what they are paying for.",
    kind: "read",
    tools: ["list_charges", "get_subscription"],
    playbook: [
      "Look up the charges with list_charges, filtering by the amount, date or name the customer gave.",
      "Explain what it is, when it was charged, when it renews, and the yearly cost.",
      "Only state what the tools returned. If nothing matches, say so and ask for the amount or date.",
    ],
    checks: [],
    requiresConfirmation: false,
    escalation: "If no charge matches, ask the customer for the amount or date. Never guess.",
  },
  {
    id: "track_requests",
    name: "Track a request",
    description: "Report the status of an earlier refund or cancellation request.",
    whenToUse: "The customer asks what happened to a request, or for an update.",
    kind: "read",
    tools: ["check_request_status"],
    playbook: [
      "Use check_request_status with the reference number from the earlier reply.",
      "Report exactly the state and outcome the tool returns: waiting, approved, or declined.",
    ],
    checks: [],
    requiresConfirmation: false,
    escalation: "If there is no reference number, ask the customer for it.",
  },
  {
    id: "cancel_subscription",
    name: "Cancel a subscription",
    description: "Stop a subscription from renewing.",
    whenToUse: "The customer clearly asks to cancel one specific subscription.",
    kind: "write",
    tools: ["cancel_subscription"],
    playbook: [
      "Look the subscription up first (list_charges) so you are sure which one it is.",
      "Call cancel_subscription with its id and the customer's reason.",
      "If the result says needs_confirmation, tell the customer exactly what will happen and ask them to confirm. Then WAIT.",
      "Only after the customer replies yes, call cancel_subscription again with the same id.",
    ],
    checks: [
      {
        id: "subscription_owned",
        label: "The subscription exists and belongs to this customer",
        run: (a, ctx) => {
          const s = store.getSubscription(a.subscription_id);
          return { ok: Boolean(s && s.customer === ctx.customer), detail: "No such subscription on this account." };
        },
      },
      {
        id: "subscription_active",
        label: "The subscription is still active",
        run: (a) => {
          const s = store.getSubscription(a.subscription_id);
          return { ok: s?.status === "ACTIVE", detail: "That subscription is already cancelled." };
        },
      },
      {
        id: "looked_up_first",
        label: "The AI looked it up in this conversation first",
        run: (a, ctx) =>
          ctx.history ? { ok: seenIds(ctx.history).subs.has(a.subscription_id), detail: "Look the subscription up first, then try again." } : { ok: true, skip: true },
      },
      { id: "reason_given", label: "A reason is recorded", run: (a) => reasonOk(a) },
    ],
    requiresConfirmation: true,
    escalation: "Explain it simply and ask the customer which subscription they mean. Do not retry the same call.",
  },
  {
    id: "refund_charge",
    name: "Refund a charge",
    description: "Request a refund for one charge. Merchant policy decides if it is automatic, needs a person, or is declined.",
    whenToUse: "The customer clearly asks for money back on one specific charge.",
    kind: "write",
    tools: ["request_refund"],
    playbook: [
      "Look the charge up first (list_charges) and confirm which one the customer means.",
      "Call request_refund with the charge id, the amount, and the customer's reason.",
      "If the result says needs_confirmation, tell the customer exactly what will be refunded and ask them to confirm. Then WAIT.",
      "Only after the customer replies yes, call request_refund again with the same charge id and amount.",
      "Report the final result exactly: refunded, sent to a person for approval, or declined by policy.",
    ],
    checks: [
      {
        id: "charge_owned",
        label: "The charge exists and belongs to this customer",
        run: (a, ctx) => {
          const c = store.getCharge(a.charge_id);
          return { ok: Boolean(c && c.customer === ctx.customer), detail: "No such charge on this account." };
        },
      },
      {
        id: "not_refunded",
        label: "The charge has not already been refunded",
        run: (a) => {
          const c = store.getCharge(a.charge_id);
          return { ok: c?.status === "COMPLETED", detail: "That charge was already refunded." };
        },
      },
      {
        id: "amount_valid",
        label: "The amount is above $0 and not more than the original charge",
        run: (a) => {
          const c = store.getCharge(a.charge_id);
          return { ok: Boolean(c) && a.amount > 0 && a.amount <= (c?.amount ?? 0), detail: c ? `The amount must be between $0.01 and ${money(c.amount)}.` : "No such charge." };
        },
      },
      {
        id: "looked_up_first",
        label: "The AI looked it up in this conversation first",
        run: (a, ctx) =>
          ctx.history ? { ok: seenIds(ctx.history).charges.has(a.charge_id), detail: "Look the charge up first, then try again." } : { ok: true, skip: true },
      },
      { id: "reason_given", label: "A reason is recorded", run: (a) => reasonOk(a) },
    ],
    requiresConfirmation: true,
    escalation: "Explain it simply and ask which charge they mean. Do not retry the same call.",
  },
];

export const skillForTool = (tool: string) => skills.find((s) => s.tools.includes(tool));

// --- merchant on/off switches --------------------------------------------------------------

function enabledMap(): Record<string, boolean> {
  const r = db.prepare("select value from settings where key='skills_enabled'").get() as { value: string } | undefined;
  return r ? JSON.parse(r.value) : {};
}
export const isSkillEnabled = (id: string) => skills.find((s) => s.id === id)?.locked === true || enabledMap()[id] !== false;
export function setSkillEnabled(id: string, enabled: boolean) {
  const m = { ...enabledMap(), [id]: enabled };
  db.prepare("insert into settings(key,value) values('skills_enabled',?) on conflict(key) do update set value=excluded.value").run(JSON.stringify(m));
}
export const enabledSkills = () => skills.filter((s) => isSkillEnabled(s.id));

/** What the merchant sees on the Skills tab: no code, just the rules in plain words. */
export function describeSkills() {
  return skills.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    whenToUse: s.whenToUse,
    kind: s.kind,
    locked: Boolean(s.locked),
    tools: s.tools,
    enabled: isSkillEnabled(s.id),
    conditions: s.kind === "conduct" ? s.playbook : [
      ...s.checks.map((c) => c.label),
      ...(s.requiresConfirmation ? ["The customer explicitly says yes in a separate message"] : []),
      ...(s.kind === "write" ? ["Your policy decides: do it, send it to a person, or decline"] : []),
    ],
    escalation: s.escalation,
  }));
}

/**
 * What the AI may tell a customer about itself. Built from the skills that are switched on right now,
 * so the answer is always accurate and never invented.
 */
export function customerSkillSummary() {
  const policy = getPolicy();
  const needs: Record<string, string> = {
    explain_charges: "Nothing special. Just ask about a charge, ideally with the amount or date.",
    track_requests: "The reference number from my earlier message (it looks like AP-1a2b3c4d).",
    cancel_subscription: "Which subscription, a reason, and your yes to confirm. I can cancel it right away once you confirm.",
    refund_charge: `Which charge, why you want it back, and your yes to confirm. Refunds up to $${policy.autoRefundLimit.toFixed(0)} within ${policy.refundWindowDays} days can be quick; anything larger goes to a person at ${MERCHANT} who decides and tells you why.`,
  };
  return {
    i_can_help_with: enabledSkills()
      .filter((s) => s.kind !== "conduct")
      .map((s) => ({ what: s.name, description: s.description, what_i_need_from_you: needs[s.id] ?? "Just ask." })),
    i_cannot: [
      "Change your plan, price or payment method",
      "Promise a refund: the merchant's policy and a person decide, and you will be told the reason",
      "See or change anyone else's account",
      `Help with anything outside ${MERCHANT} billing`,
    ],
    if_you_need_more: `I can pass this to a person at ${MERCHANT}.`,
  };
}

// --- the gate every write goes through -----------------------------------------------------

export type GateResult =
  | { outcome: "proceed"; checks: CheckResult[] }
  | { outcome: "denied"; reason: string; checks: CheckResult[] }
  | { outcome: "needs_confirmation"; checks: CheckResult[]; summary: string; proposal: { tool: string; args: Record<string, unknown> } };

const AFFIRM = /^\s*(yes|yep|yeah|yup|y|ok|okay|sure|confirm|confirmed|go ahead|do it|please do|proceed|correct|that's right)\b/i;

function currentTurn(conversationId: string): number {
  return (db.prepare("select count(*) c from messages where conversation_id=? and role='user'").get(conversationId) as { c: number }).c;
}

function proposalFor(tool: string, a: any): { key: string; summary: string; args: Record<string, unknown> } {
  if (tool === "request_refund") {
    const c = store.getCharge(a.charge_id);
    return {
      key: `refund:${a.charge_id}:${Number(a.amount).toFixed(2)}`,
      summary: `Refund ${money(a.amount)} for "${c?.description ?? a.charge_id}" (${a.charge_id})`,
      args: { charge_id: a.charge_id, amount: a.amount, reason: a.reason },
    };
  }
  const s = store.getSubscription(a.subscription_id);
  return {
    key: `cancel:${a.subscription_id}`,
    summary: `Cancel ${s?.product ?? a.subscription_id} (${s ? `${money(s.amount)} ${s.interval}` : a.subscription_id}) so it stops renewing`,
    args: { subscription_id: a.subscription_id, reason: a.reason },
  };
}

export function gate(tool: string, args: any, ctx: SkillCtx): GateResult {
  const skill = skillForTool(tool);
  if (!skill) return { outcome: "proceed", checks: [] };

  if (!isSkillEnabled(skill.id))
    return {
      outcome: "denied",
      reason: `The merchant has turned off the "${skill.name}" skill, so I can't do this.`,
      checks: [{ id: "skill_enabled", label: "The skill is switched on by the merchant", ok: false, detail: "Switched off." }],
    };

  const checks: CheckResult[] = [{ id: "skill_enabled", label: "The skill is switched on by the merchant", ok: true }];
  for (const c of skill.checks) {
    const r = c.run(args, ctx);
    checks.push(r.skip ? { id: c.id, label: c.label, ok: true, skipped: true } : { id: c.id, label: c.label, ok: r.ok, detail: r.ok ? undefined : r.detail });
  }
  const failed = checks.find((c) => !c.ok);
  if (failed) return { outcome: "denied", reason: failed.detail ?? failed.label, checks };

  if (skill.requiresConfirmation && ctx.conversationId) {
    const p = proposalFor(tool, args);
    const turn = currentTurn(ctx.conversationId);
    const row = db
      .prepare("select * from proposals where conversation_id=? and key=? and status='PENDING' order by created_at desc limit 1")
      .get(ctx.conversationId, p.key) as { id: string; turn: number } | undefined;

    if (row && turn > row.turn && AFFIRM.test(ctx.userMessage ?? "")) {
      db.prepare("update proposals set status='CONFIRMED' where id=?").run(row.id);
      checks.push({ id: "customer_confirmed", label: "The customer explicitly confirmed in a separate message", ok: true });
      return { outcome: "proceed", checks };
    }
    if (!row)
      db.prepare("insert into proposals(id,conversation_id,tool,key,args,turn,status,created_at) values(?,?,?,?,?,?,?,?)").run(
        "PR-" + randomUUID().slice(0, 8),
        ctx.conversationId,
        tool,
        p.key,
        JSON.stringify(p.args),
        turn,
        "PENDING",
        new Date().toISOString(),
      );
    checks.push({ id: "customer_confirmed", label: "The customer explicitly confirms in a separate message", ok: false, detail: "Waiting for the customer to say yes." });
    return { outcome: "needs_confirmation", checks, summary: p.summary, proposal: { tool, args: p.args } };
  }
  return { outcome: "proceed", checks };
}
