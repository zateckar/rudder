-- The parts of a container's intent that can only change by recreating it,
-- hashed. Excludes routing and middleware, which a worker in `http` mode fetches
-- live — so editing a rate limit does not make the reconciler want a new
-- generation. Null on containers that predate the column and on adopted ones;
-- a null hash never reads as stale.
ALTER TABLE containers ADD COLUMN spec_hash TEXT;
