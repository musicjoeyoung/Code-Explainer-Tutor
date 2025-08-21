import { type SQL, sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const currentTimestamp = () => {
  return sql`(CURRENT_TIMESTAMP)`;
};

const lower = (email: AnySQLiteColumn): SQL => {
  return sql`lower(${email})`;
};

export type NewUser = typeof users.$inferInsert;

export const users = sqliteTable(
  "users",
  {
    // .primaryKey() must be chained before $defaultFn
    id: text()
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: text().notNull(),
    email: text().notNull(),
    createdAt: text().notNull().default(currentTimestamp()),
    updatedAt: text().notNull().default(currentTimestamp()),
  },
  /**
   * Ensure case-insensitive uniqueness for email
   * @see https://orm.drizzle.team/docs/guides/unique-case-insensitive-email#sqlite
   */
  (table) => [uniqueIndex("emailUniqueIndex").on(lower(table.email))],
);

// Shared types for JSON columns
export type QuizQuestion = {
  id: string;
  question: string;
  options: string[];
  correctAnswer: string;
  explanation: string;
};

export type QuizAnswer = {
  questionId: string;
  answer: string;
};

// Repositories table
export const repositories = sqliteTable("repositories", {
  id: text()
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text().notNull(),
  sourceType: text().notNull(),
  sourceUrl: text(),
  fileCount: integer("file_count").notNull().default(0),
  totalSize: integer("total_size").notNull().default(0),
  // Store as JSON in SQLite text column
  languages: text({ mode: "json" }).$type<string[] | null>(),
  r2Path: text("r2_path").notNull(),
  createdAt: text().notNull().default(currentTimestamp()),
  updatedAt: text().notNull().default(currentTimestamp()),
});

// Explanations table
export const explanations = sqliteTable("explanations", {
  id: text()
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  repositoryId: text("repository_id")
    .notNull()
    .references(() => repositories.id),
  filePath: text("file_path").notNull(),
  explanationType: text("explanation_type").notNull(),
  title: text().notNull(),
  content: text().notNull(),
  diagramUrl: text("diagram_url"),
  createdAt: text().notNull().default(currentTimestamp()),
});

// Quizzes table
export const quizzes = sqliteTable("quizzes", {
  id: text()
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  repositoryId: text("repository_id")
    .notNull()
    .references(() => repositories.id),
  explanationId: text("explanation_id").references(() => explanations.id),
  title: text().notNull(),
  questions: text({ mode: "json" }).$type<QuizQuestion[]>(),
  createdAt: text().notNull().default(currentTimestamp()),
});

// Quiz attempts table
export const quizAttempts = sqliteTable("quiz_attempts", {
  id: text()
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  quizId: text("quiz_id")
    .notNull()
    .references(() => quizzes.id),
  userSession: text("user_session").notNull(),
  answers: text({ mode: "json" }).$type<QuizAnswer[]>(),
  score: integer().notNull().default(0),
  createdAt: text().notNull().default(currentTimestamp()),
});
