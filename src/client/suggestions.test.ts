import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SkillInfo, State } from "./api.ts";
import { buildSuggestions, type Turn } from "./suggestions.ts";

const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const ahead = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const state = (over: Partial<State> = {}): State => ({
  subscriptions: [
    { id: "S-1", product: "StreamBox Premium", amount: 14.99, interval: "monthly", status: "ACTIVE", started: day(200), next_charge: ahead(20), paypal_id: null },
    { id: "S-2", product: "CloudNotes Pro", amount: 4.99, interval: "monthly", status: "ACTIVE", started: day(300), next_charge: ahead(5), paypal_id: null },
    { id: "S-3", product: "FitTrack Annual", amount: 89, interval: "yearly", status: "ACTIVE", started: day(4), next_charge: ahead(360), paypal_id: null },
  ],
  charges: [
    { id: "C-1", subscription_id: "S-1", amount: 14.99, date: day(9), description: "StreamBox", status: "COMPLETED", note: null, paypal_id: null },
    { id: "C-2", subscription_id: "S-3", amount: 89, date: day(4), description: "FitTrack", status: "COMPLETED", note: null, paypal_id: null },
    { id: "C-3", subscription_id: "S-2", amount: 4.99, date: day(25), description: "CloudNotes", status: "COMPLETED", note: null, paypal_id: null },
  ],
  approvals: [],
  policy: { autoRefundLimit: 20, maxRefund: 200, refundWindowDays: 30, dailyRefundCap: 50, allowCustomerCancel: true },
  ...over,
});

const skill = (id: string, enabled = true): SkillInfo => ({
  id, name: id, description: "", whenToUse: "", kind: "write", locked: false, tools: [], enabled, conditions: [], escalation: "",
});
const allOn = [skill("refund_charge"), skill("cancel_subscription")];
const labels = (s: { label: string }[]) => s.map((x) => x.label);

describe("dynamic suggestions", () => {
  it("are built from the real account: real amounts and subscription names", () => {
    const s = buildSuggestions({ turns: [], state: state(), skills: allOn });
    const text = labels(s).join(" | ");
    assert.match(text, /\$(14\.99|89\.00|4\.99)/);
    assert.match(text, /StreamBox|CloudNotes|FitTrack/);
    assert.ok(s.length <= 4);
  });

  it("only offers a trick chip on a brand-new chat", () => {
    assert.ok(labels(buildSuggestions({ turns: [], state: state(), skills: allOn })).includes("Try to trick it"));
    const turns: Turn[] = [{ role: "user", text: "hi" }, { role: "agent", text: "hello" }];
    assert.ok(!labels(buildSuggestions({ turns, state: state(), skills: allOn })).includes("Try to trick it"));
  });

  it("never suggests what is no longer possible", () => {
    const st = state();
    st.subscriptions[1].status = "CANCELLED";
    st.charges[1].status = "REFUNDED";
    const all = labels(buildSuggestions({ turns: [{ role: "user", text: "x" }], state: st, skills: allOn, max: 12 })).join(" | ");
    assert.doesNotMatch(all, /Cancel CloudNotes/);
    assert.doesNotMatch(all, /Refund the \$89\.00 charge/);
    assert.match(all, /Cancel StreamBox/);
  });

  it("respects the skills the merchant switched off", () => {
    const off = [skill("refund_charge", false), skill("cancel_subscription", true)];
    const all = labels(buildSuggestions({ turns: [{ role: "user", text: "x" }], state: state(), skills: off, max: 12 })).join(" | ");
    assert.doesNotMatch(all, /Refund the/);
    assert.match(all, /Cancel /);
  });

  it("does not repeat a question the customer already asked", () => {
    const turns: Turn[] = [{ role: "user", text: "Why was I charged $14.99?" }, { role: "agent", text: "..." }];
    const all = labels(buildSuggestions({ turns, state: state(), skills: allOn, max: 12 }));
    assert.ok(!all.includes("Why was I charged $14.99?"));
  });

  it("change as the conversation moves on", () => {
    const first = labels(buildSuggestions({ turns: [{ role: "user", text: "a" }], state: state(), skills: allOn }));
    const later = labels(buildSuggestions({ turns: [{ role: "user", text: "a" }, { role: "agent", text: "b" }, { role: "user", text: "c" }], state: state(), skills: allOn }));
    assert.notDeepEqual(first, later);
  });

  it("offer only yes or no while the AI waits for a confirmation", () => {
    const turns: Turn[] = [
      { role: "user", text: "refund it" },
      { role: "agent", text: "confirm?", events: [{ type: "tool_result", name: "request_refund", result: { status: "needs_confirmation" } }] },
    ];
    const s = buildSuggestions({ turns, state: state(), skills: allOn });
    assert.deepEqual(labels(s).slice(0, 2), ["Yes, go ahead", "No, never mind"]);
    assert.equal(s.length, 3);
  });

  it("lead with an update question while a request is with the merchant", () => {
    const st = state({ approvals: [{ id: "AP-1", ts: "", kind: "refund", payload: "{}", reason: "", status: "PENDING" }] });
    const s = buildSuggestions({ turns: [{ role: "user", text: "x" }], state: st, skills: allOn });
    assert.equal(s[0].label, "Any update on my request?");
  });

  it("follow up on a decline that the merchant just sent", () => {
    const turns: Turn[] = [{ role: "agent", model: "acme-digital", text: "Update: your refund was declined. Reason: policy" }];
    const s = labels(buildSuggestions({ turns, state: state(), skills: allOn }));
    assert.equal(s[0], "Why was it declined?");
    assert.ok(s.includes("Can a person look again?"));
  });

  it("offer a person to an upset customer", () => {
    const turns: Turn[] = [{ role: "user", text: "You are useless idiots!!" }, { role: "agent", text: "I understand." }];
    assert.ok(labels(buildSuggestions({ turns, state: state(), skills: allOn })).includes("Can I talk to a person?"));
  });

  it("still gives something sensible before the account has loaded", () => {
    const s = buildSuggestions({ turns: [], state: null, skills: [] });
    assert.ok(labels(s).includes("What can you do?"));
  });
});
