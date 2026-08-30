# Architecture

The module is the game-side owner of in-game ticket observation. Every observed
ticket is represented once by `(source = ingame, source_ticket_id)`. Events and
delivery jobs have unique keys, so a poll, retry, or restart does not create a
second Discord channel or a duplicate player message.

The bot is the Discord-side worker. It leases `to_discord` and `soap` jobs,
marks a job delivered only after success, and retries failures with bounded
backoff. It uses SOAP for ticket assignment and completion; it never modifies
AzerothCore ticket rows directly.

`to_game` jobs carry player-facing whispers. The module leases them, delivers
them in order for an online player, and marks one delivered only after the core
chat path accepts it. A job whose GM identity is not held, or whose player is
offline, stays queued and is retried; that is a precondition, not a failure.
Player replies to a GM identity enter the same ticket event stream through the
stock `OnPlayerCanUseChat` hook.

## The bot's half, and the seam between them

The module and bot share only module-owned records in the Characters database.
The design avoids a public listener and keeps external integration separate:

```text
Worldserver (read-only gm_ticket poll) → durable module queue → bot → Discord
Discord replies  → durable queue → module delivers as a whisper from a GM identity
Discord controls → durable SOAP queue → loopback AzerothCore SOAP service
```

Tables use the `heimdall_` prefix:

- `ticket`: durable ticket identity, visibility state, claimant, and retention deadline.
- `event`: idempotent message/lifecycle history.
- `delivery`: leased, retryable Discord, SOAP, and game-delivery jobs.
- `attachment`: private file metadata, checksum, and expiry.
- `staff`: administrator-managed Discord-user to GM-character mapping.
- `setting` and `audit`: panel coordination and administrative history.

Unique ticket source keys, event keys, and delivery keys make polls and retries
idempotent. A worker leases a job, performs it, then marks it delivered. Errors
are retried with bounded backoff; exhausted jobs become `dead` for staff review.

The bot does not receive individual staff SOAP credentials. It uses the
server's restricted SOAP service identity and accepts a staff action only after
checking both the Discord role and the configured roster mapping.
