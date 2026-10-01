ALTER TABLE workers ADD COLUMN config_applied_hash TEXT;
--> statement-breakpoint
ALTER TABLE workers ADD COLUMN routing_revision INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE containers ADD COLUMN retained_at INTEGER;
--> statement-breakpoint
ALTER TABLE containers ADD COLUMN drain_config_hash TEXT;
--> statement-breakpoint
UPDATE containers SET retained_at = updated_at WHERE state = 'draining';
--> statement-breakpoint
ALTER TABLE deployments ADD COLUMN cutover_at INTEGER;
--> statement-breakpoint
-- Invalidate acknowledgements for every writer, including settings edits that
-- do not enter the container lifecycle lock. OLD and NEW cover reassignment.
CREATE TRIGGER applications_invalidate_routing AFTER UPDATE ON applications
BEGIN
  UPDATE workers SET routing_revision = routing_revision + 1, config_applied_hash = NULL
  WHERE id IN (OLD.worker_id, NEW.worker_id);
END;
--> statement-breakpoint
-- Telemetry/ACK writes are intentionally excluded: they cannot invalidate
-- the acknowledgement they are recording.
CREATE TRIGGER workers_invalidate_routing AFTER UPDATE OF
  base_domain, routing_mode, oidc_enabled, oidc_provider_url, oidc_client_id,
  oidc_client_secret, oidc_encryption_key, oidc_callback_path ON workers
BEGIN
  UPDATE workers SET routing_revision = routing_revision + 1, config_applied_hash = NULL
  WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER containers_insert_invalidate_routing AFTER INSERT ON containers
BEGIN
  UPDATE workers SET routing_revision = routing_revision + 1, config_applied_hash = NULL
  WHERE id = NEW.worker_id;
END;
--> statement-breakpoint
CREATE TRIGGER containers_delete_invalidate_routing AFTER DELETE ON containers
BEGIN
  UPDATE workers SET routing_revision = routing_revision + 1, config_applied_hash = NULL
  WHERE id = OLD.worker_id;
END;
--> statement-breakpoint
CREATE TRIGGER containers_update_invalidate_routing AFTER UPDATE OF
  worker_id, application_id, container_id, state, status, domain, router_name,
  exposed_port, routes ON containers
BEGIN
  UPDATE workers SET routing_revision = routing_revision + 1, config_applied_hash = NULL
  WHERE id IN (OLD.worker_id, NEW.worker_id);
END;
