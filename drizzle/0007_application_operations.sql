CREATE TABLE `application_operations` (
  `id` text PRIMARY KEY NOT NULL,
  `application_id` text NOT NULL REFERENCES `applications`(`id`) ON DELETE CASCADE,
  `application_name` text NOT NULL,
  `team_id` text,
  `started_by` text NOT NULL,
  `kind` text NOT NULL,
  `status` text NOT NULL,
  `stage` text NOT NULL,
  `message` text,
  `deployment_id` text,
  `details` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `application_operations_app_created_idx` ON `application_operations` (`application_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `application_operations_finished_idx` ON `application_operations` (`finished_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `application_operations_one_running_idx` ON `application_operations` (`application_id`) WHERE status = 'running';
