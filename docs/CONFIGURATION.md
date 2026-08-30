# Configuration reference

`DISCORD_TOKEN`, the guild ID, the three staff role IDs, MySQL values, SOAP
values, archive path, and `BOT_INSTANCE_ID` are required. The exact variables and
safe sample values are in `.env.example`.

`DISCORD_BOT_ROLE_ID` is **not** required and is best left unset. The bot's role
is the managed one Discord creates for the application, which is the only role a
bot can be in; Heimdall looks it up. If you do set it, it must be that role's id —
the bot verifies it is actually a member and refuses to start otherwise, before
provisioning anything, because provisioning against a role it is not in produces
channels it can neither read nor repair.

- `DISCORD_SUPPORT_CATEGORY_NAME`: the category Heimdall creates for its own panel
  and queue board; default `Heimdall Support`. Useful if you already have a support
  structure you want these to sit in.

- `ARCHIVE_MAX_ATTACHMENT_BYTES`: maximum downloaded attachment size; default 10 MiB.
- `TRANSCRIPT_RETENTION_DAYS`: detailed transcript/attachment retention; default 180.
- `CLOSED_CHANNEL_DELETE_DAYS`: how long a closed ticket's Discord channel is kept in the
  Closed Tickets category before deletion; `0` deletes immediately; default 7.
  Supersedes `CLOSED_CHANNEL_DELETE_HOURS`, which is still read if present so an existing
  install keeps its current retention. Setting both is refused at startup.
- `DELIVERY_LEASE_SECONDS`: exclusive job lease duration; default 60.
- `DELIVERY_MAX_ATTEMPTS`: retry limit before a job is marked dead; default 12.
- `AUTO_CLOSE_INACTIVE_DAYS`: close tickets nobody has touched for this many days; `0`
  disables it; default 0.
- `COMMAND_AUDIT_CHANNEL`: whether the `gm-command-audit` channel exists at all; default on.
  It governs both writers — the module's command log, and the bot's record of the SOAP
  commands it issues on a named person's behalf — because they share one channel and
  splitting the decision is what made the bot's half impossible to enable. Off means the
  channel is never created, never recreated if you delete it, and entries already queued are
  discarded rather than retried. Leaving it on is recommended: the realm logs every command
  the bot sends as "Console", and this is the only record of who actually asked for it.
- `QUEUE_NUDGE_MINUTES`: how long a ticket may sit unclaimed before the queue board pings
  the Game Master role, once per ticket; `0` disables it; default 0.

The bot provisions its own Open, Claimed and Closed ticket categories, its panel
channel and its staff-only ticket queue channel on first run, storing their IDs in
`heimdall_setting`. The GM command audit channel is created only if that
module option is switched on.
`DISCORD_PANEL_CHANNEL_ID`, `DISCORD_OPEN_CATEGORY_ID`,
`DISCORD_CLAIMED_CATEGORY_ID` and `DISCORD_CLOSED_CATEGORY_ID` are therefore
optional; set one only to pin the bot to a channel you made yourself, and it
will never be overwritten.

Recommended, not required: after the first run, copy the ids the bot reports
into `.env`.

```
Created open tickets category (1408...) and stored it for future runs.
```

A zero-configuration first run is worth keeping, so nothing forces you to. What
pinning buys you is that the layout is written down somewhere you can read,
rather than living only in `heimdall_setting` where you have to query for it.

An id you set here must exist. Heimdall checks each one at startup and refuses
to start if one does not resolve, naming the variable and the id. It cannot
recover the way it does from a stored id that stopped resolving: creating a
replacement would leave your `.env` still naming the dead channel, and a new
category would appear on every restart.
