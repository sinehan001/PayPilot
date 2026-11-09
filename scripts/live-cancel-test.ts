import "dotenv/config";
import { callTool } from "../src/server/tools.ts";
import { ppGetSubscription } from "../src/server/paypalOps.ts";
import * as store from "../src/server/store.ts";

const s = store.getSubscription("S-1002")!;
console.log("before: local", s.status, "| linked paypal id:", s.paypal_id);
const ppId = s.paypal_id!;
console.log("before: PayPal says", (await ppGetSubscription(ppId)).status);
const r = await callTool("cancel_subscription", { subscription_id: "S-1002", reason: "Customer asked to cancel (live test)" }, { customer: store.DEMO_CUSTOMER });
console.log("tool result:", JSON.stringify(r));
console.log("after: PayPal says", (await ppGetSubscription(ppId)).status);
console.log("after: local", store.getSubscription("S-1002")!.status, "| link now:", store.getSubscription("S-1002")!.paypal_id);
