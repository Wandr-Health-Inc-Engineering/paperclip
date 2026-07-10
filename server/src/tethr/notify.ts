import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tethrNotifications } from "@paperclipai/db";
import type {
  TethrNotificationChannel,
  TethrNotificationKind,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { postSlackMessage, slackConfigured } from "./slack.js";

// Notifications adapter. The in-app center is the working local
// implementation; Slack is real once SLACK_BOT_TOKEN is set (Phase 2), else it
// logs. SMS / email remain log-only stubs — see MIGRATION-NOTES.md.

export interface TethrNotification {
  companyId: string;
  kind: TethrNotificationKind;
  title: string;
  body?: string;
  href?: string;
  agentTag?: string;
  /** Optional Slack Block Kit blocks (slack channel only; not persisted). */
  slackBlocks?: Array<Record<string, unknown>>;
  /** Optional Slack channel override (defaults to #scout). */
  channelId?: string;
  /** Optional Slack thread to reply into (slack channel only). */
  threadTs?: string;
}

export interface Notifier {
  readonly channel: TethrNotificationChannel;
  send(notification: TethrNotification): Promise<void>;
}

export function notificationService(db: Db) {
  const inApp: Notifier = {
    channel: "in_app",
    async send(n) {
      await db.insert(tethrNotifications).values({
        companyId: n.companyId,
        kind: n.kind,
        title: n.title,
        body: n.body ?? null,
        href: n.href ?? null,
        agentTag: n.agentTag ?? null,
        channel: "in_app",
      });
    },
  };

  // Future-channel stubs: same interface, local no-op + log. The cloud team
  // replaces the body of `send` with the real Slack/Twilio/SES call.
  const slack: Notifier = {
    channel: "slack",
    async send(n) {
      if (!slackConfigured()) {
        logger.info(
          { title: n.title, channel: "slack" },
          "tethr notifier (mock): would post to #scout",
        );
        return;
      }
      const text = n.href ? `${n.title}\n${n.href}` : n.title;
      const result = await postSlackMessage({
        channel: n.channelId,
        threadTs: n.threadTs,
        text,
        blocks: n.slackBlocks,
      });
      if (!result.ok) {
        logger.warn(
          { title: n.title, error: result.error },
          "tethr notifier: slack post failed",
        );
      }
    },
  };
  const sms: Notifier = {
    channel: "sms",
    async send(n) {
      logger.info({ title: n.title, channel: "sms" }, "tethr notifier (mock): would text Mark");
    },
  };
  const email: Notifier = {
    channel: "email",
    async send(n) {
      logger.info({ title: n.title, channel: "email" }, "tethr notifier (mock): would email");
    },
  };

  const notifiers: Notifier[] = [inApp, slack, sms, email];

  async function send(n: TethrNotification) {
    // in_app always persists; mock channels log so the adapter seam is visible.
    await inApp.send(n);
    await Promise.all(
      notifiers
        .filter((x) => x.channel !== "in_app")
        .map((x) => x.send(n).catch(() => {})),
    );
  }

  async function list(companyId: string, opts: { unreadOnly?: boolean; limit?: number } = {}) {
    const conditions = [eq(tethrNotifications.companyId, companyId)];
    if (opts.unreadOnly) conditions.push(isNull(tethrNotifications.readAt));
    return db
      .select()
      .from(tethrNotifications)
      .where(and(...conditions))
      .orderBy(desc(tethrNotifications.createdAt))
      .limit(opts.limit ?? 50);
  }

  async function markRead(companyId: string, id: string) {
    const [updated] = await db
      .update(tethrNotifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(tethrNotifications.companyId, companyId),
          eq(tethrNotifications.id, id),
        ),
      )
      .returning();
    return updated ?? null;
  }

  async function markAllRead(companyId: string) {
    await db
      .update(tethrNotifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(tethrNotifications.companyId, companyId),
          isNull(tethrNotifications.readAt),
        ),
      );
  }

  return { send, list, markRead, markAllRead };
}

export type NotificationService = ReturnType<typeof notificationService>;
