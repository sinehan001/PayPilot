import { z } from "zod";
import { db } from "./db.ts";

/** Merchant policy. Enforced in code, never in the prompt. */
export const PolicySchema = z.object({
  /** Refunds up to this amount (USD) are auto-approved. */
  autoRefundLimit: z.number().min(0).max(10_000),
  /** Refunds above this amount are always denied; a human must act outside the agent. */
  maxRefund: z.number().min(0).max(100_000),
  /** Only charges newer than this many days can be refunded by the agent. */
  refundWindowDays: z.number().int().min(0).max(365),
  /** Total auto-refunded per day across all customers. */
  dailyRefundCap: z.number().min(0).max(100_000),
  /** Whether the agent may cancel a customer's subscription without approval. */
  allowCustomerCancel: z.boolean(),
});
export type Policy = z.infer<typeof PolicySchema>;

export const DEFAULT_POLICY: Policy = {
  autoRefundLimit: 20,
  maxRefund: 200,
  refundWindowDays: 30,
  dailyRefundCap: 50,
  allowCustomerCancel: true,
};

export function getPolicy(): Policy {
  const row = db.prepare("select value from settings where key='policy'").get() as { value: string } | undefined;
  if (!row) return DEFAULT_POLICY;
  const parsed = PolicySchema.safeParse(JSON.parse(row.value));
  return parsed.success ? parsed.data : DEFAULT_POLICY;
}

export function setPolicy(p: Policy): Policy {
  const v = PolicySchema.parse(p);
  db.prepare("insert into settings(key,value) values('policy',?) on conflict(key) do update set value=excluded.value").run(
    JSON.stringify(v),
  );
  return v;
}

export type Decision =
  | { decision: "allow"; reason: string }
  | { decision: "needs_approval"; reason: string }
  | { decision: "deny"; reason: string };

export interface RefundRequest {
  amount: number;
  chargeAmount: number;
  chargeAgeDays: number;
  alreadyRefunded: boolean;
  refundedToday: number;
}

export function evaluateRefund(p: Policy, r: RefundRequest): Decision {
  if (!(r.amount > 0)) return { decision: "deny", reason: "Refund amount must be positive." };
  if (r.alreadyRefunded) return { decision: "deny", reason: "This charge was already refunded." };
  if (r.amount > r.chargeAmount) return { decision: "deny", reason: "Refund exceeds the original charge." };
  if (r.amount > p.maxRefund)
    return { decision: "deny", reason: `Amount exceeds the hard refund cap of $${p.maxRefund.toFixed(2)}.` };
  if (r.chargeAgeDays > p.refundWindowDays)
    return { decision: "deny", reason: `Charge is older than the ${p.refundWindowDays}-day refund window.` };
  if (r.amount > p.autoRefundLimit)
    return {
      decision: "needs_approval",
      reason: `Amount is above the $${p.autoRefundLimit.toFixed(2)} auto-refund limit, so a human must approve.`,
    };
  if (r.refundedToday + r.amount > p.dailyRefundCap)
    return { decision: "needs_approval", reason: `Would exceed the $${p.dailyRefundCap.toFixed(2)} daily auto-refund cap.` };
  return { decision: "allow", reason: "Within auto-refund policy." };
}

export function evaluateCancel(p: Policy): Decision {
  return p.allowCustomerCancel
    ? { decision: "allow", reason: "Customer cancellation is allowed by policy." }
    : { decision: "needs_approval", reason: "Policy requires approval for cancellations." };
}
