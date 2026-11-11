// Deterministic fixtures used when TETHR_LIVE_FETCH is off (default) so the
// whole product demos offline and tests stay reproducible. Shapes mirror what
// the live fetchers return.

export const REDDIT_FIXTURE = {
  travel: [
    {
      title: "Typhoid + malaria prep for 3 weeks in Tanzania — what do I actually need?",
      subreddit: "travel",
      author: "u/backpack_meg",
      ups: 41,
      num_comments: 14,
      created_hours_ago: 3,
      selftext:
        "Leaving in 6 weeks for Tanzania (Dar, Zanzibar, then a safari). My GP seems unsure about malaria pills vs just repellent. Do I need typhoid too? Trying not to overpay at a travel clinic.",
      permalink: "/r/travel/comments/fx1a/typhoid_malaria_prep_tanzania",
    },
    {
      title: "Altitude meds for Cusco — do I really need them?",
      subreddit: "solotravel",
      author: "u/quietcartographer",
      ups: 18,
      num_comments: 22,
      created_hours_ago: 2,
      selftext:
        "Flying Lima → Cusco and going straight to the Sacred Valley. Half this sub says acetazolamide, half says coca tea is enough. Who's right?",
      permalink: "/r/solotravel/comments/fx2b/altitude_meds_cusco",
    },
    {
      title: "Passport Health quoted $280 for a consult — alternatives?",
      subreddit: "travel",
      author: "u/frugal_flier",
      ups: 9,
      num_comments: 7,
      created_hours_ago: 5,
      selftext:
        "That's before any vaccines. Is there a cheaper way to get trip-specific advice that isn't just WebMD?",
      permalink: "/r/travel/comments/fx3c/passport_health_alternatives",
    },
  ],
};

export const CDC_FIXTURE = [
  {
    source: "CDC Travel Health Notices",
    title: "Dengue in the Americas — Level 1 notice expanded to additional Caribbean islands",
    published_days_ago: 1,
    summary:
      "CDC expanded its dengue notice; travelers should prevent mosquito bites and consider timing of travel during outbreak season.",
    url: "https://wwwnc.cdc.gov/travel/notices/level1/dengue-americas",
  },
  {
    source: "WHO Disease Outbreak News",
    title: "Cholera — situation update, East Africa",
    published_days_ago: 2,
    summary:
      "Ongoing transmission in several districts; food and water precautions advised for travelers.",
    url: "https://www.who.int/emergencies/disease-outbreak-news/cholera-east-africa",
  },
  {
    source: "US State Department",
    title: "Peru — travel advisory reviewed (Level 2: exercise increased caution)",
    published_days_ago: 4,
    summary: "Advisory reviewed with regional notes for Cusco and the Sacred Valley.",
    url: "https://travel.state.gov/content/travel/en/traveladvisories/peru",
  },
];

export const GENERIC_FETCH_FIXTURE = (url: string) =>
  [
    `# Offline fixture for ${url}`,
    "",
    "TETHR_LIVE_FETCH is off, so this is a deterministic stand-in for the page.",
    "Key facts a fetch would surface: travel-health guidance is destination- and",
    "season-specific; CDC/WHO are the citable sources; consult timing matters",
    "(4–6 weeks before departure).",
  ].join("\n");
