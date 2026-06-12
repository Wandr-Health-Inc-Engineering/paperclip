// Tethr add-on constants. Kept in one module so the Tethr layer's vocabulary
// is additive to core and easy to diff against upstream.

export const TETHR_DIVISION_STATUSES = ["active", "shell"] as const;
export type TethrDivisionStatus = (typeof TETHR_DIVISION_STATUSES)[number];

export const TETHR_SENSITIVITIES = [
  "medical",
  "public",
  "spend",
  "pr",
  "internal",
  "safe",
] as const;
export type TethrSensitivity = (typeof TETHR_SENSITIVITIES)[number];

/** Sensitivities that hard-block publish behind a human approval. */
export const TETHR_GATED_SENSITIVITIES: readonly TethrSensitivity[] = [
  "medical",
  "public",
  "spend",
  "pr",
];

export const TETHR_OUTPUT_STATUSES = [
  "draft",
  "gated",
  "changes_requested",
  "approved",
  "published",
  "rejected",
] as const;
export type TethrOutputStatus = (typeof TETHR_OUTPUT_STATUSES)[number];

export const TETHR_OUTPUT_KINDS = [
  "lead_digest",
  "reply_draft",
  "news_digest",
  "blog_draft",
  "brief",
  "itinerary",
  "press_release",
  "ads_recommendation",
  "analytics_report",
  "icp_profile",
  "messaging",
  "document",
] as const;
export type TethrOutputKind = (typeof TETHR_OUTPUT_KINDS)[number];

export const TETHR_ROUTE_RUN_STATUSES = [
  "routing",
  "working",
  "gated",
  "done",
  "failed",
] as const;
export type TethrRouteRunStatus = (typeof TETHR_ROUTE_RUN_STATUSES)[number];

export const TETHR_ROUTE_INVOCATION_SOURCES = [
  "console",
  "heartbeat",
  "api",
] as const;
export type TethrRouteInvocationSource =
  (typeof TETHR_ROUTE_INVOCATION_SOURCES)[number];

export const TETHR_DRIVE_NODE_KINDS = ["folder", "file"] as const;
export type TethrDriveNodeKind = (typeof TETHR_DRIVE_NODE_KINDS)[number];

export const TETHR_MEMORY_KINDS = [
  "fact",
  "preference",
  "history",
  "rule",
] as const;
export type TethrMemoryKind = (typeof TETHR_MEMORY_KINDS)[number];

export const TETHR_NOTIFICATION_KINDS = [
  "approval",
  "run",
  "lead",
  "budget",
  "system",
] as const;
export type TethrNotificationKind = (typeof TETHR_NOTIFICATION_KINDS)[number];

export const TETHR_NOTIFICATION_CHANNELS = [
  "in_app",
  "slack",
  "sms",
  "email",
] as const;
export type TethrNotificationChannel =
  (typeof TETHR_NOTIFICATION_CHANNELS)[number];

/** Core approvals.type used for Tethr gated outputs. */
export const TETHR_OUTPUT_APPROVAL_TYPE = "tethr_output" as const;

/** Agent adapter type for Tethr LLM-routed agents. */
export const TETHR_ADAPTER_TYPE = "tethr_llm" as const;
