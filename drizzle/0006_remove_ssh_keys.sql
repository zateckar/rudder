-- Migration: Remove server-side SSH key storage
-- SSH keys are no longer stored server-side. They must be provided ad-hoc by the admin.

ALTER TABLE workers DROP COLUMN ssh_key_id;
--> statement-breakpoint
DROP TABLE ssh_keys;
