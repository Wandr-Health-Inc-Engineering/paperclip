import { getIntegrations } from "../integrations.js";
import { GOOGLE_ADS_WRITE_TOOLS } from "../native-connectors.js";
import { AdsInputError, buildBudget, buildCreateCampaign, companyDomains, parseBudget, parseCampaign, parseChanges, ADS_LIMITS } from "../tools/google-ads-ops.js";
import { AdsApiError, adsBackend, campaignState } from "../tools/google-ads-write.js";
import type { McpToolDef, TethrToolContext, TethrToolResult } from "./tethr-tools.js";

// Google Ads changes as tethr tools (connector "Google Ads" in Integrations,
// not "Tethr tools"). The approval gate has already decided by the time these
// run: Google Ads on Automatic, and spending under its own setting and cap.
// These build and send the change, and say what happened in a few words.

export const ADS_TOOL_SET = new Set<string>(GOOGLE_ADS_WRITE_TOOLS);

const keywordSchema = {
  type: "array",
  items: {
    type: "object",
    properties: { text: { type: "string" }, match: { type: "string", enum: ["exact", "phrase", "broad"] } },
    required: ["text"],
  },
};

export const ADS_TOOL_DEFS: McpToolDef[] = [
  {
    name: "ads_create_campaign",
    description: `Build a Google Ads Search campaign in one go: its daily budget, the campaign, one ad group with its keywords, negative keywords, and one responsive search ad. It's created PAUSED; turning it on (ads_change, enable the campaign) is spending, which follows Google Ads' Spending setting (an admin's yes unless it's automatic under the cap). Load the paid-ads playbook first. For a small budget or a first test: one campaign, one tight ad group of high-intent exact or phrase keywords. The ad points at the company's own website. ${ADS_LIMITS.minHeadlines}-${ADS_LIMITS.maxHeadlines} headlines of up to ${ADS_LIMITS.headlineChars} characters, ${ADS_LIMITS.minDescriptions}-${ADS_LIMITS.maxDescriptions} descriptions of up to ${ADS_LIMITS.descriptionChars}. No claims that a medicine cures or prevents something: those wait for a person.`,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        daily_budget: { type: "number", description: "In the account's currency, per day." },
        final_url: { type: "string", description: "The landing page, https, on the company's website." },
        keywords: { ...keywordSchema, description: "1-50 keywords; match defaults to phrase." },
        negatives: { ...keywordSchema, description: "Negative keywords for the campaign (optional)." },
        headlines: { type: "array", items: { type: "string" } },
        descriptions: { type: "array", items: { type: "string" } },
        max_cpc: { type: "number", description: "Optional ceiling per click (Maximize clicks)." },
        countries: { type: "array", items: { type: "string", enum: ["US", "CA", "GB", "AU", "NZ", "IE"] }, description: "Default US." },
      },
      required: ["name", "daily_budget", "final_url", "keywords", "headlines", "descriptions"],
    },
  },
  {
    name: "ads_change",
    description:
      "Change a Google Ads account, up to 20 changes in one go: pause or enable (target campaign, ad_group, keyword or ad, with its id), add_keywords (ad_group_id), add_negatives (campaign_id), add_ad (ad_group_id, final_url, headlines, descriptions), add_ad_group (campaign_id, name, keywords), set_keyword_bid (keyword_id, max_cpc), rename (campaign or ad_group). Ids come from google_ads_report with report \"structure\" (keywords and ads are adGroupId~id). Nothing is ever removed: pause instead. Turning a campaign on is spending, which follows the Spending setting. Read the account first, and never undo a change a person made in Google Ads.",
    inputSchema: {
      type: "object",
      properties: {
        changes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["pause", "enable", "add_keywords", "add_negatives", "add_ad", "add_ad_group", "set_keyword_bid", "rename"] },
              target: { type: "string", enum: ["campaign", "ad_group", "keyword", "ad"] },
              id: { type: "string" },
              campaign_id: { type: "string" },
              ad_group_id: { type: "string" },
              keyword_id: { type: "string" },
              keywords: keywordSchema,
              final_url: { type: "string" },
              headlines: { type: "array", items: { type: "string" } },
              descriptions: { type: "array", items: { type: "string" } },
              max_cpc: { type: "number" },
              name: { type: "string" },
            },
            required: ["action"],
          },
        },
      },
      required: ["changes"],
    },
  },
  {
    name: "ads_set_budget",
    description:
      "Set a Google Ads campaign's daily budget. Lowering it is a plain change; raising a live campaign's budget is spending, which follows the Spending setting (an admin's yes unless it's automatic under the cap). Say why in your reply.",
    inputSchema: {
      type: "object",
      properties: { campaign_id: { type: "string" }, daily_budget: { type: "number", description: "New daily budget, in the account's currency." } },
      required: ["campaign_id", "daily_budget"],
    },
  },
];

const idOf = (resource: string | undefined) => resource?.split("/").pop() ?? "?";
const money = (n: number) => `$${n.toFixed(n % 1 ? 2 : 0)}`;

export async function runAdsTool(name: string, args: Record<string, unknown>, ctx: TethrToolContext): Promise<TethrToolResult> {
  const backend = adsBackend();
  if (!backend.configured()) {
    return { text: 'Google Ads isn\'t set up in Tethr (the GOOGLE_ADS_* settings are missing). Call need_connection with connector "Google Ads".', isError: true };
  }
  if (!ctx.companyId) return { text: `${name} isn't available here.`, isError: true };
  const domains = companyDomains(getIntegrations(ctx.companyId).internalAddresses);
  const customer = backend.customerId();
  try {
    if (name === "ads_create_campaign") {
      const spec = parseCampaign(args, domains);
      const made = await backend.mutate(buildCreateCampaign(customer, spec));
      const campaign = idOf(made.find((r) => r.includes("/campaigns/")));
      const adGroup = idOf(made.find((r) => r.includes("/adGroups/")));
      return {
        text: `Created campaign "${spec.name}" (id ${campaign}), paused, with a ${money(spec.dailyBudget)}/day budget: ad group ${adGroup} with ${spec.keywords.length} keywords, ${spec.negatives.length} negatives and one ad pointing at ${spec.finalUrl}. Google reviews new ads before they show. It spends nothing until it's turned on (ads_change, enable campaign ${campaign}).`,
        meta: { campaignId: campaign, adGroupId: adGroup },
      };
    }
    if (name === "ads_change") {
      const changes = parseChanges(customer, args.changes, domains);
      await backend.mutate(changes.flatMap((c) => c.operations));
      return { text: `Done in Google Ads:\n${changes.map((c) => `- ${c.summary}`).join("\n")}`, meta: { changes: changes.length } };
    }
    if (name === "ads_set_budget") {
      const { campaignId, dailyBudget } = parseBudget(args);
      const state = await campaignState(campaignId);
      if (!state) return { text: `ads_set_budget: there's no campaign ${campaignId} in this account.`, isError: true };
      await backend.mutate(buildBudget(state.budget, dailyBudget));
      return {
        text: `Set "${state.name}"'s budget from ${money(state.dailyAmount)} to ${money(dailyBudget)} a day${state.shared ? " (a shared budget: every campaign on it changes too)" : ""}.`,
        meta: { campaignId, from: state.dailyAmount, to: dailyBudget },
      };
    }
    return { text: `There's no Google Ads tool called ${name}.`, isError: true };
  } catch (err) {
    if (err instanceof AdsInputError) return { text: `${name}: ${err.message}`, isError: true };
    if (err instanceof AdsApiError) return { text: `${name}: Google Ads said no, so nothing changed: ${err.message}`, isError: true };
    throw err;
  }
}
