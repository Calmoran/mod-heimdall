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
