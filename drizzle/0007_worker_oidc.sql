-- Migration: Add per-worker OIDC configuration columns
ALTER TABLE workers ADD COLUMN oidc_enabled INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE workers ADD COLUMN oidc_provider_url TEXT;
--> statement-breakpoint
ALTER TABLE workers ADD COLUMN oidc_client_id TEXT;
--> statement-breakpoint
ALTER TABLE workers ADD COLUMN oidc_client_secret TEXT;
--> statement-breakpoint
ALTER TABLE workers ADD COLUMN oidc_encryption_key TEXT;
