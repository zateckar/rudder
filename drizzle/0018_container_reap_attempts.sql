-- Bookkeeping for the generation sweep, so a reap that can never succeed is
-- reported rather than retried in silence.
--
-- `sweepExpiredGenerations` keeps a draining row when Podman refuses to remove
-- its container, because the row is what reserves the host port. That retry was
-- unbounded and invisible: a row pointing at a container Podman no longer has
-- was tried on every metrics cycle forever, held its port out of the allocator,
-- and was advertised as a fast-rollback target that could not work. The
-- reconciler now reads these columns and classifies such a row as `unreaped`.
ALTER TABLE containers ADD COLUMN reap_attempts INTEGER DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE containers ADD COLUMN reap_error TEXT;
