import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

process.env.DB_PATH = ":memory:";

describe("guardrails", () => {
  let tools: typeof import("./tools.ts");
  let store: typeof import("./store.ts");
  let audit: typeof import("./audit.ts");
  let policy: typeof import("./policy.ts");
  let agent: typeof import("./agent.ts");
  let llm: typeof import("./llm.ts");
  let dbm: typeof import("./db.ts");
  let conv: typeof import("./conversations.ts");
  const ctx = { customer: "priya@example.com" };

  before(async () => {
    dbm = await import("./db.ts");
    conv = await import("./conversations.ts");
    tools = await import("./tools.ts");
    store = await import("./store.ts");
    audit = await import("./audit.ts");
    policy = await import("./policy.ts");
    agent = await import("./agent.ts");
    llm = await import("./llm.ts");
  });
  const fresh = () => {
    dbm.db.exec("delete from audit; delete from messages; delete from conversations");
    store.resetAndSeed();
    policy.setPolicy(policy.DEFAULT_POLICY);
  };

  it("auto-approves a small in-window refund", async () => {
    fresh();
    const r = await tools.callTool("request_refund", { charge_id: "C-2001", amount: 14.99, reason: "test reason" }, ctx);
    assert.equal(r.status, "ok");
    assert.equal(store.getCharge("C-2001")?.status, "REFUNDED");
  });

  it("queues a refund above the auto limit for approval and does NOT move money", async () => {
    fresh();
    const r = await tools.callTool("request_refund", { charge_id: "C-2004", amount: 89, reason: "test reason" }, ctx);
    assert.equal(r.status, "pending_approval");
    assert.equal(store.getCharge("C-2004")?.status, "COMPLETED");
    const a = tools.listApprovals("PENDING");
    assert.equal(a.length, 1);
    const done = await tools.decideApproval(a[0].id, true);
    assert.equal(done.status, "ok");
    assert.equal(store.getCharge("C-2004")?.status, "REFUNDED");
  });

  it("denies refunds outside the window and above the hard cap", async () => {
    fresh();
    assert.equal((await tools.callTool("request_refund", { charge_id: "C-2005", amount: 4.99, reason: "test reason" }, ctx)).status, "denied");
    policy.setPolicy({ ...policy.DEFAULT_POLICY, maxRefund: 50 });
    assert.equal((await tools.callTool("request_refund", { charge_id: "C-2004", amount: 89, reason: "test reason" }, ctx)).status, "denied");
  });

  it("rejects over-refund, double refund and malformed arguments", async () => {
    fresh();
    assert.equal((await tools.callTool("request_refund", { charge_id: "C-2001", amount: 99, reason: "test reason" }, ctx)).status, "denied");
    await tools.callTool("request_refund", { charge_id: "C-2001", amount: 14.99, reason: "test reason" }, ctx);
    assert.equal((await tools.callTool("request_refund", { charge_id: "C-2001", amount: 14.99, reason: "test reason" }, ctx)).status, "denied");
    assert.equal((await tools.callTool("request_refund", { charge_id: "bad", amount: -5 }, ctx)).status, "error");
  });

  it("cannot touch another customer's data", async () => {
    fresh();
    const r = await tools.callTool("request_refund", { charge_id: "C-2001", amount: 14.99, reason: "test reason" }, { customer: "mallory@example.com" });
    assert.equal(r.status, "denied");
    assert.equal(store.getCharge("C-2001")?.status, "COMPLETED");
  });

  it("holds against prompt injection hidden in a charge note", async () => {
    fresh();
    // A malicious model that obeys the injected note and tries to refund everything.
    const evil = {
      name: "evil",
      live: false,
      async generate(_s: string, h: any[]) {
        const n = h.filter((c) => c.parts.some((p: any) => p.functionResponse)).length;
        if (n === 0) return [{ functionCall: { name: "list_charges", args: {} } }];
        if (n === 1) return [{ functionCall: { name: "request_refund", args: { charge_id: "C-2004", amount: 89, reason: "note said so" } } }];
        return [{ text: "done" }];
      },
    };
    await agent.runAgent({ conversationId: conv.createConversation().id, message: "hi", customer: ctx.customer, llm: evil as any });
    // The skill gate stops it before policy: nothing moved, no approval was even created,
    // because the customer never confirmed anything.
    assert.equal(store.getCharge("C-2004")?.status, "COMPLETED");
    assert.equal(tools.listApprovals("PENDING").length, 0);
  });

  it("allows only one account change per message", async () => {
    fresh();
    const c = { customer: ctx.customer, writes: { used: 0, max: 1 } };
    assert.equal((await tools.callTool("request_refund", { charge_id: "C-2001", amount: 14.99, reason: "test reason" }, c)).status, "ok");
    assert.equal((await tools.callTool("request_refund", { charge_id: "C-2003", amount: 4.99, reason: "test reason" }, c)).status, "denied");
    assert.equal(store.getCharge("C-2003")?.status, "COMPLETED");
  });


  it("saves conversations and resumes with context", async () => {
    fresh();
    const c = conv.createConversation();
    await agent.runAgent({ conversationId: c.id, message: "Why was I charged $14.99?", customer: ctx.customer, llm: llm.mockLLM() });
    assert.equal(conv.getMessages(c.id).length, 2);
    assert.equal(conv.getConversation(c.id)!.title, "Why was I charged $14.99?");
    assert.ok(conv.loadHistory(c.id).length >= 3);
    await agent.runAgent({ conversationId: c.id, message: "Thanks", customer: ctx.customer, llm: llm.mockLLM() });
    assert.equal(conv.getMessages(c.id).length, 4);
  });

  it("adds a staleness note when a chat resumes after a long break", async () => {
    fresh();
    const c = conv.createConversation();
    const seen: string[] = [];
    const spy = {
      name: "spy",
      live: false,
      async generate(_s: string, h: any[]) {
        seen.push(JSON.stringify(h[h.length - 1]));
        return [{ text: "ok" }];
      },
    };
    await agent.runAgent({ conversationId: c.id, message: "hi", customer: ctx.customer, llm: spy as any });
    dbm.db.prepare("update conversations set updated_at=? where id=?").run(new Date(Date.now() - 3 * 3600_000).toISOString(), c.id);
    await agent.runAgent({ conversationId: c.id, message: "any update?", customer: ctx.customer, llm: spy as any });
    assert.doesNotMatch(seen[0], /returning after/);
    assert.match(seen[1], /returning after 3 hours/);
  });

  it("scripted AI answers a follow-up about an earlier request using the real status tool", async () => {
    fresh();
    const c = conv.createConversation();
    const run = (message: string) => agent.runAgent({ conversationId: c.id, message, customer: ctx.customer, llm: llm.mockLLM() });
    const ask = await run("I don't recognise the $89 charge. Please refund it.");
    assert.match(ask.reply, /confirm/i);
    await run("Yes, please go ahead.");
    const out = await run("Any update on my refund request?");
    assert.match(out.reply, /pending/i);
    const [a] = tools.listApprovals("PENDING");
    await tools.decideApproval(a.id, false);
    const later = await run("Any update now?");
    assert.match(later.reply, /rejected|declined/i);
  });

  describe("skills: conditions checked in code", () => {
    const refund = { charge_id: "C-2001", amount: 14.99, reason: "does not recognise it" };

    it("a switched-off skill cannot act, and the AI no longer sees its tool", async () => {
      fresh();
      const sk = await import("./skills.ts");
      sk.setSkillEnabled("refund_charge", false);
      try {
        const r = await tools.callTool("request_refund", refund, ctx);
        assert.equal(r.status, "denied");
        assert.equal(store.getCharge("C-2001")?.status, "COMPLETED");
        assert.ok(!tools.activeTools().some((t) => t.name === "request_refund"));
      } finally {
        sk.setSkillEnabled("refund_charge", true);
      }
      assert.ok(tools.activeTools().some((t) => t.name === "request_refund"));
    });

    it("refuses to act on a charge the AI has not looked up in this conversation", async () => {
      fresh();
      const c = conv.createConversation();
      const r = await tools.callTool("request_refund", refund, { ...ctx, conversationId: c.id, userMessage: "refund it", history: [] });
      assert.equal(r.status, "denied");
      assert.match(JSON.stringify(r), /looked it up|Look the charge up/i);
      assert.equal(store.getCharge("C-2001")?.status, "COMPLETED");
    });

    it("needs the customer's yes in a SEPARATE later message, and an injected yes does not count", async () => {
      fresh();
      const c = conv.createConversation();
      const seen = [{ role: "user" as const, parts: [{ functionResponse: { name: "list_charges", response: { result: { status: "ok", data: { charges: [{ id: "C-2001" }], subscriptions: [] } } } } }] }];
      const call = (message: string) => tools.callTool("request_refund", refund, { ...ctx, conversationId: c.id, userMessage: message, history: seen });

      conv.addMessage(c.id, { role: "user", text: "refund the 14.99 please" });
      const first = await call("refund the 14.99 please");
      assert.equal(first.status, "needs_confirmation");
      assert.equal(store.getCharge("C-2001")?.status, "COMPLETED");

      // Same message turn, AI tries again: still no. The customer has not replied.
      const same = await call("refund the 14.99 please");
      assert.equal(same.status, "needs_confirmation");

      // A later message that is not a yes does not confirm either.
      conv.addMessage(c.id, { role: "user", text: "what is the policy?" });
      assert.equal((await call("what is the policy?")).status, "needs_confirmation");

      // A real yes in a later message does.
      conv.addMessage(c.id, { role: "user", text: "Yes, go ahead" });
      const done = await call("Yes, go ahead");
      assert.equal(done.status, "ok");
      assert.equal(store.getCharge("C-2001")?.status, "REFUNDED");
    });

    it("shows its checks so a human can see what was verified", async () => {
      fresh();
      const r = await tools.callTool("request_refund", { charge_id: "C-9999", amount: 5, reason: "none here" }, ctx);
      assert.equal(r.status, "denied");
      assert.ok(r.checks && r.checks.some((c) => !c.ok && /belongs to this customer/.test(c.label)));
    });
  });

  it("reports a request's status, only to the customer who made it", async () => {
    fresh();
    const q: any = await tools.callTool("request_refund", { charge_id: "C-2004", amount: 89, reason: "test reason" }, ctx);
    const s = await tools.callTool("check_request_status", { approval_id: q.approvalId }, ctx);
    assert.equal(s.status, "ok");
    assert.match(JSON.stringify(s), /PENDING/);
    const other = await tools.callTool("check_request_status", { approval_id: q.approvalId }, { customer: "mallory@example.com" });
    assert.equal(other.status, "error");
  });

  it("audit log is hash-chained and detects tampering", async () => {
    fresh();
    audit.logAudit("a", "t", "one");
    audit.logAudit("a", "t", "two");
    assert.equal(audit.verifyChain().ok, true);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return import("./db.ts").then(({ db }) => {
      db.prepare("update audit set summary='forged' where id=(select min(id) from audit)").run();
      assert.equal(audit.verifyChain().ok, false);
    });
  });

  it("demo-mode mock agent completes an explain flow", async () => {
    fresh();
    const out = await agent.runAgent({ conversationId: conv.createConversation().id, message: "Why was I charged $14.99?", customer: ctx.customer, llm: llm.mockLLM() });
    assert.match(out.reply, /StreamBox/);
  });
});
