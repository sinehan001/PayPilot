import "dotenv/config";
import { db } from "../src/server/db.ts";
import { ppCaptureOrder, ppCreateOrder, ppCreatePlan, ppCreateSubscription, ppGetOrder, ppGetSubscription } from "../src/server/paypalOps.ts";
import * as store from "../src/server/store.ts";

/**
 * npm run paypal:setup  -> creates real SANDBOX objects and prints approval links
 * npm run paypal:sync   -> after you approve them as a sandbox buyer, links them to the demo rows
 */
type Pending = Record<string, { kind: "subscription" | "order"; id: string; url?: string }>;
const RETURN = "http://localhost:3001/return";

const getPending = (): Pending => {
  const r = db.prepare("select value from settings where key='paypal_pending'").get() as { value: string } | undefined;
  return r ? JSON.parse(r.value) : {};
};
const savePending = (p: Pending) =>
  db
    .prepare("insert into settings(key,value) values('paypal_pending',?) on conflict(key) do update set value=excluded.value")
    .run(JSON.stringify(p));

async function setup() {
  store.seedIfEmpty();
  const pending: Pending = {};
  const plan = await ppCreatePlan("CloudNotes Pro", 4.99);
  const sub = await ppCreateSubscription(plan, RETURN);
  pending["S-1002"] = { kind: "subscription", id: sub.id, url: sub.approveUrl };
  const o1 = await ppCreateOrder(14.99, "StreamBox Premium monthly", RETURN);
  pending["C-2001"] = { kind: "order", id: o1.id, url: o1.approveUrl };
  const o2 = await ppCreateOrder(89.0, "FitTrack Annual renewal", RETURN);
  pending["C-2004"] = { kind: "order", id: o2.id, url: o2.approveUrl };
  savePending(pending);
  console.log("Created real PayPal SANDBOX objects. Open each link, log in as a sandbox PERSONAL (buyer) account, and approve:\n");
  for (const [row, p] of Object.entries(pending)) console.log(`${row} (${p.kind} ${p.id})\n  ${p.url}\n`);
  console.log("Then run: npm run paypal:sync");
}

async function sync() {
  store.seedIfEmpty();
  const pending = getPending();
  if (!Object.keys(pending).length) return console.log("Nothing pending. Run npm run paypal:setup first.");
  for (const [row, p] of Object.entries(pending)) {
    try {
      if (p.kind === "subscription") {
        const s = await ppGetSubscription(p.id);
        if (s.status === "ACTIVE") {
          store.linkPaypal(row, p.id);
          delete pending[row];
          console.log(`${row}: linked (subscription ACTIVE)`);
        } else console.log(`${row}: subscription is ${s.status}, not approved yet`);
      } else {
        const o = await ppGetOrder(p.id);
        let captureId: string | undefined = o.purchase_units?.[0]?.payments?.captures?.[0]?.id;
        if (!captureId && o.status === "APPROVED") captureId = (await ppCaptureOrder(p.id)).captureId;
        if (captureId) {
          store.linkPaypal(row, captureId);
          delete pending[row];
          console.log(`${row}: linked (capture ${captureId})`);
        } else console.log(`${row}: order is ${o.status}, not approved yet`);
      }
    } catch (e: any) {
      console.log(`${row}: error ${e.message}`);
    }
  }
  savePending(pending);
  console.log("Active links:", store.getLinks());
}

const cmd = process.argv[2];
if (cmd === "setup") await setup();
else if (cmd === "sync") await sync();
else console.log("usage: tsx scripts/paypal-link.ts setup|sync");
