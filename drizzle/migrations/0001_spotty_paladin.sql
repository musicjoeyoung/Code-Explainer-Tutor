CREATE TABLE `explanations` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`file_path` text NOT NULL,
	`explanation_type` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`diagram_url` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `quiz_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`quiz_id` text NOT NULL,
	`user_session` text NOT NULL,
	`answers` text,
	`score` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`quiz_id`) REFERENCES `quizzes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `quizzes` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`explanation_id` text,
	`title` text NOT NULL,
	`questions` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`explanation_id`) REFERENCES `explanations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`source_type` text NOT NULL,
	`source_url` text,
	`file_count` integer DEFAULT 0 NOT NULL,
	`total_size` integer DEFAULT 0 NOT NULL,
	`languages` text,
	`r2_path` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
