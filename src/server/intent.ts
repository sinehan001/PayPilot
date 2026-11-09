/**
 * The customer's own words that show they are thinking about leaving, or that a charge is wrong.
 * Shared by the server (to decide whether an AI reply may mention cancelling or refunds) and the
 * client (to decide whether to show those options). Pure patterns, no dependencies.
 */
export const CANCEL_INTENT = /\b(cancel\w*|unsubscribe\w*|stop (?:it|renew\w*|billing|charging)|end (?:my |the )?(?:subscription|plan)|don'?t want (?:it|this))\b/i;

export const REFUND_INTENT =
  /\b(refund\w*|money back|dispute\w*|don'?t recogni[sz]e|do not recogni[sz]e|unauthori[sz]ed|wrong charge|charged twice|double[- ]charged|not mine|didn'?t (?:sign up|order|authori[sz]e))\b/i;

export const hasLeavingOrRefundIntent = (text: string) => CANCEL_INTENT.test(text) || REFUND_INTENT.test(text);
