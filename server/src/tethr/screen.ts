// Checks that run on this computer before text is kept or sent anywhere:
// - personalHealthReason: does it tie a particular person to a health detail?
//   tethr never saves that (memory, skills, the search index) and never sends it
//   to an outside service.
// - injectionReason: does it read like an instruction to tethr, not a fact?
// Both are tripwires, not guarantees: they catch the plain cases cheaply. The
// persona's own rule and the Memory page (who saved what) are the other layers.
//
// The business is travel medicine, so health WORDS are everywhere ("malaria
// pills", "not recommended in pregnancy", "altitude sickness symptoms") and must
// pass. Only a health detail ABOUT ONE PERSON is flagged: a sentence has to bind
// a person (a name, "the patient", "a customer's", he/she) to the detail.

/** Details that are personal whenever they're said about someone. */
const STRONG =
  "diagnos\\w*|prescri\\w*|symptoms?|allerg\\w*|pregnan\\w*|miscarr\\w*|medical history|medical condition|lab results?|test results?|tested positive|" +
  "medications?|side effects?|hiv|aids|diabet\\w*|cancer|asthma|epilep\\w*|seizures?|depress\\w*|anxiety|bipolar|adhd|hypertension|blood pressure|heart condition|stroke";
const DRUG = "malarone|atovaquone|doxycycline|mefloquine|azithromycin|cipro\\w*|acetazolamide|scopolamine|antimalarials?";
const DISEASE = "malaria|typhoid|hepatitis|covid|dengue|cholera";
const ANY_CLINICAL = `${STRONG}|${DRUG}|${DISEASE}`;

const ANY_RE = new RegExp(`\\b(?:${ANY_CLINICAL})\\b`, "i");
const STRONG_RE = new RegExp(`\\b(?:${STRONG})\\b`, "i");
const CLINICAL_WORD = new RegExp(`^(?:${ANY_CLINICAL})$`, "i");

/** Capitalized words that start sentences or name things, not people. */
const NOT_A_NAME = new Set(
  "the this that these those our we it they their each every most some many all no if when top new old one two any both use see ask send add keep note for from with without about after before during per wandr tethr hermes jev claude stripe google gmail slack posthog drive mercury canva figma clay reddit monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december".split(
    " ",
  ),
);

/** The word right before the verb; namedPerson() checks it's a capitalized name. */
const SUBJECT = "([A-Za-z]{2,21})";
const FILL = "(?:\\s+(?:been|being|currently|also|still|now|just|recently|a|an|to|for|of|with|from))*";
/** What can stand between a person and each kind of detail ("has", "takes", "caught"). */
const BINDS: Array<[verbs: string, detail: string]> = [
  ["has|had|have|is|was|got|gets|suffers|suffered|reported|developed", STRONG],
  ["takes|took|is taking|was taking|is on|was on|uses|used|was prescribed|is prescribed|got|needs|needed", DRUG],
  ["has|had|got|caught|contracted|was diagnosed|tested positive", DISEASE],
];
const NAMED = BINDS.map(([verbs, detail]) => new RegExp(`\\b${SUBJECT}\\s+(?:${verbs})${FILL}\\s+(?:${detail})\\b`, "gi"));
const HE_SHE = BINDS.map(([verbs, detail]) => new RegExp(`\\b(?:he|she)\\s+(?:${verbs})${FILL}\\s+(?:${detail})\\b`, "i"));
/** "her prescription", "his test results". */
const HIS_HER = new RegExp(`\\b(?:his|her)\\s+(?:\\w+\\s+){0,2}(?:${STRONG})\\b`, "i");

const NOT_A_PERSON_NOUN = "support|service|success|experience|journey|base|data|list|segment|feedback|reviews?|acquisition|interactions?|questions?|portal|intake|forms?|flow|volume|count|numbers?|wall";
/** "the patient", "this patient's", "patient 4412": always a clinical context. */
const ONE_PATIENT = new RegExp(`\\b(?:a|the|this|that|our|my|one|another)\\s+patient\\b(?!\\s+(?:${NOT_A_PERSON_NOUN})\\b)|\\bpatient's\\b|\\bpatient\\s+#?\\d+\\b`, "i");
/** "a customer", "the client's", "customer 4412": one customer, not customers in general. */
const ONE_CUSTOMER = new RegExp(
  `\\b(?:a|the|this|that|one|another)\\s+(?:customer|client|traveler|traveller)\\b(?!\\s+(?:${NOT_A_PERSON_NOUN})\\b)|\\b(?:customer|client|traveler|traveller)'s\\b|\\b(?:customer|client)\\s+#?\\d+\\b`,
  "i",
);
const CONTACT = /[\w.+-]+@[\w-]+\.[\w.-]+|\b(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b|\b(?:dob|date of birth)\b/i;

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim());
}

/** A real name bound to a detail ("Jane Doe has…"), not "Malarone is…" or "Stripe has…". */
function namedPerson(sentence: string): boolean {
  for (const re of NAMED) {
    re.lastIndex = 0;
    for (let m = re.exec(sentence); m; m = re.exec(sentence)) {
      const subject = m[1]!;
      if (/^[A-Z][a-z]+$/.test(subject) && !NOT_A_NAME.has(subject.toLowerCase()) && !CLINICAL_WORD.test(subject)) return true;
    }
  }
  return false;
}

/** Why this text looks like one person's health information, or null. */
export function personalHealthReason(text: string): string | null {
  if (!text || !ANY_RE.test(text)) return null;
  for (const s of sentences(text)) {
    if (!ANY_RE.test(s)) continue;
    const strong = STRONG_RE.test(s);
    const bound =
      ONE_PATIENT.test(s) ||
      (strong && (ONE_CUSTOMER.test(s) || CONTACT.test(s))) ||
      HIS_HER.test(s) ||
      HE_SHE.some((re) => re.test(s)) ||
      namedPerson(s);
    if (bound) return "it ties a particular person to a health detail";
  }
  return null;
}

export const HEALTH_REFUSAL =
  "That looks like a particular person's health information, which tethr never saves. If it's about the business (a product, a rule, a pattern across customers), say it without the person.";

const INJECTION: Array<[RegExp, string]> = [
  [/\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|any|your)\b[^.\n]{0,20}\b(?:instructions?|rules?|prompts?|messages?|guidelines?)\b/i, "it tells tethr to ignore its instructions"],
  [/\b(?:system prompt|developer message|hidden instructions?)\b/i, "it talks about tethr's own instructions"],
  [/\byou (?:are|must) now\b|\bfrom now on,? (?:you|always|never)\b|\bnew instructions?:/i, "it reads like new instructions for tethr"],
  [/\b(?:do not|don't|never) (?:tell|inform|mention|reveal)[^.\n]{0,30}\b(?:user|team|person|anyone)\b/i, "it tells tethr to hide something from the team"],
  [/<\/?(?:system|assistant|instructions?)>|\[\[?(?:system|inst)\]?\]/i, "it imitates a system message"],
];

/** Why this text reads like an instruction to tethr instead of a fact to keep, or null. */
export function injectionReason(text: string): string | null {
  for (const [re, why] of INJECTION) if (re.test(text)) return why;
  return null;
}

// ---- Card numbers and keys (phase 26.3) -----------------------------------------
// Before a file's text goes to Jev, it's checked here on the Mac. A payment card
// number or a secret key means "a person looks at this": nothing is sent and
// nothing is filed on its own.

const KEY_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, "a private key"],
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/, "a Stripe secret key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "a GitHub token"],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "a Google API key"],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}/, "an API key"],
  [/\bvck_[A-Za-z0-9]{20,}/, "a Vercel key"],
];

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Why this text holds a payment card number or a secret key, or null. */
export function secretReason(text: string): string | null {
  for (const [re, what] of KEY_PATTERNS) if (re.test(text)) return `it contains ${what}`;
  for (const m of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && /^[3-6]/.test(digits) && luhn(digits)) return "it contains what looks like a payment card number";
  }
  return null;
}

/** Why a person has to look at this before anything else happens, or null. */
export function needsPersonReason(text: string): string | null {
  return personalHealthReason(text) ?? secretReason(text);
}

// ---- Medical claims (phase 26.6) ----------------------------------------------------
// A lesson the learner brings back is about growing the business. One that makes
// a medical claim (what a drug does, a dose, a diagnosis) is dropped: that's a
// licensed person's call, never tethr's.

const MEDICAL_CLAIM: RegExp[] = [
  /\b(?:cures?|cured)\b/i,
  /\bprevents? (?:malaria|disease|infections?|illness|sickness|[a-z]+ fever)\b/i,
  /\b(?:dosage|dosing|doses? of|mg\b|milligrams?)\b/i,
  /\bside[- ]effects?\b/i,
  /\bcontraindicat\w*/i,
  /\b(?:efficacy|effective against|clinically proven)\b/i,
  /\bdiagnos(?:e|es|ed|is|ing)\b/i,
  /\b(?:take|taking|prescribe|prescribing) (?:it|them|this|these|\w+(?:quine|mycin|cillin|floxacin|zole|prazole))\b/i,
];

/** Why this text makes a medical claim, or null. */
export function medicalClaimReason(text: string): string | null {
  return MEDICAL_CLAIM.some((re) => re.test(text)) ? "it makes a medical claim, which is a licensed person's call" : null;
}
