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

Where staff discussion belongs depends on who opened the ticket. A Discord-opened
ticket's reporter *is* in the channel, so everything staff-facing lives in a
private thread they cannot see - never move that discussion into the channel,
because they read it. An in-game ticket's channel is staff-only by its
permissions, because the player has no Discord account in the room, but it gets a
work thread of its own anyway. See "What goes where" below.

## What the ticket card looks like

The header is one message made of two boxes. The top box is the ticket: its
number, who opened it and when, then the text they wrote, with the stronger
accent colour. The bottom box is the player - character, level, zone, whether
they are online right now, whether the GM identity is in the world, their ticket
history, and any notes on their account - with the controls underneath in working
order: claim it, talk to them, be in the game, close it.

Discord caps the whole message at 4,000 characters. When there is more to show
than that, Heimdall drops notes first, then history, then the player's
background, and truncates the ticket text last of all. **It always says what it
left out**, in small print at the bottom of the player box - "40 notes are not
shown here" means the notes are on the account, not lost.

Headers written by 1.x are replaced with this layout the first time the ticket
changes state, or immediately if you run `/ticket refresh`.

## What goes where

The ticket channel is the **conversation** and nothing else: the player's
messages, and the GM's replies under the identity's own name, in order. Each
reply carries a small line underneath saying whether the player was online when
it was sent, or that it is waiting for them to log in. If Heimdall eventually
gives up on delivering one, that line changes to say so - a reply you can see in
the channel is never quietly one that never arrived.

Everything else - notes, GM actions, identity changes, reopen notices - goes to
the ticket's **work thread**, so the conversation stays readable as a record. A
Discord-opened ticket uses its existing private staff thread. An in-game ticket
gets a thread named `work-<ticket>` under its channel; that channel is already
staff-only, so the thread is too, and nobody has to be added to it.

### Turning the in-game split off

If you would rather have everything in the one channel, as it was before 2.0.0:

| Command | Effect |
|---|---|
| `/ticket work-split` | staff work goes to a `work-` thread under each in-game ticket (the default) |
| `/ticket work-merge` | staff work stays in each in-game ticket's channel |

Administrators only. One setting for the whole install, not per ticket, and it
takes effect on the next line written - no bot restart.

Two rules worth knowing before you use them:

- **In-game tickets only.** A Discord-opened ticket keeps its private staff
  thread under both settings, and nothing will move its staff notes into the
  channel: the person who opened the ticket is reading that channel.
- **Forward-only.** Switching never moves, copies or deletes anything already
  posted. A ticket that already has a `work-` thread keeps it; after
  `work-merge` that thread simply stops growing, and after `work-split` a new
  one is made on the next line that needs one.

Each change is recorded in the audit table with the administrator who made it.

## Buttons no longer answer back

A button press that works changes the card, or posts in the channel, and says
nothing else. There is no "Claimed." or "Note saved." popup, because whatever it
would have told you has already happened in front of you. What still speaks:

- **errors**, always, and only to the person who pressed the button;
- the **Close** confirmation, because a closed ticket cannot be un-closed by
  pressing the same button again.

If a press seems to have done nothing, read the card and the channel before
looking for a message.

## Who may do what, to whose ticket

Acting on a **player** belongs to the GM handling the ticket. Administering the
**ticket** belongs to administrators.

| Action | Who |
|---|---|
| Reply to Player | the claiming GM only |
| Revive, Unstuck, Combat stop, Teleport, Kick | the claiming GM only |
| Log In / Out Of Game | the claiming GM only |
| Close | an administrator, or the claiming GM |
| Reopen, Reassign, Grant | an administrator |
| Refresh Player Info, `/ticket refresh` | any staff member |
| Add Note, Remove Note | any rostered staff member |

An administrator who needs to act on a player through somebody else's ticket
takes the ticket first with `/ticket reassign`, which leaves a record of the
handover; the refusal message says so. Logging a GM identity in or out counts as
acting on a player rather than as administration, because it puts that character
in the world - visible, whisperable and answerable - across every ticket that GM
holds at once.

## Reading a closed ticket without reopening it

`/ticket grant <ticket_id> <user>` (administrators) gives one rostered staff
member access to a closed ticket's channel. Reopening used to be the only way to
do that, and it clears the claim and puts the ticket back in the pool - far too
much just so somebody can read. The access lasts until the channel is deleted by
the closed-channel clock below.

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
