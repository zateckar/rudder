-- Migration: track when a worker's OIDC config was last pushed to Traefik, and
-- make application hostnames unique.
--
-- oidc_applied_at gates deploys: attaching global-oidc@file to a router whose
-- worker has no such middleware makes Traefik drop the router entirely.
ALTER TABLE workers ADD COLUMN oidc_applied_at INTEGER;
--> statement-breakpoint
-- Traefik routes by Host, so two applications claiming the same domain produce
-- two routers with an identical rule and non-deterministic routing. Partial
-- because domain is nullable for workers without a base domain.
CREATE UNIQUE INDEX IF NOT EXISTS applications_domain_unique
  ON applications (domain) WHERE domain IS NOT NULL;
