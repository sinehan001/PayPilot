import "dotenv/config";
import { pp } from "../src/server/paypal.ts";

// M1 spike: prove the PayPal sandbox flow we need. Never prints secrets.
async function main() {
  console.log("1) create product");
  const product = await pp("/v1/catalogs/products", {
    method: "POST",
    body: { name: "PayPilot Demo Streaming", type: "SERVICE", category: "SOFTWARE" },
  });
  console.log("   product id:", product.id);

  console.log("2) create monthly plan $14.99");
  const plan = await pp("/v1/billing/plans", {
    method: "POST",
    body: {
      product_id: product.id,
      name: "Demo Monthly",
      status: "ACTIVE",
      billing_cycles: [
        {
          frequency: { interval_unit: "MONTH", interval_count: 1 },
          tenure_type: "REGULAR",
          sequence: 1,
          total_cycles: 0,
          pricing_scheme: { fixed_price: { value: "14.99", currency_code: "USD" } },
        },
      ],
      payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3 },
    },
  });
  console.log("   plan id:", plan.id, "status:", plan.status);

  console.log("3) create subscription");
  const sub = await pp("/v1/billing/subscriptions", {
    method: "POST",
    body: {
      plan_id: plan.id,
      application_context: {
        brand_name: "PayPilot Demo",
        user_action: "SUBSCRIBE_NOW",
        return_url: "http://localhost:3001/return",
        cancel_url: "http://localhost:3001/cancel",
      },
    },
  });
  console.log("   subscription id:", sub.id, "status:", sub.status);
  console.log("   approve link:", sub.links?.find((l: any) => l.rel === "approve")?.href);

  console.log("4) read subscription back");
  const got = await pp(`/v1/billing/subscriptions/${sub.id}`);
  console.log("   status:", got.status, "| plan:", got.plan_id);

  console.log("5) list invoices (invoicing scope)");
  try {
    const inv = await pp("/v2/invoicing/invoices?page=1&page_size=3&total_required=true");
    console.log("   invoices total:", inv.total_items ?? 0);
  } catch (e: any) {
    console.log("   invoicing:", e.message);
  }

  console.log("6) list disputes (disputes scope)");
  try {
    const d = await pp("/v1/customer/disputes?page_size=3");
    console.log("   disputes returned:", d.items?.length ?? 0);
  } catch (e: any) {
    console.log("   disputes:", e.message);
  }

  console.log("7) transaction search (last 3 days)");
  try {
    const end = new Date();
    const start = new Date(end.getTime() - 3 * 24 * 3600 * 1000);
    const t = await pp(
      `/v1/reporting/transactions?start_date=${start.toISOString()}&end_date=${end.toISOString()}&fields=all&page_size=5`,
    );
    console.log("   transactions:", t.transaction_details?.length ?? 0);
  } catch (e: any) {
    console.log("   transactions:", e.message);
  }
}

main().catch((e) => {
  console.error("SPIKE FAILED:", e.message, JSON.stringify(e.body ?? {}).slice(0, 400));
  process.exit(1);
});
