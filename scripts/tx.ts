import "dotenv/config";
import { pp } from "../src/server/paypal.ts";
const end = new Date();
const start = new Date(end.getTime() - 3 * 24 * 3600 * 1000);
pp(`/v1/reporting/transactions?start_date=${start.toISOString()}&end_date=${end.toISOString()}&fields=all&page_size=5`)
  .then((t: any) => console.log("transaction search OK, returned:", t.transaction_details?.length ?? 0))
  .catch((e) => console.log("still failing:", e.message));
