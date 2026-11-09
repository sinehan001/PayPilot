import { detectTone } from "./tone.ts";
import type { ToolDef } from "./tools.ts";

/** Provider-agnostic LLM layer. Gemini for real runs, a deterministic mock for demo mode. */

export type Part = Record<string, any>;
export interface Content {
  role: "user" | "model";
  parts: Part[];
}
export interface LLM {
  /** Model that answered most recently (changes if the chain falls back). */
  name: string;
  /** Configured primary model name; stable. */
  primary?: string;
  /** True when a real model is configured. Stable: a one-off fallback does not flip this. */
  live: boolean;
  generate(system: string, history: Content[], tools: ToolDef[]): Promise<Part[]>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Gemini 3 rejects a conversation whose earlier tool calls came from a different model and so carry no
 * "thought signature". Google documents a placeholder value for exactly this case (a conversation moved
 * between models), so we add it only where a signature is missing. Untested against Gemini here.
 */
function withSignatures(history: Content[]): Content[] {
  return history.map((c) =>
    c.role === "model"
      ? { ...c, parts: c.parts.map((p) => (p.functionCall && !p.thoughtSignature ? { ...p, thoughtSignature: "skip_thought_signature_validator" } : p)) }
      : c,
  );
}

export function geminiLLM(apiKey: string, model: string): LLM {
  return {
    name: `gemini:${model}`,
    live: true,
    async generate(system, history, tools) {
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: withSignatures(history),
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
          lastErr = "empty reply"; // treat as a failure so the chain can try the next model
          break;
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
// NVIDIA NIM (OpenAI-compatible chat API at integrate.api.nvidia.com).
// Our saved conversations use one neutral format, so this adapter converts to and from it.
// ---------------------------------------------------------------------------

/** Gemini-style schemas use "OBJECT"/"STRING"; OpenAI-style JSON Schema wants lowercase. */
function toJsonSchema(s: any): any {
  if (Array.isArray(s)) return s.map(toJsonSchema);
  if (s && typeof s === "object") {
    const o: Record<string, any> = {};
    for (const [k, v] of Object.entries(s)) o[k] = k === "type" && typeof v === "string" ? v.toLowerCase() : toJsonSchema(v);
    return o;
  }
  return s;
}

function toOpenAIMessages(system: string, history: Content[]): any[] {
  const msgs: any[] = [{ role: "system", content: system }];
  let pending: { id: string; name: string }[] = [];
  let n = 0;
  for (const c of history) {
    if (c.role === "model") {
      const text = c.parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("");
      pending = [];
      const tool_calls = c.parts
        .filter((p) => p.functionCall)
        .map((p) => {
          const id = String(p.functionCall.id ?? `call_${++n}`);
          pending.push({ id, name: p.functionCall.name });
          return { id, type: "function", function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) } };
        });
      msgs.push({ role: "assistant", content: text || null, ...(tool_calls.length ? { tool_calls } : {}) });
    } else {
      for (const p of c.parts.filter((x) => x.functionResponse)) {
        const fr = p.functionResponse;
        const i = pending.findIndex((x) => x.name === fr.name);
        const id = String(fr.id ?? (i >= 0 ? pending.splice(i, 1)[0].id : `call_${++n}`));
        msgs.push({ role: "tool", tool_call_id: id, content: JSON.stringify(fr.response?.result ?? fr.response ?? {}) });
      }
      const text = c.parts.filter((p) => typeof p.text === "string").map((p) => p.text).join("\n");
      if (text) msgs.push({ role: "user", content: text });
    }
  }
  return msgs;
}

export function nvidiaLLM(apiKey: string, model: string, baseUrl = "https://integrate.api.nvidia.com/v1"): LLM {
  return {
    name: `nvidia:${model}`,
    live: true,
    async generate(system, history, tools) {
      const body = {
        model,
        messages: toOpenAIMessages(system, history),
        tools: tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: toJsonSchema(t.parameters) },
        })),
        tool_choice: "auto",
        temperature: 0.2,
        // Reasoning models spend part of this budget "thinking" before they answer, so keep it generous.
        max_tokens: Number(process.env.NVIDIA_MAX_TOKENS ?? 2500),
      };
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS ?? 20_000)),
      }).catch((e: Error) => {
        throw new Error(`NVIDIA network/timeout: ${e.message}`);
      });
      if (!res.ok) throw new Error(`NVIDIA request failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
      const json: any = await res.json();
      const msg = json.choices?.[0]?.message;
      // A reply that hit the token limit is cut off mid-sentence: never show that to a customer. Let the chain try the next model.
      if (json.choices?.[0]?.finish_reason === "length" && !msg?.tool_calls?.length)
        throw new Error(`NVIDIA ${model} reply was cut off at the token limit`);
      const parts: Part[] = [];
      if (msg?.content) parts.push({ text: String(msg.content) });
      for (const tc of msg?.tool_calls ?? []) {
        let args: unknown = {};
        try {
          args = JSON.parse(tc.function?.arguments || "{}");
        } catch {
          /* malformed arguments: leave empty, zod validation will reject it */
        }
        parts.push({ functionCall: { name: tc.function?.name, args, id: tc.id } });
      }
      // An empty reply is a failure, not an answer: let the chain try the next model.
      if (!parts.length) throw new Error(`NVIDIA ${model} returned an empty reply`);
      return parts;
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

/** The proposal still waiting for the customer's yes, if the latest account action asked for one. */
function lastProposal(history: Content[]): { tool: string; args: Record<string, unknown> } | undefined {
  for (let i = history.length - 1; i >= 0; i--)
    for (const p of history[i].parts) {
      const fr = p.functionResponse;
      if (fr && (fr.name === "request_refund" || fr.name === "cancel_subscription")) {
        const r = fr.response?.result;
        return r?.status === "needs_confirmation" ? r.proposal : undefined;
      }
    }
  return undefined;
}

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
  /** One scripted step. It uses the same tool loop as a real model, so every guardrail still runs. */
  const step = async (history: Content[]): Promise<Part[]> => {
      const { text, index } = lastUserText(history);
      const msg = text.toLowerCase();
      const res = responsesSince(history, index);
      const intent = /cancel|stop (it|renew)/.test(msg) ? "cancel" : /refund|money back/.test(msg) ? "refund" : "explain";
      const amountMatch = msg.match(/\$?\s?(\d+(?:\.\d{1,2})?)/);
      const amount = amountMatch ? parseFloat(amountMatch[1]) : undefined;

      // The customer said yes to a proposed refund/cancellation: call the same tool again with the same arguments.
      const proposal = lastProposal(history);
      if (res.length === 0 && proposal && /^\s*(yes|yep|yeah|yup|y|ok|okay|sure|confirm|confirmed|go ahead|do it|please do|proceed)\b/.test(msg))
        return [{ functionCall: { name: proposal.tool, args: proposal.args } }];

      // A real person: ask for one, and only promise a reply once the tool has succeeded.
      const handoff = res.find((r) => r.name === "request_human_help")?.response?.result;
      if (handoff) {
        if (handoff.status !== "ok") return [{ text: "I couldn't reach a person just now, and nothing was changed. Please try again in a moment." }];
        return [
          {
            text: `I've asked a person at Acme Digital to follow up (reference ${handoff.data.reference}). They'll reply right here in this chat. I haven't changed anything on your account myself.`,
          },
        ];
      }
      const wantsPerson = /\b(speak|talk|chat) (to|with) (a |an )?(person|human|someone|somebody|agent|representative|manager)\b|\breal person\b|\bhuman (agent|being)\b/.test(msg);
      const keepIt = /^\s*keep it\b/.test(msg) && proposal?.tool === "cancel_subscription";
      if (res.length === 0 && (wantsPerson || keepIt))
        return [
          {
            functionCall: {
              name: "request_human_help",
              args: { topic: keepIt ? "The customer chose to stay and would like the merchant's offer applied to their subscription." : `The customer asked to speak to a person: "${text.slice(0, 200)}"` },
            },
          },
        ];

      // A plain "no" to a proposal: change nothing.
      if (/^\s*(no|nope|nah|never ?mind|keep (it|my))\b/.test(msg)) return [{ text: "No problem. I won't change anything. Is there anything else I can help with?" }];

      // "What can you do?", venting, or anything outside billing: answer from the real skills tool.
      const billingWords = /(refund|money back|cancel|charge|charged|\$|\d|payment|subscription|invoice|bill|renew|stream|cloud|fit|update|status|what happened)/.test(msg);
      if (/\b(what (can|do) you (do|help)|what are your skills|how can you help|what can i ask|your abilities)\b/.test(msg) || !billingWords) {
        const sk = res.find((r) => r.name === "list_my_skills")?.response?.result;
        if (!sk) return [{ functionCall: { name: "list_my_skills", args: {} } }];
        const d = sk.data;
        return [
          {
            text:
              "Here is what I can help with:\n" +
              d.i_can_help_with.map((x: any) => `- ${x.what}: ${x.description}`).join("\n") +
              `\nThings I can't do: ${d.i_cannot.join("; ")}. ${d.if_you_need_more}`,
          },
        ];
      }

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
        if (r.status === "needs_confirmation")
          return [
            {
              text: r.retention
                ? [
                    `I'm sorry to hear you're thinking about leaving ${r.retention.product}.`,
                    `You've been with us since ${r.retention.member_since}, at ${r.retention.price} ${r.retention.interval}.`,
                    r.retention.pitch ? r.retention.pitch : "",
                    `If you'd like to stay, Acme Digital can do this for you: ${r.retention.offer}.`,
                    `Just say "keep it" and I'll pass that on to the team. Or, if you'd rather go ahead, reply "yes" and I'll cancel it right now.`,
                  ]
                    .filter(Boolean)
                    .join(" ")
                : `Before I do this, please confirm: ${r.summary}. Reply "yes" and I'll go ahead.`,
            },
          ];
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
      return [{ text: lines.join("\n") + "\nIs there anything else I can help with?" }];
  };

  return {
    name: "demo-mock",
    live: false,
    async generate(_system, history) {
      const parts = await step(history);
      // Like a real model that has been told to stay kind: an upset customer gets patience first.
      if (detectTone(lastUserText(history).text) === "upset" && !parts.some((p) => p.functionCall) && typeof parts[0]?.text === "string")
        parts[0] = { text: "I'm sorry this has been frustrating, and I understand. " + parts[0].text };
      return parts;
    },
  };
}

/** Tries each LLM in order. `name` always reflects the model that answered last. */
export function chainLLM(llms: LLM[]): LLM {
  const self: LLM = {
    name: llms[0].name,
    primary: llms[0].name,
    live: llms[0].live,
    async generate(system, history, tools) {
      let last: unknown;
      for (const l of llms) {
        try {
          const parts = await l.generate(system, history, tools);
          self.name = l.name;
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

/**
 * Order: the provider named in LLM_PROVIDER first, then the other one if its key exists,
 * then the scripted demo AI. Any provider without a key is skipped.
 */
export function selectLLM(): LLM {
  const env = process.env;
  const nvidia: LLM[] = env.NVIDIA_API_KEY
    ? [...new Set([env.NVIDIA_MODEL ?? "meta/llama-3.3-70b-instruct", env.NVIDIA_FALLBACK_MODEL].filter(Boolean) as string[])].map((m) =>
        nvidiaLLM(env.NVIDIA_API_KEY!, m, env.NVIDIA_BASE_URL),
      )
    : [];
  const gemini: LLM[] = env.GEMINI_API_KEY
    ? [...new Set([env.GEMINI_MODEL ?? "gemini-3-flash-preview", env.GEMINI_FALLBACK_MODEL ?? "gemini-3.1-flash-lite"])].map((m) =>
        geminiLLM(env.GEMINI_API_KEY!, m),
      )
    : [];
  const ordered = (env.LLM_PROVIDER ?? "nvidia") === "gemini" ? [...gemini, ...nvidia] : [...nvidia, ...gemini];
  return ordered.length ? chainLLM([...ordered, mockLLM()]) : mockLLM();
}
