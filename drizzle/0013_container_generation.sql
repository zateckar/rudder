-- Migration: container generations, for blue/green deploys.
--
-- A deploy used to remove the previous containers before creating the new
-- ones, so every deploy was an outage and a failure partway through left
-- nothing running. Two generations can now coexist: the new one is created
-- alongside the old, verified, and only then does traffic move.
--
-- `generation` is also part of the Podman container name (`<app>-<id8>-g<N>`).
-- Podman names are unique per host, which is precisely why the old scheme could
-- not hold two versions at once.
--
-- Existing rows become generation 1 in state 'active', which is what they are.
ALTER TABLE containers ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE containers ADD COLUMN state TEXT NOT NULL DEFAULT 'active';

-- Which deploy produced the container. A rollback to a deployment whose
-- containers are still present, stopped, is a restart rather than a pull and a
-- recreate; this column is how that question gets answered.
ALTER TABLE containers ADD COLUMN deployment_id TEXT;

-- How long a deploy waits for the new generation to report healthy before
-- abandoning it. NULL means the built-in default.
ALTER TABLE applications ADD COLUMN health_timeout_seconds INTEGER;

-- Minutes to keep the superseded generation stopped-but-present after a
-- successful deploy so a rollback can restart it. 0 reaps immediately, which
-- is what every deploy did before this column existed.
ALTER TABLE applications ADD COLUMN retain_previous_minutes INTEGER NOT NULL DEFAULT 0;
