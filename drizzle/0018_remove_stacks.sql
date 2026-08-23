-- Stacks removed.
--
-- A stack was a group of applications with bulk deploy/stop/restart over it.
-- An application is now the multi-container unit: a compose manifest with
-- several services is deployed, stopped and restarted as one thing from the
-- application's own page, so the grouping layer above it bought nothing and
-- had its own team scoping to get wrong.
--
-- Order matters — SQLite refuses to drop a column an index covers.
DROP INDEX IF EXISTS applications_stack_idx;
ALTER TABLE applications DROP COLUMN stack_id;
DROP TABLE IF EXISTS stacks;
