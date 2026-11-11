import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addSideChat,
  chatTitle,
  isSideChat,
  listSideChats,
  mainThreadId,
  removeSideChat,
} from "../tethr/chats.js";

// Phase 17 chat model: one ongoing main chat (thread id = company id) plus
// side chats the user opens on purpose, listed in an instance-dir JSON file.

const COMPANY = "7c92c0f9-8ab4-4cb5-aa88-f01ef5dd0705";
const OTHER = "11111111-2222-3333-4444-555555555555";
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-chats-"));
  process.env.TETHR_CHATS_FILE = path.join(dir, "chats.json");
});

afterEach(() => {
  delete process.env.TETHR_CHATS_FILE;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("tethr chats", () => {
  it("uses the company id as the main chat's thread id", () => {
    expect(mainThreadId(COMPANY)).toBe(COMPANY);
  });

  it("titles a side chat from its first non-empty line, trimmed to 60 chars", () => {
    expect(chatTitle("\n\n  Plan the   Peru push \nwith details")).toBe("Plan the Peru push");
    const long = chatTitle("x".repeat(100));
    expect(long.length).toBe(60);
    expect(long.endsWith("…")).toBe(true);
    expect(chatTitle("   ")).toBe("Side chat");
  });

  it("starts empty when no file exists", () => {
    expect(listSideChats(COMPANY)).toEqual([]);
    expect(isSideChat(COMPANY, "a")).toBe(false);
  });

  it("adds side chats newest first, idempotently, scoped per company", async () => {
    await addSideChat(COMPANY, "t1", "First project");
    await addSideChat(COMPANY, "t2", "Second project");
    const again = await addSideChat(COMPANY, "t1", "renamed?");
    expect(again.title).toBe("First project");
    expect(listSideChats(COMPANY).map((c) => c.threadId)).toEqual(["t2", "t1"]);
    expect(listSideChats(OTHER)).toEqual([]);
    expect(isSideChat(COMPANY, "t2")).toBe(true);
  });

  it("removes a side chat from the list only", async () => {
    await addSideChat(COMPANY, "t1", "First project");
    expect(await removeSideChat(COMPANY, "t1")).toBe(true);
    expect(await removeSideChat(COMPANY, "t1")).toBe(false);
    expect(listSideChats(COMPANY)).toEqual([]);
  });

  it("tolerates a corrupt file", () => {
    fs.writeFileSync(process.env.TETHR_CHATS_FILE!, "{not json");
    expect(listSideChats(COMPANY)).toEqual([]);
  });
});
