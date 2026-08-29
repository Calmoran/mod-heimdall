# Changelog

## Unreleased

- Initial generic module scaffold, Characters-database schema, read-only ticket polling, and durable delivery records.
- Two-way whisper chat delivered on a stock core, by holding each GM identity in-world as a
  real character rather than patching the core's whisper dispatch.
- Updated the database formatting, transaction, and WorldScript update APIs for
  current AzerothCore branches and removed redundant legacy loader registration.
- Ticket completion is driven by both of AzerothCore's closure signals (`completed` and
  `type`), matching TicketMgr's own liveness test.
- Ticket polling only writes when a ticket actually changed, and resumes from a persisted
  per-realm watermark instead of rewriting every live ticket after a restart.
- Ticket identity carries a realm tag, from `Heimdall.RealmPrefix` or the RealmID
  fallback, so several realms can share one Characters database.
- Discord replies are delivered in game as whispers from the assigned GM identity, and player
  replies to that identity are recorded against the open ticket.
