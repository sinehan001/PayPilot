import "dotenv/config";
import { callTool } from "../src/server/tools.ts";
import { pp } from "../src/server/paypal.ts";
import * as store from "../src/server/store.ts";

store.resetAndSeed();
const cap = store.getCharge("C-2001")!.paypal_id!;
console.log("before: PayPal capture status:", (await pp(`/v2/payments/captures/${cap}`)).status);
const r = await callTool("request_refund", { charge_id: "C-2001", amount: 14.99, reason: "Customer did not recognise the charge (live test)" }, { customer: store.DEMO_CUSTOMER });
console.log("tool result:", JSON.stringify(r));
console.log("after: PayPal capture status:", (await pp(`/v2/payments/captures/${cap}`)).status);
console.log("after: local:", store.getCharge("C-2001")!.status, "| links left:", store.getLinks());
