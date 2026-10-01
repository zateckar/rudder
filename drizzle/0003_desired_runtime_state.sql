-- Observed exits may be crashes; existing apps keep their previous running intent.
ALTER TABLE `applications` ADD `desired_status` text NOT NULL DEFAULT 'running';
--> statement-breakpoint
-- Null inherits application intent, with manual container controls overriding it.
ALTER TABLE `containers` ADD `desired_status` text;
