-- Team owners removed; last access recorded.
--
-- `team_members.role` was `owner` or `member` — a second, weaker administrator
-- tier that could rename and delete its own team, manage its membership and mint
-- its API keys. An installation admin could already do every one of those, so
-- what the role bought in practice was a branch in each team-scoped handler plus
-- an exemption in the OIDC claim sync, where an `owner` row was the only kind the
-- sync would not withdraw. Teams are flat now: admins own team lifecycle and
-- membership, and every member of a team has full run of what that team owns.
--
-- `users.last_seen_at` is written by hooks.server.ts on an authenticated request,
-- at most once every few minutes, so the users list can show when an account was
-- last actually used rather than only when it was created.
ALTER TABLE team_members DROP COLUMN role;
ALTER TABLE users ADD COLUMN last_seen_at INTEGER;
