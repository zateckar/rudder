CREATE TABLE `secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`value` text NOT NULL,
	`description` text,
	`scope` text DEFAULT 'team' NOT NULL,
	`team_id` text REFERENCES `teams`(`id`),
	`created_by` text NOT NULL REFERENCES `users`(`id`),
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
