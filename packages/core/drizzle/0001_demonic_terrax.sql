CREATE TABLE `workflow_stream_chunks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`stream_id` text NOT NULL,
	`step_seq` integer,
	`eof` integer DEFAULT false NOT NULL,
	`data` text,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workflow_stream_chunks_run_id_id_idx` ON `workflow_stream_chunks` (`run_id`,`id`);