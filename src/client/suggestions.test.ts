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
  policy: { autoRefundLimit: 20, maxRefund: 200, refundWindowDays: 30, dailyRefundCap: 50, allowCustomerCancel: true, retentionOffer: "" },
  ...over,
});

const skill = (id: string, enabled = true): SkillInfo => ({
  id, name: id, description: "", whenToUse: "", kind: "write", locked: false, tools: [], enabled, conditions: [], escalation: "",
});
const allOn = [skill("refund_charge"), skill("cancel_subscription")];
const labels = (s: { label: string }[]) => s.map((x) => x.label);
const said = (...texts: string[]): Turn[] => texts.flatMap((t) => [{ role: "user" as const, text: t }, { role: "agent" as const, text: "ok" }]);

describe("dynamic suggestions protect the merchant", () => {
  it("are built from the real account: real amounts and subscription names", () => {
    const s = buildSuggestions({ turns: [], state: state(), skills: allOn });
    const text = labels(s).join(" | ");
    assert.match(text, /\$(14\.99|89\.00|4\.99)/);
    assert.match(text, /StreamBox|CloudNotes|FitTrack|renew/);
    assert.ok(s.length <= 4);
  });

  it("NEVER push cancelling or refunds on their own, on any screen of a normal conversation", () => {
    for (const turns of [[], said("Why was I charged $14.99?"), said("Why was I charged $14.99?", "When does StreamBox renew?"), said("hello")]) {
      const all = labels(buildSuggestions({ turns, state: state(), skills: allOn, max: 20 })).join(" | ");
      assert.doesNotMatch(all, /cancel|refund|trick/i, `leaked a nudge for: ${JSON.stringify(turns.map((t) => t.text))}`);
    }
  });

  it("offer cancelling only after the customer has said they are thinking of it", () => {
    const all = labels(buildSuggestions({ turns: said("I'm thinking of cancelling something"), state: state(), skills: allOn, max: 20 })).join(" | ");
    assert.match(all, /Cancel StreamBox/);
  });

  it("offer a refund only after the customer says a charge is wrong", () => {
    const all = labels(buildSuggestions({ turns: said("I don't recognise a charge on my account"), state: state(), skills: allOn, max: 20 })).join(" | ");
    assert.match(all, /Refund the \$89\.00 charge/);
  });

  it("stop offering to cancel as soon as the customer moves on or chooses to stay", () => {
    const stayed = labels(buildSuggestions({ turns: said("I want to cancel my plan", "keep it"), state: state(), skills: allOn, max: 20 })).join(" | ");
    assert.doesNotMatch(stayed, /cancel|refund/i);
  });

  it("never suggest what is no longer possible, even when the customer asks", () => {
    const st = state();
    st.subscriptions[1].status = "CANCELLED";
    st.charges[1].status = "REFUNDED";
    const all = labels(buildSuggestions({ turns: said("I want to cancel and I don't recognise a charge"), state: st, skills: allOn, max: 20 })).join(" | ");
    assert.doesNotMatch(all, /Cancel CloudNotes/);
    assert.doesNotMatch(all, /Refund the \$89\.00 charge/);
    assert.match(all, /Cancel StreamBox/);
  });

  it("respect the skills the merchant switched off, even when the customer asks", () => {
    const off = [skill("refund_charge", false), skill("cancel_subscription", true)];
    const all = labels(buildSuggestions({ turns: said("I want a refund or to cancel"), state: state(), skills: off, max: 20 })).join(" | ");
    assert.doesNotMatch(all, /Refund the/);
    assert.match(all, /Cancel /);
  });

  it("do not repeat a question the customer already asked", () => {
    const all = labels(buildSuggestions({ turns: said("Why was I charged $14.99?"), state: state(), skills: allOn, max: 20 }));
    assert.ok(!all.includes("Why was I charged $14.99?"));
  });

  it("change as the conversation moves on", () => {
    const first = labels(buildSuggestions({ turns: said("a"), state: state(), skills: allOn }));
    const later = labels(buildSuggestions({ turns: said("a", "c"), state: state(), skills: allOn }));
    assert.notDeepEqual(first, later);
  });

  it("offer only a clear answer while the AI waits for a refund confirmation", () => {
    const turns: Turn[] = [
      { role: "user", text: "refund it" },
      { role: "agent", text: "confirm?", events: [{ type: "tool_result", name: "request_refund", result: { status: "needs_confirmation" } }] },
    ];
    const s = buildSuggestions({ turns, state: state(), skills: allOn });
    assert.deepEqual(labels(s).slice(0, 2), ["Yes, go ahead", "No, never mind"]);
    assert.equal(s.length, 3);
  });

  it("make staying as easy as leaving while the AI waits for a cancellation confirmation", () => {
    const turns: Turn[] = [
      { role: "user", text: "cancel it" },
      { role: "agent", text: "confirm?", events: [{ type: "tool_result", name: "cancel_subscription", result: { status: "needs_confirmation" } }] },
    ];
    const s = labels(buildSuggestions({ turns, state: state(), skills: allOn }));
    assert.deepEqual(s.slice(0, 2), ["Yes, cancel it", "No, keep my subscription"]);
  });

  it("lead with an update question while a request is with the merchant", () => {
    const st = state({ approvals: [{ id: "AP-1", ts: "", kind: "refund", payload: "{}", reason: "", status: "PENDING" }] });
    const s = buildSuggestions({ turns: said("x"), state: st, skills: allOn });
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

  it("still give something sensible before the account has loaded", () => {
    const s = buildSuggestions({ turns: [], state: null, skills: [] });
    assert.ok(labels(s).includes("What can you do?"));
  });
});
