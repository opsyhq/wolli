CREATE TABLE `workflow_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer,
	`type` text NOT NULL,
	`data` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workflow_events_run_id_id_idx` ON `workflow_events` (`run_id`,`id`);--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_name` text NOT NULL,
	`status` text NOT NULL,
	`input` text NOT NULL,
	`output` text,
	`error` text,
	`cancel_requested` integer DEFAULT false NOT NULL,
	`parent_run_id` text,
	`parent_step_seq` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workflow_runs_status_idx` ON `workflow_runs` (`status`);--> statement-breakpoint
CREATE INDEX `workflow_runs_parent_run_id_idx` ON `workflow_runs` (`parent_run_id`);--> statement-breakpoint
CREATE TABLE `workflow_steps` (
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`params` text NOT NULL,
	`output` text,
	`error` text,
	`attempts` integer DEFAULT 1 NOT NULL,
	`child_run_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `seq`),
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE no action
);
