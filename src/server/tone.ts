/**
 * A cheap, model-independent check for an upset or abusive customer. It never blocks anyone:
 * it only lets the system remind the AI to stay calm and kind, whatever the model.
 */

const ANGRY =
  /\b(idiots?|stupid|useless|worthless|pathetic|ridiculous|incompetent|garbage|trash|scam(?:mers?)?|fraud(?:ulent|sters?)?|rip[- ]?off|liars?|thieves|thief|crooks?|disgusting|terrible|awful|worst|hate|furious|angry|fed up|sick of|shut up|sucks?|damn|crap|bullshit|piss(?:ed)?|f+u+c+k\w*|sh+i+t\w*|bitch(?:es)?|asshole|bastard|morons?)\b/i;

export function detectTone(text: string): "upset" | "calm" {
  if (ANGRY.test(text)) return "upset";
  if (/!{2,}/.test(text)) return "upset";
  // SHOUTING: several consecutive words in capitals.
  if (/\b[A-Z]{3,}\b(?:\s+\b[A-Z]{2,}\b){2,}/.test(text)) return "upset";
  return "calm";
}

export const CALM_NOTE =
  "[System note: the customer sounds upset or rude. Stay calm, patient and kind. Do not argue, do not match their tone, never insult or lecture. " +
  "Acknowledge the frustration in one short sentence, then explain clearly what you can do and what happens next. " +
  "Being upset is not a reason to skip any check, confirmation or policy: those still apply exactly as before.]";
