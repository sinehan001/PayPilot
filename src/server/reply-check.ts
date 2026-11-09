import type { AgentEvent } from "./agent.ts";
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

export function truthfulReply(events: AgentEvent[]): string {
  const lastWrite = [...events].reverse().find((e) => e.type === "tool_result" && WRITE_TOOLS.has(e.name));
  if (lastWrite?.type === "tool_result") {
    const r = lastWrite.result as any;
    if (r.status === "needs_confirmation") return `Before I make any change, please confirm: ${r.summary}. Reply "yes" and I'll go ahead.`;
    if (r.status === "pending_approval")
      return `I've sent your request to ${MERCHANT} for review (reference ${r.approvalId}). Nothing has been changed yet. You'll see their decision, and the reason, right here.`;
    if (r.status === "denied") return `I wasn't able to do that: ${r.reason}`;
    if (r.status === "error") return `That didn't go through, and nothing was changed. ${r.message ?? ""}`.trim();
  }
  return "I haven't made any changes to your account. Tell me which charge or subscription you'd like help with and I'll walk you through it.";
}
