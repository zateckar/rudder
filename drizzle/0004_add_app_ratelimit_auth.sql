-- Add per-application rate limiting and auth settings
ALTER TABLE applications ADD COLUMN rate_limit_avg INTEGER;
--> statement-breakpoint
ALTER TABLE applications ADD COLUMN rate_limit_burst INTEGER;
--> statement-breakpoint
ALTER TABLE applications ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'none';
--> statement-breakpoint
ALTER TABLE applications ADD COLUMN auth_config TEXT;
