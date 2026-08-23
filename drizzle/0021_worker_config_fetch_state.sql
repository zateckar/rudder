-- Why a worker is not fetching its routing configuration, not just whether it is.
--
-- `config_fetched_at` only ever records success, so a worker failing every fetch
-- is indistinguishable from one that was never provisioned for control-plane
-- routing — both leave it null, and the two need opposite remedies. The worker
-- reports its last attempt over the mTLS metrics endpoint (deliberately not over
-- the config endpoint, which is the thing that may be rejecting it).
ALTER TABLE workers ADD COLUMN config_fetch_status INTEGER;
ALTER TABLE workers ADD COLUMN config_fetch_detail TEXT;
ALTER TABLE workers ADD COLUMN config_fetch_attempt_at INTEGER;
