import { AREA_IDS, type AreaId } from "./areas.js";

// Keyword rules that place something tethr knows (a note, a skill), a goal
// metric or an agent on the growth map when nobody said which area it belongs
// to (phase 26.9). Deliberately narrow: a word that could mean two areas
// ("campaign", "plan") isn't a rule. Jev takes this over once it decides (26.2).

const RULES: Record<AreaId, RegExp[]> = {
  positioning: [
    /\bposition(ing|ed)?\b/,
    /\bvalue prop(osition)?s?\b/,
    /\bmessaging\b/,
    /\btagline\b/,
    /\bdifferentiat\w*/,
    /\bcompetitors?\b/,
    /\bideal customer\b/,
    /\bicp\b/,
    /\bbrand (story|promise|voice)\b/,
  ],
  content: [
    /\bcontent\b/,
    /\bblog\w*\b/,
    /\barticles?\b/,
    /\bsocial( media)?\b/,
    /\b(instagram|tiktok|linkedin|youtube|reddit|pinterest)\b/,
    /\bcopywriting\b/,
    /\beditorial\b/,
    /\bvideos?\b/,
  ],
  seo: [
    /\bseo\b/,
    /\bkeywords?\b/,
    /\bsearch volume\b/,
    /\borganic (traffic|search|sessions|clicks)\b/,
    /\brankings?\b/,
    /\bbacklinks?\b/,
    /\bserps?\b/,
    /\bmeta (title|description)s?\b/,
    /\bsearch console\b/,
    /\bsitemap\b/,
  ],
  geo: [
    /\bgeo\b/,
    /\bai search\b/,
    /\bai overviews?\b/,
    /\b(chatgpt|perplexity|gemini)\b/,
    /\bllms?\b/,
    /\bcit(ed|ation|ations)\b/,
    /\banswer engines?\b/,
  ],
  paid_ads: [
    /\b(google|meta|facebook|instagram|linkedin|tiktok) ads\b/,
    /\bpaid (search|social|ads|media)\b/,
    /\bad (spend|copy|creative|campaigns?|budget)\b/,
    /\b(ppc|cpc|cpa|roas|cpm)\b/,
    /\bretargeting\b/,
  ],
  measurement: [
    /\banalytics\b/,
    /\b(event|conversion|ad|pixel|server-side) tracking\b/,
    /\btracking (plan|code|pixel|events?)\b/,
    /\bposthog\b/,
    /\b(ga4|google analytics|gtm|tag manager)\b/,
    /\battribution\b/,
    /\bdashboards?\b/,
    /\bscorecards?\b/,
    /\butms?\b/,
    /\bkpis?\b/,
  ],
  customer_voice: [
    /\bcustomer (feedback|research|interviews?|voice|quotes?)\b/,
    /\bfeedback\b/,
    /\b(customer|product|google|online|star|app store) reviews?\b/,
    /\btestimonials?\b/,
    /\bsurveys?\b/,
    /\binterviews?\b/,
    /\bcomplaints?\b/,
    /\bnps\b/,
    /\bsupport tickets?\b/,
    /\bjobs to be done\b/,
    /\bpersonas?\b/,
  ],
  conversion: [
    /\bconversions?\b/,
    /\bconvert(s|ed|ing)?\b/,
    /\blanding pages?\b/,
    /\bcheckout\b/,
    /\bsign[- ]?ups?\b/,
    /\bfunnels?\b/,
    /\ba\/b tests?\b/,
    /\bcro\b/,
    /\bbounce rate\b/,
    /\bdrop[- ]?off\b/,
  ],
  pricing: [
    /\bpric(e|es|ing)\b/,
    /\bdiscounts?\b/,
    /\b(special|limited|launch|intro(ductory)?|bundle) offers?\b/,
    /\bbundles?\b/,
    /\bcoupons?\b/,
    /\bpromo(tion)?s?\b/,
    /\bupsells?\b/,
    /\baverage order value\b/,
    /\baov\b/,
  ],
  retention: [
    /\bretention\b/,
    /\bretain\w*/,
    /\bchurn\w*/,
    /\brepeat (customers?|purchases?|orders?)\b/,
    /\brenewals?\b/,
    /\brefills?\b/,
    /\bwin[- ]?back\b/,
    /\bloyalty\b/,
    /\bcancell?ations?\b/,
  ],
  email: [
    /\bemails?\b/,
    /\bnewsletters?\b/,
    /\bdrip\b/,
    /\b(email )?sequences?\b/,
    /\blifecycle\b/,
    /\bnurture\b/,
    /\bcold (email|outreach)\b/,
    /\blead magnets?\b/,
  ],
  partnerships: [
    /\bpartners?(hips?)?\b/,
    /\baffiliates?\b/,
    /\breferrals?\b/,
    /\bresellers?\b/,
    /\bco-marketing\b/,
    /\bsponsor(s|ship|ships)?\b/,
    /\bdistribution\b/,
    /\bb2b\b/,
  ],
};

/** How strongly a text points at each area (one point per rule that matches). */
export function areaScores(text: string): Map<AreaId, number> {
  const lower = text.toLowerCase();
  const scores = new Map<AreaId, number>();
  for (const id of AREA_IDS) {
    const hits = RULES[id].filter((re) => re.test(lower)).length;
    if (hits) scores.set(id, hits);
  }
  return scores;
}

/** The one area a text is clearly about, or null (no rule matched, or two areas tie). */
export function sortIntoArea(text: string): AreaId | null {
  const ranked = [...areaScores(text).entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return null;
  return ranked[0][0];
}
