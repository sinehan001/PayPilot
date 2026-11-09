import type { AgentEvent } from "./agent.ts";
import { hasLeavingOrRefundIntent } from "./intent.ts";
import { MERCHANT } from "./store.ts";

/**
 * Words must match deeds. If the AI says it cancelled or refunded something but no account change
 * actually succeeded in this turn, the reply is replaced with a truthful one built from what happened.
 * This holds for any model, because it looks at the result, not at the model.
 */

// First-person claims only ("I've refunded...", "I cancelled..."), so statuses like "already cancelled" are not flagged.
const CLAIM = /\bi(?:['’]ve|\s+have|\s+just|\s+successfully|\s+now)?\s*(?:just\s+|successfully\s+|now\s+)?(?:cancel(?:l)?ed|refunded|issued|processed|completed)\b/i;

const WRITE_TOOLS = new Set(["request_refund", "cancel_subscription"]);

export function falseActionClaim(reply: string, events: AgentEvent[]): boolean {
  if (!CLAIM.test(reply)) return false;
  const executed = events.some((e) => e.type === "tool_result" && WRITE_TOOLS.has(e.name) && e.result.status === "ok");
  return !executed;
}

// --- Invented claims ---------------------------------------------------------------------------
// The AI has no tool that applies a discount, offer or credit, so a reply saying one was applied is
// always false. And it may only say a person was notified after request_human_help really succeeded.

const APPLIED_CLAIM =
  /\b(?:i(?:['’]ve| have)\s+(?:applied|added|activated|credited|set up)|(?:discount|offer|coupon|credit|promotion|promo)\b[^.!?]{0,60}\b(?:is|was|has been|have been|are)\s+(?:already\s+|now\s+)?(?:applied|added|activated|credited))/i;

const PERSON_CLAIM =
  /\b(?:i(?:['’]ve| have)\s+(?:passed|sent|forwarded|flagged|escalated|asked|notified|alerted)\b[^.!?]{0,50}\b(?:person|team|someone|colleague|staff|manager)|(?:a person|someone|the team|our team|a colleague)\b[^.!?]{0,40}\bwill (?:reply|follow up|contact you|be in touch|get back to you))/i;

export function inventedClaim(reply: string, events: AgentEvent[]): boolean {
  if (APPLIED_CLAIM.test(reply)) return true;
  if (PERSON_CLAIM.test(reply)) {
    const backed = events.some(
      (e) =>
        e.type === "tool_result" &&
        e.result.status !== "denied" &&
        e.result.status !== "error" &&
        (e.name === "request_human_help" || (WRITE_TOOLS.has(e.name) && e.result.status === "pending_approval")),
    );
    return !backed;
  }
  return false;
}

// --- No unprompted cancel or refund offers ----------------------------------------------------
// A line like "Would you like to cancel or get a refund?" plants the idea and costs the merchant a
// subscription. Cancelling stays available the moment the customer asks, but it is never advertised.

const NUDGE_LEAD =
  /\b(would you like|do you want|want me to|shall i|if you(?:['’]d| would)? like|if you(?:['’]d| would)? prefer|if you want|just let me know|let me know if you|i can (?:also )?(?:help you )?(?:cancel|request|start))\b/i;
const NUDGE_TOPIC = /\b(cancel(?:l)?(?:ing|ation|ed)?|refund(?:s|ing|ed)?|unsubscribe|stop (?:the )?(?:subscription|renewal))\b/i;

export const isNudge = (sentence: string) => NUDGE_LEAD.test(sentence) && NUDGE_TOPIC.test(sentence);

/**
 * Removes sentences that offer to cancel or refund when the customer never raised it.
 * Does nothing if the customer signalled that intent, or if an account action happened this turn.
 */
export function stripNudges(reply: string, recentUserText: string, events: AgentEvent[]): { text: string; removed: string[] } {
  if (hasLeavingOrRefundIntent(recentUserText)) return { text: reply, removed: [] };
  if (events.some((e) => e.type === "tool_result" && WRITE_TOOLS.has(e.name))) return { text: reply, removed: [] };

  // Split after . ! ? only when followed by whitespace, so amounts like $14.99 stay whole; keep the separators.
  const tokens = reply.split(/(?<=[.!?])(\s+)/);
  const kept: string[] = [];
  const removed: string[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const sentence = tokens[i];
    const sep = tokens[i + 1] ?? "";
    if (isNudge(sentence)) removed.push(sentence.trim());
    else kept.push(sentence, sep);
  }
  const text = kept.join("").trim();
  return text ? { text, removed } : { text: reply, removed: [] }; // never turn a reply into nothing
}

export function truthfulReply(events: AgentEvent[]): string {
  const handoff = [...events].reverse().find((e) => e.type === "tool_result" && e.name === "request_human_help" && e.result.status === "ok");
  if (handoff?.type === "tool_result") {
    const ref = (handoff.result as any).data?.reference;
    return `I've asked a person at ${MERCHANT} to follow up${ref ? ` (reference ${ref})` : ""}. They'll reply right here in this chat. I haven't changed anything on your account myself.`;
  }
  const lastWrite = [...events].reverse().find((e) => e.type === "tool_result" && WRITE_TOOLS.has(e.name));
  if (lastWrite?.type === "tool_result") {
    const r = lastWrite.result as any;
    if (r.status === "needs_confirmation") return `Before I make any change, please confirm: ${r.summary}. Reply "yes" and I'll go ahead.`;
    if (r.status === "pending_approval")
      return `I've sent your request to ${MERCHANT} for review (reference ${r.approvalId}). Nothing has been changed yet. You'll see their decision, and the reason, right here.`;
    if (r.status === "denied") return `I wasn't able to do that: ${r.reason}`;
    if (r.status === "error") return `That didn't go through, and nothing was changed. ${r.message ?? ""}`.trim();
  }
  return "I haven't made any changes to your account. Tell me which charge or subscription you'd like help with, or say if you'd like a person at Acme Digital to follow up and I'll ask them.";
}
