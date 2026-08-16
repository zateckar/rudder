-- Migration: per-worker routing mode and the credential its Traefik uses to
-- fetch routing configuration from the control plane.
--
-- routing_mode gates the cutover from container labels to control-plane-served
-- configuration. A worker must be wholly in one mode: two providers defining
-- the same router name produce duplicate routers with one Host() rule and
-- arbitrary resolution between them. Existing workers default to 'labels' and
-- are unaffected.
ALTER TABLE workers ADD COLUMN routing_mode TEXT NOT NULL DEFAULT 'labels';
--> statement-breakpoint
-- Bearer token for GET /api/workers/:id/traefik-config, encrypted at rest like
-- the other worker secrets. Excluded from safeWorkerColumns.
ALTER TABLE workers ADD COLUMN config_token TEXT;
--> statement-breakpoint
-- Last successful fetch, reported by the worker. Drives the liveness indicator
-- that replaces the manual "Apply to Traefik" step.
ALTER TABLE workers ADD COLUMN config_fetched_at INTEGER;
--> statement-breakpoint
-- Hostname and Traefik router name per container. In labels mode these merely
-- record what was stamped; in http mode they are the input the generator groups
-- by, so replicas of one application collapse into one service with N servers.
ALTER TABLE containers ADD COLUMN domain TEXT;
--> statement-breakpoint
ALTER TABLE containers ADD COLUMN router_name TEXT;
