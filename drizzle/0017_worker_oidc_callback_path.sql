-- Path of the shared OIDC callback URL on auth.<base_domain>.
--
-- Null means the /oidc/callback default. Identity providers compare redirect
-- URIs by exact string, so a worker whose IdP client is registered against
-- another convention — /oauth2/callback is the common one — needs its path
-- named here, or every login ends at "invalid redirect_uri".
ALTER TABLE workers ADD COLUMN oidc_callback_path TEXT;
