import { pp } from "./paypal.ts";

/** Thin wrappers over the PayPal REST endpoints PayPilot uses (sandbox). */

export const ppGetSubscription = (id: string) => pp(`/v1/billing/subscriptions/${id}`);

export const ppCancelSubscription = (id: string, reason: string) =>
  pp(`/v1/billing/subscriptions/${id}/cancel`, { method: "POST", body: { reason: reason.slice(0, 120) } });

export async function ppRefundCapture(captureId: string, amount: number, note: string, requestId?: string) {
  return pp(`/v2/payments/captures/${captureId}/refund`, {
    method: "POST",
    requestId,
    body: { amount: { value: amount.toFixed(2), currency_code: "USD" }, note_to_payer: note.slice(0, 255) },
  });
}

export async function ppCreateOrder(amount: number, description: string, returnUrl: string) {
  const order = await pp("/v2/checkout/orders", {
    method: "POST",
    body: {
      intent: "CAPTURE",
      purchase_units: [{ description, amount: { currency_code: "USD", value: amount.toFixed(2) } }],
      payment_source: {
        paypal: { experience_context: { return_url: returnUrl, cancel_url: returnUrl, user_action: "PAY_NOW", brand_name: "PayPilot Demo" } },
      },
    },
  });
  const link = order.links?.find((l: any) => l.rel === "payer-action" || l.rel === "approve")?.href as string | undefined;
  return { id: order.id as string, status: order.status as string, approveUrl: link };
}

export const ppGetOrder = (id: string) => pp(`/v2/checkout/orders/${id}`);

export async function ppCaptureOrder(id: string) {
  const r = await pp(`/v2/checkout/orders/${id}/capture`, { method: "POST", body: {} });
  return { status: r.status as string, captureId: r.purchase_units?.[0]?.payments?.captures?.[0]?.id as string | undefined };
}

export async function ppCreateSubscription(planId: string, returnUrl: string) {
  const sub = await pp("/v1/billing/subscriptions", {
    method: "POST",
    body: { plan_id: planId, application_context: { brand_name: "PayPilot Demo", user_action: "SUBSCRIBE_NOW", return_url: returnUrl, cancel_url: returnUrl } },
  });
  return { id: sub.id as string, status: sub.status as string, approveUrl: sub.links?.find((l: any) => l.rel === "approve")?.href as string | undefined };
}

export async function ppCreatePlan(name: string, price: number) {
  const product = await pp("/v1/catalogs/products", { method: "POST", body: { name, type: "SERVICE", category: "SOFTWARE" } });
  const plan = await pp("/v1/billing/plans", {
    method: "POST",
    body: {
      product_id: product.id,
      name: `${name} Monthly`,
      status: "ACTIVE",
      billing_cycles: [
        {
          frequency: { interval_unit: "MONTH", interval_count: 1 },
          tenure_type: "REGULAR",
          sequence: 1,
          total_cycles: 0,
          pricing_scheme: { fixed_price: { value: price.toFixed(2), currency_code: "USD" } },
        },
      ],
      payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3 },
    },
  });
  return plan.id as string;
}
