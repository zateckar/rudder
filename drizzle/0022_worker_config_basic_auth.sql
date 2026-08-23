-- Credentials for a proxy in front of the control plane.
--
-- Where Rudder is published behind something that demands its own HTTP Basic
-- authentication, that proxy answers the worker's routing fetch with 401 before
-- Rudder sees the request — so the per-worker bearer token, however correct, can
-- never be checked. The worker needs to satisfy the outer layer first.
--
-- The password is encrypted at rest (see `encryptField`) and is excluded from
-- `safeWorkerColumns`, so it is never serialised to the browser. The username is
-- not a credential and stays readable so the settings form can show it.
ALTER TABLE workers ADD COLUMN config_basic_user TEXT;
ALTER TABLE workers ADD COLUMN config_basic_password TEXT;
