ALTER TABLE applications ADD COLUMN auto_update_enabled INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE applications ADD COLUMN auto_update_interval_minutes INTEGER NOT NULL DEFAULT 60;
--> statement-breakpoint
ALTER TABLE applications ADD COLUMN auto_update_last_checked_at INTEGER;
--> statement-breakpoint
DROP TRIGGER IF EXISTS applications_invalidate_routing;
--> statement-breakpoint
-- Scheduling checks do not change the worker's routing document. Keep normal
-- configuration edits invalidating acknowledgements, including reassignment.
CREATE TRIGGER applications_invalidate_routing AFTER UPDATE OF
  desired_status, team_id, worker_id, name, description, domain, type,
  deployment_format, manifest, environment, volumes, restart_policy,
  exposed_ports, appsec_disabled_rules, rate_limit_avg, rate_limit_burst,
  auth_type, auth_config, oidc_id_token_header, oidc_access_token_header,
  replicas, git_repo, git_branch, git_dockerfile, healthcheck,
  health_timeout_seconds, retain_previous_minutes ON applications
BEGIN
  UPDATE workers SET routing_revision = routing_revision + 1, config_applied_hash = NULL
  WHERE id IN (OLD.worker_id, NEW.worker_id);
END;
