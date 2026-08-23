-- Per-application OAuth token forwarding.
--
-- The worker-level OIDC middleware now sets the X-Forwarded-User / -Email /
-- -Preferred-Username / -Groups identity headers on every request it lets
-- through, which is all most applications need to log a user in. An application
-- that wants the tokens themselves — because it verifies the JWT, or calls an
-- API with the access token — names the headers to receive them in here.
--
-- Null means "do not forward": the name is the switch, since a token an
-- application does not know the name of is only weight on every request.
--
-- These are names, not credentials, so unlike `auth_config` they are stored in
-- the clear. The tokens are minted per session by the identity provider and are
-- never written to this database.
ALTER TABLE applications ADD COLUMN oidc_id_token_header TEXT;
ALTER TABLE applications ADD COLUMN oidc_access_token_header TEXT;
