import type { ToolDef } from "./tools.ts";

/** Provider-agnostic LLM layer. Gemini for real runs, a deterministic mock for demo mode. */

export type Part = Record<string, any>;
export interface Content {
  role: "user" | "model";
  parts: Part[];
}
export interface LLM {
  name: string;
  live: boolean;
  generate(system: string, history: Content[], tools: ToolDef[]): Promise<Part[]>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function geminiLLM(apiKey: string, model: string): LLM {
  return {
    name: `gemini:${model}`,
    live: true,
    async generate(system, history, tools) {
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: history,
        tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }],
      };
      let lastErr = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS ?? 12_000)),
        }).catch((e: Error) => {
          lastErr = `network/timeout: ${e.message}`;
          return null;
        });
        if (!res) break; // a stalled model rarely recovers within seconds; let the chain move on

        if (res.ok) {
          const json: any = await res.json();
          // Return the model's parts untouched (keeps thought signatures valid across turns).
          const parts = json.candidates?.[0]?.content?.parts;
          if (parts?.length) return parts;
          return [{ text: "I couldn't produce an answer for that. Please rephrase." }];
        }
        lastErr = `${res.status} ${(await res.text()).slice(0, 200)}`;
        if (res.status === 429 || res.status >= 500) await sleep(800 * (attempt + 1));
        else break;
      }
      throw new Error(`Gemini request failed: ${lastErr}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Deterministic mock (DEMO MODE). Follows the same tool loop, so every guardrail still runs.
// ---------------------------------------------------------------------------

function lastUserText(history: Content[]): { text: string; index: number } {
  for (let i = history.length - 1; i >= 0; i--) {
    // Use the LAST text part: a resume note, when present, comes first.
    const texts = history[i].parts.filter((p) => typeof p.text === "string");
    if (history[i].role === "user" && texts.length) return { text: texts[texts.length - 1].text, index: i };
  }
  return { text: "", index: 0 };
}

function responsesSince(history: Content[], index: number): { name: string; response: any }[] {
  const out: { name: string; response: any }[] = [];
  for (const c of history.slice(index + 1))
    for (const p of c.parts) if (p.functionResponse) out.push({ name: p.functionResponse.name, response: p.functionResponse.response });
  return out;
}

const money = (n: number) => `$${n.toFixed(2)}`;

/** Most recent approval reference this conversation has produced, if any. */
function lastApprovalRef(history: Content[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i--)
    for (const p of history[i].parts) {
      const id = p.functionResponse?.response?.result?.approvalId;
      if (typeof id === "string") return id;
    }
  return undefined;
}

export function mockLLM(): LLM {
  return {
    name: "demo-mock",
    live: false,
    async generate(_system, history) {
      const { text, index } = lastUserText(history);
      const msg = text.toLowerCase();
      const res = responsesSince(history, index);
      const intent = /cancel|stop (it|renew)/.test(msg) ? "cancel" : /refund|money back/.test(msg) ? "refund" : "explain";
      const amountMatch = msg.match(/\$?\s?(\d+(?:\.\d{1,2})?)/);
      const amount = amountMatch ? parseFloat(amountMatch[1]) : undefined;

      // Follow-up about an earlier request ("any update on my refund?"): use the real status tool.
      if (/\b(update|status|what happened|any news|heard back|progress|decision)\b/.test(msg) && !/\b(please|can you|could you) (cancel|refund)\b/.test(msg)) {
        const sr = res.find((r) => r.name === "check_request_status")?.response?.result;
        if (!sr) {
          const typed = msg.match(/ap-([0-9a-f]{8})/i);
          const ref = typed ? `AP-${typed[1].toLowerCase()}` : lastApprovalRef(history);
          if (!ref) return [{ text: "Which request do you mean? Send me its reference number, like AP-1a2b3c4d." }];
          return [{ functionCall: { name: "check_request_status", args: { approval_id: ref } } }];
        }
        if (sr.status === "ok") return [{ text: `Your ${sr.data.type} request ${sr.data.reference} is ${String(sr.data.state).toLowerCase()}. ${sr.data.outcome}` }];
        return [{ text: `I couldn't find that request: ${sr.message ?? "unknown reference"}` }];
      }

      const list = res.find((r) => r.name === "list_charges")?.response?.result?.data as any;
      const last = res[res.length - 1];

      if (!list) {
        const args: Record<string, unknown> = {};
        if (intent === "explain" && amount !== undefined) {
          args.min_amount = amount;
          args.max_amount = amount;
        }
        return [{ functionCall: { name: "list_charges", args } }];
      }

      const subs: any[] = list.subscriptions;
      const charges: any[] = list.charges;
      const mentioned = subs.find((s) => s.product.toLowerCase().split(" ").some((w: string) => w.length > 3 && msg.includes(w)));

      if (intent === "cancel" && last.name === "list_charges") {
        if (!mentioned) return [{ text: "Which subscription would you like to cancel? " + subs.map((s) => s.product).join(", ") + "." }];
        return [{ functionCall: { name: "cancel_subscription", args: { subscription_id: mentioned.id, reason: "Customer asked to cancel." } } }];
      }
      if (intent === "refund" && last.name === "list_charges") {
        const pick = charges.find(
          (c) => c.status === "COMPLETED" && ((amount !== undefined && Math.abs(c.amount - amount) < 0.01) || (mentioned && c.subscription_id === mentioned.id)),
        );
        if (!pick) return [{ text: "I couldn't match that to one charge. Tell me the amount or product." }];
        return [{ functionCall: { name: "request_refund", args: { charge_id: pick.id, amount: pick.amount, reason: "Customer requested a refund." } } }];
      }

      if (last.name === "cancel_subscription" || last.name === "request_refund") {
        const r = last.response.result;
        if (r.status === "ok") return [{ text: last.name === "cancel_subscription" ? "Done. Your subscription is cancelled and won't renew." : `Done. Your refund of ${money(r.data.amount)} was approved and issued.` }];
        if (r.status === "pending_approval") return [{ text: `I've sent this for approval (ref ${r.approvalId}). ${r.message} You'll hear back once it's reviewed.` }];
        if (r.status === "denied") return [{ text: `I can't do that: ${r.reason}` }];
        return [{ text: `That didn't work: ${r.message}` }];
      }

      // explain
      if (!charges.length) return [{ text: "I couldn't find a matching charge on your account." }];
      const lines = charges.slice(0, 3).map((c) => {
        const s = subs.find((x) => x.id === c.subscription_id);
        const renew = s?.next_charge ? ` It renews next on ${s.next_charge}${s.interval === "monthly" ? `, about ${money(s.amount * 12)} per year` : ""}.` : "";
        return `${money(c.amount)} on ${c.date} was ${c.description}${s ? ` (subscription ${s.id}, ${s.status.toLowerCase()})` : ""}.${renew}`;
      });
      return [{ text: lines.join("\n") + "\nWant me to cancel it or request a refund?" }];
    },
  };
}

/** Tries each LLM in order. `name` always reflects the model that answered last. */
export function chainLLM(llms: LLM[]): LLM {
  const self: LLM = {
    name: llms[0].name,
    live: llms[0].live,
    async generate(system, history, tools) {
      let last: unknown;
      for (const l of llms) {
        try {
          const parts = await l.generate(system, history, tools);
          self.name = l.name;
          self.live = l.live;
          return parts;
        } catch (e) {
          last = e;
          console.warn(`[llm] ${l.name} failed: ${(e as Error).message.slice(0, 120)}`);
        }
      }
      throw last;
    },
  };
  return self;
}

export function selectLLM(): LLM {
  const provider = process.env.LLM_PROVIDER ?? "gemini";
  const key = process.env.GEMINI_API_KEY;
  if (provider === "gemini" && key) {
    const models = [process.env.GEMINI_MODEL ?? "gemini-3-flash-preview", process.env.GEMINI_FALLBACK_MODEL ?? "gemini-3.1-flash-lite"];
    const chain = [...new Set(models)].map((m) => geminiLLM(key, m));
    return chainLLM([...chain, mockLLM()]);
  }
  return mockLLM();
}
