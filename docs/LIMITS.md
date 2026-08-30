# Limits

What Heimdall will not do, where the ceilings are, and which ones you can move. Values are the
shipped defaults; where a setting name is given, that is what changes it.

Two of these surprise people, so they are first.

## The two that surprise people

**Staff space depends on who opened the ticket.** An in-game ticket's channel is staff-only by its
permissions — the player has no Discord account in the room — so staff work directly in the channel:
header, player card, controls and discussion, no thread. A Discord-opened ticket's reporter *is* in
the channel, so everything staff-facing lives in a private thread they cannot see. Do not move staff
discussion of a Discord ticket into its channel; the reporter reads it.

The ticket header carries three rows of controls (the working buttons, the player-card utilities,
then the GM action menu) against Discord's ceiling of five rows per message — two rows of headroom.

**AzerothCore allows one open ticket per player, not Heimdall.** A player with an open in-game ticket
cannot file another until it is closed. This is the core's own rule, enforced in `GetTicketByPlayer`,
and Heimdall neither adds to it nor works around it. Heimdall applies the same rule to Discord-opened
tickets, which is its own choice and is listed below.

## Message sizes

| Limit | Value | What happens at the limit | Changeable |
|---|---|---|---|
| In-game whisper segment | 240 bytes | Longer replies are split across several whispers on word boundaries. A single word longer than the limit — a pasted URL, usually — is split mid-word rather than rejected | `Heimdall.MaxWhisperBytes`, 32–255 |
| Stored message text | 2000 characters | Longer text is truncated before it is recorded | No |
| Ticket description and staff notes typed into a form | 1800 characters | The form will not accept more | No |
| Short form fields (character name, destination) | 120 characters | The form will not accept more | No |
| Player notes shown on the card | 180 characters each, 5 notes | Longer notes are shown truncated; older notes are not shown | No |
| GM command audit | 25 lines or 10 seconds per message | Batches are split; a single line over 1700 characters is truncated | `Heimdall.CommandAuditMaxLines`, `Heimdall.CommandAuditBatchSeconds` |

The underlying Discord caps Heimdall works within: 2000 characters per message, 4096 per embed
description, 1024 per embed field, 45 for a form title or label, 100 for a form description.

## Timings

| Limit | Value | Changeable |
|---|---|---|
| How often in-game tickets are read | every 15s | `Heimdall.TicketPollSeconds` |
| How often queued whispers are delivered | every 5s | `Heimdall.DeliveryPollSeconds` |
| How often the player card refreshes | every 60s | `Heimdall.ContextRefreshSeconds`, minimum 10 |
| How often the bot processes its queue | every 5s | No |
| How often the queue board redraws | every 60s, and immediately on any ticket change | No |
| Retention sweep | hourly | No |
| Restart after a hard kill | up to 60s | No |

A queued whisper waits until the player is online and the GM identity is held. It is not lost, and
"still queued" is not an error.

Only one bot may run against a realm at a time, and the lock that enforces it is held per process.
Stopping the bot with Ctrl+C releases it, so a normal restart is immediate. Killing it outright
(`taskkill /F`, a crash) leaves the lock held by a process that no longer exists, and the next start
is refused for up to a minute with a message saying how long to wait. That window is what lets a
crashed bot recover on its own instead of needing the settings table edited by hand.

## Retention

| Limit | Value | Changeable |
|---|---|---|
| Transcripts and attachments kept after closure | 180 days | `TRANSCRIPT_RETENTION_DAYS` and `Heimdall.ArchiveRetentionDays` — **keep these two the same** |
| Closed ticket channel kept in Discord | 7 days | `CLOSED_CHANNEL_DELETE_DAYS`; `0` deletes immediately |
| Tickets closed automatically after inactivity | off | `AUTO_CLOSE_INACTIVE_DAYS` |
| Log file | 5 MiB per file, 5 files | `LOG_MAX_FILE_BYTES`, `LOG_RETAINED_FILES` |

Deleting the Discord channel does not purge the transcript, and purging the transcript does not
delete the channel. They are two clocks with two purposes.

## Capacity

| Limit | Value | What happens at the limit |
|---|---|---|
| Tickets shown on the queue board | roughly 40, or 3800 characters of lines | The oldest are kept and the rest are counted: "…and 12 more" |
| Ticket types offered in the panel menu | 25 | Discord's cap on menu options; extras are not offered |
| Attachment size | 10 MiB | Larger attachments are refused and logged (`ARCHIVE_MAX_ATTACHMENT_BYTES`) |
| Open Discord tickets per person | 1 | A second attempt is refused with an explanation |
| Delivery retries | 12, with backoff doubling to 15 minutes | The job is marked `dead` and stops retrying. It is still in the table for staff to inspect |
| Realm tag | 1–16 letters or digits | An invalid tag refuses to start the bridge rather than writing colliding keys |
| Character name | 12 characters | AzerothCore's own limit |

## Imposed by Discord or AzerothCore

These are not ours to change.

- Five component rows per message — the staff header ceiling above.
- 25 options in a select menu.
- 2000 characters per message, 4096 per embed description, 1024 per embed field.
- One open in-game ticket per player.
- Realm IDs above 255 are refused by the worldserver, so the automatic realm tag is never longer
  than `R255`.
- A private thread has no role-based visibility. Members are added one at a time — which is why
  Discord-opened tickets (the only ones that still use threads) depend on the staff roster, and why
  an empty roster is warned about at startup and on each affected ticket.
- Discord archives a thread after a week of inactivity. Heimdall reopens one when it needs to, which
  requires the Manage Threads permission.

## Things Heimdall does not do

- It needs one small core patch to hold a GM identity in the world. The patch ships with the
  module and changes no behaviour.
- It never writes to `gm_ticket`. Every in-game change goes through documented GM commands over
  SOAP.
- It does not give the bot access to player data. The bot's database account reaches only the seven
  `heimdall_*` tables; everything about a player is published to it by the module.
- It does not link Discord accounts to game accounts, so it cannot offer self-service actions that
  act on a character.
- It does not send item or gold compensation.
- Replies whisper from a real GM character carrying the client's `<GM>` badge
  (`Heimdall.GmChatTag`, default on) — a protocol flag a player character cannot forge.
- The GM command audit channel exists unless `COMMAND_AUDIT_CHANNEL` is switched off, which
  silences both of its writers at once.
