import type { Db } from "@paperclipai/db";
import { driveService } from "./drive.js";

// Working state: the calendars/trackers the live engine ran on, kept as
// versioned JSON files in the Drive under /state. Every advance is a new file
// version, which gives the locked-tracker problem from the bundle a cleaner
// answer: atomic single-file writes + full version history.

export type TrackerName = "content-calendar" | "destination-tracker" | "itinerary-calendar";

export interface TrackerRow {
  topic: string;
  slug: string;
  pillar?: string;
  status: "idea" | "review" | "published";
  notes?: string;
  claimedBy?: string;
  claimedAt?: string;
}

export interface TrackerFile {
  name: TrackerName;
  rows: TrackerRow[];
}

export interface PublishedLogEntry {
  slug: string;
  title: string;
  kind: string;
  publishedAt: string;
}

const TRACKER_PATHS: Record<TrackerName, string> = {
  "content-calendar": "/state/content-calendar.json",
  "destination-tracker": "/state/destination-tracker.json",
  "itinerary-calendar": "/state/itinerary-calendar.json",
};
const PUBLISHED_LOG_PATH = "/state/published-log.json";

export function trackerService(db: Db) {
  const drive = driveService(db);

  async function readJson<T>(companyId: string, path: string): Promise<T | null> {
    const node = await drive.findNodeByPath(companyId, path);
    if (!node) return null;
    const read = await drive.readCurrent(companyId, node.id);
    if (!read) return null;
    try {
      return JSON.parse(read.content.toString("utf8")) as T;
    } catch {
      return null;
    }
  }

  async function writeJson(
    companyId: string,
    path: string,
    data: unknown,
    byTag: string,
    note: string,
  ) {
    await drive.putFile({
      companyId,
      path,
      content: JSON.stringify(data, null, 2),
      contentType: "application/json",
      createdByTag: byTag,
      note,
      tags: ["state"],
    });
  }

  async function readTracker(companyId: string, name: TrackerName): Promise<TrackerFile> {
    const data = await readJson<TrackerFile>(companyId, TRACKER_PATHS[name]);
    return data ?? { name, rows: [] };
  }

  async function writeTracker(
    companyId: string,
    tracker: TrackerFile,
    byTag: string,
    note: string,
  ) {
    await writeJson(companyId, TRACKER_PATHS[tracker.name], tracker, byTag, note);
  }

  /** Claim the next "idea" row: mark it review and return it. */
  async function claimNext(
    companyId: string,
    name: TrackerName,
    byTag: string,
  ): Promise<TrackerRow | null> {
    const tracker = await readTracker(companyId, name);
    const row = tracker.rows.find((r) => r.status === "idea");
    if (!row) return null;
    row.status = "review";
    row.claimedBy = byTag;
    row.claimedAt = new Date().toISOString();
    await writeTracker(companyId, tracker, byTag, `claimed "${row.topic}"`);
    return row;
  }

  async function appendIdea(
    companyId: string,
    name: TrackerName,
    row: Omit<TrackerRow, "status">,
    byTag: string,
  ): Promise<TrackerRow> {
    const tracker = await readTracker(companyId, name);
    const exists = tracker.rows.some((r) => r.slug === row.slug);
    const added: TrackerRow = { ...row, status: "idea" };
    if (!exists) {
      tracker.rows.push(added);
      await writeTracker(companyId, tracker, byTag, `queued "${row.topic}"`);
    }
    return added;
  }

  async function markRowPublished(companyId: string, name: TrackerName, slug: string, byTag: string) {
    const tracker = await readTracker(companyId, name);
    const row = tracker.rows.find((r) => r.slug === slug);
    if (row) {
      row.status = "published";
      await writeTracker(companyId, tracker, byTag, `published "${row.topic}"`);
    }
    return row ?? null;
  }

  async function listPublished(companyId: string): Promise<PublishedLogEntry[]> {
    const data = await readJson<{ entries: PublishedLogEntry[] }>(companyId, PUBLISHED_LOG_PATH);
    return data?.entries ?? [];
  }

  async function appendPublished(companyId: string, entry: PublishedLogEntry, byTag: string) {
    const entries = await listPublished(companyId);
    if (!entries.some((e) => e.slug === entry.slug)) {
      entries.push(entry);
      await writeJson(companyId, PUBLISHED_LOG_PATH, { entries }, byTag, `+ ${entry.slug}`);
    }
  }

  return {
    readTracker,
    writeTracker,
    claimNext,
    appendIdea,
    markRowPublished,
    listPublished,
    appendPublished,
  };
}

export type TrackerService = ReturnType<typeof trackerService>;
