# Architecture and state model

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
