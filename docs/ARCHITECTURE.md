# Architecture

The module is the game-side owner of in-game ticket observation. Every observed
ticket is represented once by `(source = ingame, source_ticket_id)`. Events and
delivery jobs have unique keys, so a poll, retry, or restart does not create a
second Discord channel or a duplicate player message.

The bot is the Discord-side worker. It leases `to_discord` jobs, marks a job
delivered only after success, and retries failures with bounded backoff. Ticket
assignment and completion are asked for, not performed: the bot queues an intent
row and the module carries it out. It never modifies AzerothCore ticket rows
directly.

`to_game` jobs carry player-facing whispers. The module leases them, delivers
them in order for an online player, and marks one delivered only after the core
chat path accepts it. A job whose GM identity is not held, or whose player is
offline, stays queued and is retried; that is a precondition, not a failure.
Player replies to a GM identity enter the same ticket event stream through the
stock `OnPlayerCanUseChat` hook.

## The bot's half, and the seam between them

The module and bot share only module-owned records, in a database of Heimdall's own
(`Heimdall.Database`, default `heimdall`) on the realm's MySQL server. The module addresses it by
name from the core's characters connection - every query is schema-qualified at the call site - so
the realm's databases are never where its tables live, and the bot's account never has to be able
to see them.
The design avoids a public listener and keeps external integration separate:

```text
Worldserver (read-only gm_ticket poll) → durable module queue → bot → Discord
Discord replies  → durable queue → module delivers as a whisper from a GM identity
Discord controls → durable queue → module runs the command inside the worldserver
```

The third line is the same shape as the second, and deliberately so. The bot writes an intent row
naming an action and its arguments as separate fields; the module leases it and performs it through
the core's own command handlers, inside the world thread. The module composes every command itself
from a fixed set of actions, so a row cannot express a command Heimdall does not perform - a
poisoned row names an action that does not exist, and is refused.

That is why the bot has no channel to the realm other than its database account, and why that
account is granted Heimdall's database and nothing else - `bot/deploy/mysql-grants.sql`, no DDL,
loopback only. The bot never connects to a realm database. Its database contains Heimdall's own
tables and nothing else.

Tables use the `heimdall_` prefix:

- `ticket`: durable ticket identity, visibility state, claimant, and retention deadline.
- `event`: idempotent message/lifecycle history.
- `delivery`: leased, retryable Discord, realm-command, and game-delivery jobs.
- `attachment`: private file metadata, checksum, and expiry.
- `staff`: administrator-managed Discord-user to GM-character mapping.
- `setting` and `audit`: panel coordination and administrative history.

Unique ticket source keys, event keys, and delivery keys make polls and retries
idempotent. A worker leases a job, performs it, then marks it delivered. Errors
are retried with bounded backoff; exhausted jobs become `dead` for staff review.

The bot holds no credentials for the realm at all. It accepts a staff action only
after checking both the Discord role and the configured roster mapping, and the
module checks the arguments again before it composes a command from them.
