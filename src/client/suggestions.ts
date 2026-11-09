import { CANCEL_INTENT, REFUND_INTENT } from "../server/intent.ts";
import { detectTone } from "../server/tone.ts";
import type { AgentEvent, SkillInfo, State } from "./api";

/**
 * Dynamic suggested questions, built to protect the merchant as well as help the customer.
 *
 * They are built from the live account and the conversation, so they name real amounts and
 * subscriptions, follow where the chat is, respect the skills the merchant switched on, and never
 * repeat something already asked.
 *
 * Merchant rule: the app NEVER pushes cancelling or refunds. A "Cancel X" button on screen plants the
 * idea. Those options appear only after the customer has said something that signals the intent,
 * and they are never hidden or made hard to reach once asked for.
 */

export interface Suggestion {
  label: string;
  text: string;
}
export interface Turn {
  role: "user" | "agent";
  text: string;
  events?: AgentEvent[];
  model?: string;
}

const money = (n: number) => `$${n.toFixed(2)}`;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9$.]+/g, " ").trim();
const ageDays = (d: string) => Math.floor((Date.now() - new Date(d + "T00:00:00Z").getTime()) / 86_400_000);
const firstWord = (product: string) => product.split(" ")[0];
/** Rotate so the same items do not lead every time. */
const rotate = <T,>(arr: T[], k: number): T[] => (arr.length ? arr.slice(k % arr.length).concat(arr.slice(0, k % arr.length)) : arr);

const WRITE_TOOLS = ["request_refund", "cancel_subscription"];


export function buildSuggestions(opts: { turns: Turn[]; state: State | null; skills: SkillInfo[]; max?: number }): Suggestion[] {
  const { turns, state, skills } = opts;
  const max = opts.max ?? 4;
  const on = (id: string) => skills.length === 0 || skills.some((s) => s.id === id && s.enabled);
  const userTurns = turns.filter((t) => t.role === "user");
  const asked = new Set(userTurns.map((t) => norm(t.text)));
  const lastAgent = [...turns].reverse().find((t) => t.role === "agent");
  const lastUser = userTurns[userTurns.length - 1];
  // Only the customer's LATEST message counts: once they move on (or choose to stay), the leaving options go away.
  const recentUserText = lastUser?.text ?? "";

  // 1. The AI is waiting for the customer's answer: only the answer matters now.
  const lastWrite = lastAgent?.events ? [...lastAgent.events].reverse().find((e) => e.type === "tool_result" && WRITE_TOOLS.includes(e.name)) : undefined;
  if (lastWrite?.type === "tool_result" && lastWrite.result.status === "needs_confirmation") {
    const cancelling = lastWrite.name === "cancel_subscription";
    const offerOnTable = Boolean(lastWrite.result.offer);
    return cancelling
      ? [
          { label: "Yes, cancel it", text: "Yes, cancel it." },
          offerOnTable
            ? { label: "Keep it, I'd like the offer", text: "Keep it, I'd like the offer." }
            : { label: "No, keep my subscription", text: "No, keep my subscription." },
          { label: "What exactly will happen?", text: "What exactly will happen if I cancel?" },
        ]
      : [
          { label: "Yes, go ahead", text: "Yes, please go ahead." },
          { label: "No, never mind", text: "No, never mind." },
          { label: "What exactly will happen?", text: "What exactly will happen if I confirm?" },
        ];
  }

  const out: Suggestion[] = [];
  const add = (s: Suggestion) => {
    if (out.length >= max) return;
    if (asked.has(norm(s.text)) || out.some((o) => o.label === s.label)) return;
    out.push(s);
  };

  // 2. The merchant just decided: follow up on that.
  if (lastAgent?.model === "acme-digital") {
    if (/declined/i.test(lastAgent.text)) {
      add({ label: "Why was it declined?", text: "Why was my request declined?" });
      add({ label: "Can a person look again?", text: "Can a person at Acme Digital look at this again?" });
    } else {
      add({ label: "Is there anything else to check?", text: "Is there anything else on my account I should check?" });
    }
  }

  // 3. A request is still with the merchant.
  const pending = state?.approvals.filter((a) => a.status === "PENDING") ?? [];
  if (pending.length) {
    add({
      label: "Any update on my request?",
      text: pending[0].kind === "cancel" ? "Any update on my cancellation request?" : "Any update on my refund request?",
    });
  }

  // 4. An upset customer is offered a person and a clear picture of what the AI can do.
  if (lastUser && detectTone(lastUser.text) === "upset") {
    add({ label: "Can I talk to a person?", text: "Can I speak to a person at Acme Digital?" });
    add({ label: "What can you do for me?", text: "What can you do for me?" });
  }

  // 5. The account itself.
  if (state) {
    const k = userTurns.length;
    const windowDays = state.policy.refundWindowDays;
    const active = state.subscriptions.filter((s) => s.status === "ACTIVE");
    const recent = [...state.charges].sort((a, b) => b.date.localeCompare(a.date));
    const uniqueByAmount = recent.filter((c, i) => recent.findIndex((x) => x.amount === c.amount) === i);
    const refundable = state.charges
      .filter((c) => c.status === "COMPLETED" && ageDays(c.date) <= windowDays)
      .sort((a, b) => b.amount - a.amount);

    const explain: Suggestion[] = rotate(uniqueByAmount, k).map((c) => ({
      label: `Why was I charged ${money(c.amount)}?`,
      text: `Why was I charged ${money(c.amount)}?`,
    }));
    const renew: Suggestion[] = rotate(
      active.filter((s) => s.next_charge),
      k,
    ).map((s) => ({ label: `When does ${firstWord(s.product)} renew?`, text: `When does ${s.product} renew, and what does it cost per year?` }));

    // Leaving and refunds are offered ONLY after the customer has signalled that intent themselves.
    const refund: Suggestion[] =
      on("refund_charge") && REFUND_INTENT.test(recentUserText)
        ? rotate(refundable, k).map((c) => ({
            label: `Refund the ${money(c.amount)} charge`,
            text: `I don't recognise the ${money(c.amount)} charge from ${c.date}. Please refund it.`,
          }))
        : [];
    const cancel: Suggestion[] =
      on("cancel_subscription") && CANCEL_INTENT.test(recentUserText)
        ? rotate(active, k).map((s) => ({ label: `Cancel ${firstWord(s.product)}`, text: `Please cancel ${s.product}.` }))
        : [];

    // Round-robin so the row is varied. Intent-based items lead when they apply.
    const lists = [refund, cancel, explain, renew];
    for (let i = 0; i < 6; i++) for (const l of lists) if (l[i]) add(l[i]);
    add({ label: "What have I been charged recently?", text: "What have I been charged recently?" });
  }

  add({ label: "What can you do?", text: "What can you do for me?" });
  add({ label: "Can I talk to a person?", text: "Can I speak to a person at Acme Digital?" });
  return out;
}
