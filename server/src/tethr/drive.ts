import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  tethrDriveNodes,
  tethrDriveVersions,
} from "@paperclipai/db";
import { getStorageService } from "../storage/index.js";
import { logActivity } from "../services/activity-log.js";

// The Drive: Tethr's replacement for Google Drive as source of truth.
// Bytes go through core's StorageService (local_disk locally, s3 in cloud —
// provider swap is an env change). This service owns the metadata layer:
// folder tree, versions, tags, permissions.

const NAMESPACE = "tethr-drive";

export interface DrivePutInput {
  companyId: string;
  /** Absolute drive path, e.g. "/agents/sonar/ROLE.md". */
  path: string;
  content: Buffer | string;
  contentType?: string;
  tags?: string[];
  createdByTag?: string;
  note?: string;
  permissions?: { owner: string; read: string[]; write: string[] };
}

function normalizePath(input: string): string {
  const parts = input
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && p !== "." && p !== "..");
  return "/" + parts.join("/");
}

function parentPath(path: string): string | null {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return path === "/" ? null : "/";
  return path.slice(0, idx);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function guessContentType(path: string): string {
  if (path.endsWith(".md")) return "text/markdown";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "application/yaml";
  if (path.endsWith(".csv")) return "text/csv";
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  return "text/plain";
}

export function driveService(db: Db) {
  async function findNodeByPath(companyId: string, path: string) {
    const normalized = normalizePath(path);
    const [node] = await db
      .select()
      .from(tethrDriveNodes)
      .where(
        and(
          eq(tethrDriveNodes.companyId, companyId),
          eq(tethrDriveNodes.path, normalized),
        ),
      )
      .limit(1);
    return node ?? null;
  }

  async function ensureFolder(
    companyId: string,
    path: string,
    createdByTag = "system",
  ): Promise<typeof tethrDriveNodes.$inferSelect> {
    const normalized = normalizePath(path);
    const existing = await findNodeByPath(companyId, normalized);
    if (existing) return existing;

    const parent = parentPath(normalized);
    let parentId: string | null = null;
    if (parent && parent !== "/") {
      const parentNode = await ensureFolder(companyId, parent, createdByTag);
      parentId = parentNode.id;
    }
    const [created] = await db
      .insert(tethrDriveNodes)
      .values({
        companyId,
        parentId,
        kind: "folder",
        name: baseName(normalized) || "/",
        path: normalized,
        createdByTag,
      })
      .onConflictDoNothing()
      .returning();
    if (created) return created;
    const raced = await findNodeByPath(companyId, normalized);
    if (!raced) throw new Error(`Failed to create drive folder ${normalized}`);
    return raced;
  }

  async function putFile(input: DrivePutInput) {
    const storage = getStorageService();
    const normalized = normalizePath(input.path);
    const body = Buffer.isBuffer(input.content)
      ? input.content
      : Buffer.from(input.content, "utf8");
    const contentType = input.contentType ?? guessContentType(normalized);

    const parent = parentPath(normalized);
    const parentNode =
      parent && parent !== "/"
        ? await ensureFolder(input.companyId, parent, input.createdByTag ?? "system")
        : null;

    const stored = await storage.putFile({
      companyId: input.companyId,
      namespace: NAMESPACE,
      originalFilename: baseName(normalized),
      contentType,
      body,
    });

    let node = await findNodeByPath(input.companyId, normalized);
    if (!node) {
      const [created] = await db
        .insert(tethrDriveNodes)
        .values({
          companyId: input.companyId,
          parentId: parentNode?.id ?? null,
          kind: "file",
          name: baseName(normalized),
          path: normalized,
          contentType,
          tags: input.tags ?? [],
          ...(input.permissions ? { permissions: input.permissions } : {}),
          byteSize: stored.byteSize,
          createdByTag: input.createdByTag ?? "system",
        })
        .returning();
      node = created;
    }

    const [{ maxVersion }] = await db
      .select({
        maxVersion: sql<number>`coalesce(max(${tethrDriveVersions.versionNumber}), 0)`,
      })
      .from(tethrDriveVersions)
      .where(eq(tethrDriveVersions.nodeId, node.id));

    const [version] = await db
      .insert(tethrDriveVersions)
      .values({
        companyId: input.companyId,
        nodeId: node.id,
        versionNumber: (maxVersion ?? 0) + 1,
        objectKey: stored.objectKey,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        contentType,
        note: input.note ?? null,
        createdByTag: input.createdByTag ?? "system",
      })
      .returning();

    const [updated] = await db
      .update(tethrDriveNodes)
      .set({
        currentVersionId: version.id,
        byteSize: stored.byteSize,
        contentType,
        ...(input.tags ? { tags: input.tags } : {}),
        updatedAt: new Date(),
      })
      .where(eq(tethrDriveNodes.id, node.id))
      .returning();

    await logActivity(db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: input.createdByTag ?? "tethr",
      action: "tethr_drive_file_saved",
      entityType: "tethr_drive_node",
      entityId: node.id,
      details: { path: normalized, version: version.versionNumber, bytes: stored.byteSize },
    });

    return { node: updated, version };
  }

  async function listChildren(companyId: string, parentId: string | null) {
    return db
      .select()
      .from(tethrDriveNodes)
      .where(
        and(
          eq(tethrDriveNodes.companyId, companyId),
          parentId === null
            ? isNull(tethrDriveNodes.parentId)
            : eq(tethrDriveNodes.parentId, parentId),
        ),
      )
      .orderBy(desc(tethrDriveNodes.kind), asc(tethrDriveNodes.name));
  }

  async function getNode(companyId: string, nodeId: string) {
    const [node] = await db
      .select()
      .from(tethrDriveNodes)
      .where(
        and(eq(tethrDriveNodes.companyId, companyId), eq(tethrDriveNodes.id, nodeId)),
      )
      .limit(1);
    return node ?? null;
  }

  async function listVersions(companyId: string, nodeId: string) {
    return db
      .select()
      .from(tethrDriveVersions)
      .where(
        and(
          eq(tethrDriveVersions.companyId, companyId),
          eq(tethrDriveVersions.nodeId, nodeId),
        ),
      )
      .orderBy(desc(tethrDriveVersions.versionNumber));
  }

  async function readVersion(companyId: string, versionId: string): Promise<{
    version: typeof tethrDriveVersions.$inferSelect;
    content: Buffer;
  } | null> {
    const [version] = await db
      .select()
      .from(tethrDriveVersions)
      .where(
        and(
          eq(tethrDriveVersions.companyId, companyId),
          eq(tethrDriveVersions.id, versionId),
        ),
      )
      .limit(1);
    if (!version) return null;
    const storage = getStorageService();
    const result = await storage.getObject(companyId, version.objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return { version, content: Buffer.concat(chunks) };
  }

  async function readCurrent(companyId: string, nodeId: string) {
    const node = await getNode(companyId, nodeId);
    if (!node?.currentVersionId) return null;
    return readVersion(companyId, node.currentVersionId);
  }

  async function setTags(companyId: string, nodeId: string, tags: string[]) {
    const [updated] = await db
      .update(tethrDriveNodes)
      .set({ tags, updatedAt: new Date() })
      .where(
        and(eq(tethrDriveNodes.companyId, companyId), eq(tethrDriveNodes.id, nodeId)),
      )
      .returning();
    return updated ?? null;
  }

  async function setPermissions(
    companyId: string,
    nodeId: string,
    permissions: { owner: string; read: string[]; write: string[] },
  ) {
    const [updated] = await db
      .update(tethrDriveNodes)
      .set({ permissions, updatedAt: new Date() })
      .where(
        and(eq(tethrDriveNodes.companyId, companyId), eq(tethrDriveNodes.id, nodeId)),
      )
      .returning();
    return updated ?? null;
  }

  return {
    ensureFolder,
    putFile,
    findNodeByPath,
    listChildren,
    getNode,
    listVersions,
    readVersion,
    readCurrent,
    setTags,
    setPermissions,
  };
}

export type DriveService = ReturnType<typeof driveService>;
