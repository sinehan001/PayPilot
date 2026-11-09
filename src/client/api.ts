export interface Subscription {
  id: string;
  product: string;
  amount: number;
  interval: string;
  status: "ACTIVE" | "CANCELLED";
  started: string;
  next_charge: string | null;
  paypal_id: string | null;
}
export interface Charge {
  id: string;
  subscription_id: string | null;
  amount: number;
  date: string;
  description: string;
  status: "COMPLETED" | "REFUNDED";
  note: string | null;
  paypal_id: string | null;
}
export interface Approval {
  id: string;
  ts: string;
  kind: "refund" | "cancel" | "handoff";
  payload: string;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  /** Why the merchant approved or declined. Shown to the customer. */
  decision_reason?: string | null;
}
export interface Policy {
  autoRefundLimit: number;
  maxRefund: number;
  refundWindowDays: number;
  dailyRefundCap: number;
  allowCustomerCancel: boolean;
  /** Optional one-line offer shown once to a customer who has already asked to cancel. */
  retentionOffer: string;
}
export interface State {
  subscriptions: Subscription[];
  charges: Charge[];
  approvals: Approval[];
  policy: Policy;
}
export interface Health {
  demoAI: boolean;
  model: string;
  paypalSandboxConfigured: boolean;
  customer: string;
  merchant: string;
}
export interface AuditRow {
  id: number;
  ts: string;
  actor: string;
  type: string;
  summary: string;
  hash: string;
}
export interface AuditResp {
  rows: AuditRow[];
  chain: { ok: boolean; count: number; brokenAt?: number };
}
export interface CheckResult {
  id: string;
  label: string;
  ok: boolean;
  detail?: string;
  skipped?: boolean;
}
export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  whenToUse: string;
  kind: "read" | "write" | "conduct";
  locked: boolean;
  tools: string[];
  enabled: boolean;
  conditions: string[];
  escalation: string;
}
export interface MerchantSummary {
  pending: number;
  refundedToday: number;
  handledByAI: number;
  blockedByPolicy: number;
  conversations: number;
}
export interface ConversationSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  count: number;
}
export interface StoredMessage {
  id: number;
  ts: string;
  role: "user" | "agent";
  text: string;
  events: AgentEvent[];
  model: string | null;
  error: boolean;
}
export type AgentEvent =
  | { type: "tool_call"; name: string; args: unknown; kind: "read" | "write" }
  | { type: "tool_result"; name: string; result: { status: string; reason?: string; message?: string; summary?: string; checks?: CheckResult[] } }
  | { type: "message"; text: string };

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...init });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as any).error || (j as any).message || r.statusText);
  return j as T;
}
