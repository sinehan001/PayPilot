import "dotenv/config";
import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { runAgent } from "./agent.ts";
import { db } from "./db.ts";
import { addMessage, clearAllConversations, createConversation, getConversation, getMessages, listConversations } from "./conversations.ts";
import { listAudit, verifyChain, logAudit } from "./audit.ts";
import { selectLLM } from "./llm.ts";
import { paypalConfigured } from "./paypal.ts";
import { describeSkills, setSkillEnabled, skills } from "./skills.ts";
import { getPolicy, PolicySchema, setPolicy } from "./policy.ts";
import * as store from "./store.ts";
import { decideApproval, listApprovals } from "./tools.ts";

store.seedIfEmpty();
const app = express();
app.use(express.json({ limit: "100kb" }));

const llm = selectLLM();

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    demoAI: !llm.live,
    model: llm.primary ?? llm.name,
    paypalSandboxConfigured: paypalConfigured(),
    customer: store.DEMO_CUSTOMER,
    merchant: store.MERCHANT,
  });
});

const ChatBody = z.object({ conversationId: z.string().min(1).max(32).optional(), message: z.string().min(1).max(1000) });

app.post("/api/chat", async (req, res) => {
  const body = ChatBody.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid request" });
  const conv = body.data.conversationId ? getConversation(body.data.conversationId) : createConversation();
  if (!conv) return res.status(404).json({ error: "Conversation not found" });
  try {
    const out = await runAgent({ conversationId: conv.id, message: body.data.message, customer: store.DEMO_CUSTOMER, llm });
    res.json({ ...out, conversationId: conv.id });
  } catch (e: any) {
    logAudit("system", "agent_error", String(e.message).slice(0, 200));
    const msg = "The AI service is unavailable right now. Please try again in a moment.";
    addMessage(conv.id, { role: "agent", text: msg, error: true });
    res.status(502).json({ error: msg });
  }
});

app.get("/api/conversations", (_req, res) => res.json(listConversations()));
app.post("/api/conversations", (_req, res) => res.json(createConversation()));
app.get("/api/conversations/:id", (req, res) => {
  const c = getConversation(req.params.id);
  if (!c) return res.status(404).json({ error: "Conversation not found" });
  res.json({ conversation: c, messages: getMessages(c.id) });
});

app.get("/api/state", (_req, res) => {
  res.json({
    subscriptions: store.listSubscriptions(store.DEMO_CUSTOMER),
    charges: store.listCharges(store.DEMO_CUSTOMER, {}),
    approvals: listApprovals(),
    policy: getPolicy(),
  });
});

app.get("/api/merchant/summary", (_req, res) => {
  const n = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  res.json({
    pending: n("select count(*) c from approvals where status='PENDING'"),
    refundedToday: store.refundedToday(),
    handledByAI: n("select count(*) c from audit where type in ('refund_executed','cancel_executed') and actor='auto-policy'"),
    blockedByPolicy: n("select count(*) c from audit where type='tool_result' and json_extract(detail,'$.status')='denied'"),
    conversations: n("select count(*) c from conversations"),
  });
});

app.get("/api/skills", (_req, res) => res.json(describeSkills()));
app.put("/api/skills/:id", (req, res) => {
  const skill = skills.find((s) => s.id === req.params.id);
  const body = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!skill || !body.success) return res.status(400).json({ error: "Invalid skill or value" });
  if (skill.locked) return res.status(400).json({ error: "This skill is always on: it is how the AI treats every customer." });
  setSkillEnabled(skill.id, body.data.enabled);
  logAudit("merchant", "skill_toggled", `Merchant switched "${skill.name}" ${body.data.enabled ? "on" : "off"}`, { skill: skill.id, enabled: body.data.enabled });
  res.json(describeSkills());
});

app.get("/api/policy", (_req, res) => res.json(getPolicy()));
app.put("/api/policy", (req, res) => {
  const p = PolicySchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "Invalid policy", issues: p.error.issues });
  setPolicy(p.data);
  logAudit("merchant", "policy_changed", "Merchant updated the policy", p.data);
  res.json(p.data);
});

app.get("/api/audit", (_req, res) => res.json({ rows: listAudit(200), chain: verifyChain() }));
app.get("/api/approvals", (_req, res) => res.json(listApprovals()));
app.post("/api/approvals/:id/:action", async (req, res) => {
  const { id, action } = req.params;
  if (action !== "approve" && action !== "reject") return res.status(400).json({ error: "Bad action" });
  const body = z.object({ reason: z.string().trim().min(3).max(300) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Please give a reason (at least 3 characters). The customer will see it." });
  const r = await decideApproval(id, action === "approve", { reason: body.data.reason });
  res.status(r.status === "error" ? 400 : 200).json(r);
});

app.post("/api/reset", (_req, res) => {
  store.resetAndSeed();
  clearAllConversations();
  logAudit("system", "demo_reset", "Demo data reset");
  res.json({ ok: true });
});

// Landing page PayPal redirects to after a sandbox buyer approves or cancels.
app.get("/return", (_req, res) => {
  res.type("html").send(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PayPilot</title>
<body style="font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f7f9;color:#0b1f33">
<div style="text-align:center;padding:24px"><h1 style="margin:0 0 8px">Approved in PayPal sandbox</h1>
<p style="margin:0;color:#52606d">You can close this tab and return to PayPilot.</p></div></body>`,
  );
});

const dist = path.resolve("dist/client");
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => console.log(`PayPilot on http://localhost:${port}  (AI: ${llm.name})`));
