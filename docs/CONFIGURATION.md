# Configuration reference

`DISCORD_TOKEN`, guild/role/channel IDs, MySQL values, SOAP values, archive
path, and `BOT_INSTANCE_ID` are required. The exact variables and safe sample
values are in `.env.example`.

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
- `QUEUE_NUDGE_MINUTES`: how long a ticket may sit unclaimed before the queue board pings
  the Game Master role, once per ticket; `0` disables it; default 0.

The bot provisions its own Open, Claimed and Closed ticket categories, its panel
channel and its staff-only ticket queue channel on first run, storing their IDs in
`heimdall_setting`. The GM command audit channel is created only if that
module option is switched on.
`DISCORD_PANEL_CHANNEL_ID`, `DISCORD_OPEN_CATEGORY_ID` and
`DISCORD_CLAIMED_CATEGORY_ID` are therefore optional; set one only to pin the
bot to a channel you made yourself, and it will never be overwritten.
