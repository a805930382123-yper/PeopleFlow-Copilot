import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const jsonDocuments = sqliteTable("json_documents", {
  name: text("name").primaryKey().notNull(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
  version: integer("version").notNull().default(0),
});
