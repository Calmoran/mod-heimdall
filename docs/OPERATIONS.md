# Staff operations, retention, upgrades, and troubleshooting

## Staff operations

Administrators use `/ticket staff-add`, `/ticket staff-remove`, and
`/ticket staff-list` to maintain mappings. A mapped GM character needs gmlevel 1
or higher on its account, or claiming an in-game ticket is refused by the realm;
the troubleshooting section below has the error text. Any staff member can run
`/ticket refresh` inside a ticket channel (or with a ticket id from anywhere) to
redraw its header and controls — useful after an upgrade, since headers
otherwise only redraw when the ticket changes state. Eligible Discord role plus an enabled
mapping is required to claim or send a player-facing reply. Admins may reassign,
reopen, and close tickets.

Use **Claim** before responding. Use **Reply to Player** only when the message
must be sent in-game. Use **Add Note** for facts staff should retain - a note is
attached to the player's game account and appears on every future ticket that
account opens.

Where staff discussion belongs depends on who opened the ticket. An in-game
ticket's channel is staff-only by its permissions, because the player has no
Discord account in the room, so staff work directly in the channel and there is
no thread. A Discord-opened ticket's reporter *is* in the channel, so everything
staff-facing lives in a private thread they cannot see - never move that
discussion into the channel, because they read it.

## Retention

Closed transcripts and attachments are private for `TRANSCRIPT_RETENTION_DAYS`
(default 180). The cleanup job removes files and detailed content at expiry,
leaving only anonymous operational/audit counts where configured. Closed Discord
channels move to the Closed Tickets category and are deleted after
`CLOSED_CHANNEL_DELETE_DAYS` (default 7); `0` deletes immediately.

These are two separate clocks with two separate purposes, and they are easy to
confuse. `CLOSED_CHANNEL_DELETE_DAYS` governs only how long the Discord channel
stays visible to staff. `TRANSCRIPT_RETENTION_DAYS`, together with the module's
`Heimdall.ArchiveRetentionDays`, governs when the database record and
the archived attachments are purged. Deleting the channel does not purge the
transcript, and purging the transcript does not delete the channel. Keep the
module and bot retention values in sync with each other.

## Backup and restore

Before any upgrade, back up Heimdall's database (`Heimdall.Database`, default
`heimdall` - all seven `heimdall_` tables) and the private archive directory
together. Restore both to a non-public test environment first,
start the bot with a temporary Discord guild, and verify ticket history and
attachments.

## Upgrade

Read the release notes, back up, stop the bot, apply any SQL migration the
release ships (2.0.0 has one: `deploy/migrate-to-heimdall-db.sql`, described in
INSTALL.md), update the module and bot code, install production dependencies,
validate the environment file, then start the bot and inspect its logs. Perform one
Discord-native and one in-game ticket smoke test.

## Rollback

Stop the bot. Restore the previous bot code and module build/config, then restore
the pre-upgrade module-table backup only if its migration cannot be rolled back
forward safely. Do not edit `gm_ticket` to force a rollback. Keep the queue and
audit records until the incident is understood.

## Troubleshooting

- **No panel or duplicate panel:** verify guild/channel IDs and the single saved
  `discord.panel_message_id` setting.
- **Staff cannot claim:** check both their Discord role and enabled roster entry.
- **Channel visible to too many staff:** inspect `DISCORD_STAFF_ROLE_IDS` and
  `DISCORD_ADMIN_ROLE_IDS` and the bot's Manage Channels/role position.
- **In-game update missing:** confirm module enabled, queue jobs not dead, and
  the bot's limited MySQL access.
- **A realm command retrying:** the module runs these inside the worldserver, so
  look in `Heimdall.log` for the refusal it recorded and at the row's
  `last_error` in `heimdall_delivery`. The reason is the core's own — a ticket id
  that no longer exists, a GM name the realm does not accept. Do not work around
  it with direct ticket-table writes.
- **Player reply rejected or not delivered:** the GM identity is not logged in
  — often because someone has a live session on its account, which the module
  refuses to touch — or the target player is offline. Whispering needs no GM
  level on the identity's account; the module supplies that to the session. A
  `to_game` job left `queued` means a precondition is not met yet and it will
  retry; it is not an error. Check `.heimdall identity status` on the
  worldserver console.
- **Claim fails with "Invalid name specified. Name should be that of an online
  Gamemaster.":** the account behind the claiming staff member's rostered GM
  character is below gmlevel 1. `.ticket assign` reads the stored level from
  `account_access`, never the session, and the message names neither the real
  cause nor the right thing to check. Set it from the worldserver console with
  `account set gmlevel <account name> 1 -1`; the retrying job then succeeds on
  its own. Full entry in `docs/INSTALL.md`.
