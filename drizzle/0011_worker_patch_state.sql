-- Migration: per-worker patch state.
--
-- Kernel updates land via unattended-upgrades and then sit there waiting for a
-- reboot nothing asks for; /var/run/reboot-required exists on the worker and
-- was invisible to Rudder. These three columns carry what the worker's daily
-- scan found, alongside the CPU/memory/disk series already collected.
--
-- Null means "not reported" — a worker provisioned before the scan existed, or
-- one whose scan has never succeeded. That is deliberately distinct from 0,
-- which asserts the host is fully patched.
ALTER TABLE worker_metrics ADD COLUMN updates_pending INTEGER;
--> statement-breakpoint
ALTER TABLE worker_metrics ADD COLUMN updates_security INTEGER;
--> statement-breakpoint
ALTER TABLE worker_metrics ADD COLUMN reboot_required INTEGER;
