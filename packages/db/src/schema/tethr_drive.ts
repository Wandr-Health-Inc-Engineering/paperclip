import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export interface TethrDrivePermissions {
  owner: string;
  read: string[];
  write: string[];
}

export const tethrDriveNodes = pgTable(
  "tethr_drive_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references(
      (): AnyPgColumn => tethrDriveNodes.id,
      { onDelete: "cascade" },
    ),
    kind: text("kind").notNull().default("file"),
    name: text("name").notNull(),
    path: text("path").notNull(),
    contentType: text("content_type"),
    // Current version id; plain uuid (no FK) to avoid a circular reference
    // with tethr_drive_versions in the generated migration.
    currentVersionId: uuid("current_version_id"),
    permissions: jsonb("permissions")
      .$type<TethrDrivePermissions>()
      .notNull()
      .default({ owner: "mark", read: ["*"], write: ["mark"] }),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    byteSize: integer("byte_size"),
    createdByTag: text("created_by_tag"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyPathIdx: uniqueIndex("tethr_drive_nodes_company_path_idx").on(
      table.companyId,
      table.path,
    ),
    companyParentIdx: index("tethr_drive_nodes_company_parent_idx").on(
      table.companyId,
      table.parentId,
    ),
  }),
);

export const tethrDriveVersions = pgTable(
  "tethr_drive_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => tethrDriveNodes.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    objectKey: text("object_key").notNull(),
    byteSize: integer("byte_size").notNull().default(0),
    sha256: text("sha256"),
    contentType: text("content_type"),
    note: text("note"),
    createdByTag: text("created_by_tag"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    nodeVersionIdx: uniqueIndex("tethr_drive_versions_node_version_idx").on(
      table.nodeId,
      table.versionNumber,
    ),
    companyNodeIdx: index("tethr_drive_versions_company_node_idx").on(
      table.companyId,
      table.nodeId,
    ),
  }),
);
