# Changelog

Versions are shared with the game module (mod-heimdall): the two halves release together, and one
number answers "which Heimdall are you running" for both. The bot's version appears in its startup
log line beside the run id and pid.

## 0.9.0 — 2026-08-30

First public release.

### What an operator gets

- **Roles are two ID lists, not three fixed names.** `DISCORD_STAFF_ROLE_IDS` (who answers
  tickets, one or many tiers) and `DISCORD_ADMIN_ROLE_IDS` (who manages the roster and overrides,
  optional — empty means Discord's Manage Server permission is the admin tier). Role names never
  matter. A role in both lists counts once, as admin, and the startup line reports how many of each
  resolved. The legacy `DISCORD_ADMIN_ROLE_ID` / `DISCORD_MODERATOR_ROLE_ID` / `DISCORD_GM_ROLE_ID`
  are still read and merged in — an existing install upgrades untouched.
- **Zero-configuration Discord layout.** On first run the bot provisions everything it needs — a
  support category holding the ticket panel and the staff queue board, plus Open, Claimed and
  Closed ticket categories — appended to the end of the channel list, remembered across restarts,
  and printed as one copy-paste block for operators who want the ids pinned in `.env`.
- **A startup that refuses instead of misbehaving.** The bot verifies it is actually a member of
  its role (and finds Discord's managed role by itself — do not create one), checks every
  permission in every place it works before touching anything, and stops with a named reason
  rather than provisioning channels it cannot use. A second copy of the bot refuses to start
  rather than doubling every action.
- **Private ticket channels with claim visibility**: an unclaimed ticket is visible to all rostered
  staff; a claimed one only to its claimant and admins. A private staff thread carries the
  controls, the player card, account notes and ticket history — nothing staff-facing can surface in
  the player-visible channel.
- **A staff roster mapped to GM identities**, validated against the names the realm actually
  accepted, so a typo is refused at `/ticket staff-add` rather than failing mid-conversation.
- **Durable delivery.** Replies, closures and GM actions ride a keyed, leased job queue: nothing is
  lost to a restart, retries back off, and a reply to an offline player waits for them without
  being an error.
- **Long replies handled honestly**: split across whispers on word boundaries, with a single
  over-long word (a pasted URL) split at the limit on character boundaries rather than rejected.
- **Closure from either side**, with one shared implementation: closed in Discord or closed in
  game, the channel moves, the player is told, the transcript is archived and the deletion clock
  starts.
- **Transcripts and attachments** archived privately with retention windows an operator controls,
  independent of whether the Discord channel still exists.
- **A GM command audit channel** (`COMMAND_AUDIT_CHANNEL`, on by default, one switch for both
  writers) recording what the bot ran and which Discord user asked for it — the realm's own log
  attributes every SOAP command to "Console".
- **Logs that answer the first three support questions**: version, run id and pid on the startup
  line; a permissions preflight that names what is missing, where, and what breaks; and secrets
  redacted before anything reaches the log file, whatever path they took.

### Requirements worth knowing before installing

- Install the game module first; on stock AzerothCore that includes its 15-line core patch.
- The bot's MySQL account must be able to reach only tables named `heimdall_%`. It is the
  internet-facing half and is deliberately never given access to player data.
- Windows is tested end to end. Linux and Docker should work and are documented, but no one has run
  them yet; reports welcome.
