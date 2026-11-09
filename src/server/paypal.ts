import { randomUUID } from "node:crypto";

/** Small typed PayPal REST client (sandbox by default). */

const BASE = (process.env.PAYPAL_ENV ?? "sandbox") === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";

export class PayPalError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    message: string,
  ) {
    super(message);
  }
}

let cached: { token: string; expiresAt: number } | null = null;

export function paypalConfigured(): boolean {
  return Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

async function getToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error("PayPal credentials are not set");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new PayPalError(res.status, json, "PayPal auth failed");
  cached = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cached.token;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /** Idempotency key for create calls. Auto-generated for POST when omitted. */
  requestId?: string;
}

export async function pp<T = any>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await getToken()}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
  if (method === "POST") headers["PayPal-Request-Id"] = opts.requestId ?? randomUUID();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  const json = text ? safeParse(text) : null;
  if (!res.ok) {
    const msg = (json as any)?.message ?? (json as any)?.error_description ?? res.statusText;
    throw new PayPalError(res.status, json, `PayPal ${method} ${path} failed: ${msg}`);
  }
  return json as T;
}

function safeParse(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}
