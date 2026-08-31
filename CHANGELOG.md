# Changelog

One version for both halves: the realm module and the Discord bot release together from this
repository, and each prints the version in its startup line.

## 0.9.1 — 2026-08-31

A fix worth upgrading for if you run more than one Heimdall against one Discord server, and the
first release with Linux tested end to end.

### Fixed

- **A second install sharing one Discord server could take over the first install's ticket
  channels.** Ticket channels are found again by a marker in their topic, and that marker was built
  from the ticket key alone. The key starts with the realm tag, which falls back to `R<RealmID>`
  when `Heimdall.RealmPrefix` is blank — and almost every standalone install is RealmID 1. So a live
  realm and a test realm pointed at one Discord server both produced keys like `R1-3`, and the
  second install would adopt the first's channel: a brand new ticket arriving in the Closed
  category, carrying a different ticket's history and its permissions.

  Channels are now stamped with an id belonging to the install that made them, and an install will
  not adopt a channel it did not create. Nothing to configure; the id is generated on first start.
  Channels created before this release are adopted once and restamped.

  **If you run two installs against one Discord server, upgrade.** Giving each realm its own
  `Heimdall.RealmPrefix` is still worth doing and is still the clearer setup, but it is no longer
  the only thing standing between you and mixed-up tickets.

- Two staff-facing messages still named the Admin, Moderator and Game Master roles that 0.9.0
  replaced with role lists. They now say "staff" and "admin", matching whatever your roles are
  actually called.
- Queue nudges mention every staff role, which is what the code has always done. The configuration
  reference and `.env.example` both said the Game Master role.
- `Heimdall.CommandAuditMinSecurity` is clamped to 0-3. Outside that range it audited either nothing
  or everything, silently.
- `LICENSE` now contains the AGPL-3.0 text rather than a link to it.

### Changed

- **Linux is tested.** Built, installed, and exercised end to end on Ubuntu 24.04 with MySQL 8.4: a
  ticket filed in game, claimed in Discord, whispered both ways, closed, with the GM identity held
  in world. The install docs now carry what that install actually needed:
  - MySQL 8 refuses a password with no symbol in it, and reports only that its policy was not
    satisfied — which does not tell you your password is the problem.
  - **The GM identity needs its own game account**, one nobody plays on. The module refuses to hold
    an identity whose account has a live session, so an identity sharing your own account stops
    working the moment you log in. It needs no GM level.
  - **The realm tag must be unique per Discord server**, not merely per database.
  - The shipped `heimdall-bot.service` expects the bot in `/opt` and sets `ProtectHome=true`, which
    cannot read a bot installed under `/home` where the module guide's clone puts it.
- A superseded setting now says so. An install still using `DISCORD_ADMIN_ROLE_ID`,
  `DISCORD_MODERATOR_ROLE_ID` or `DISCORD_GM_ROLE_ID` gets one warning per variable at startup,
  naming the replacement and saying the old name is still honoured. Nothing breaks; you migrate when
  it suits you. How configuration changes are handled is now written down in the configuration
  reference.
- Limits moved to where the settings they govern are, and `docs/LIMITS.md` is gone. The limits you
  can change are documented beside the setting that changes them; the ones you cannot are a section
  in the README for anyone deciding whether to install.
- The startup summary no longer claims to have provisioned a Discord layout on runs where it created
  nothing and simply reused the ids already in your `.env`.

### Still not tested

Docker. Windows and Linux are both exercised end to end; Docker is written from the code and the
platform's conventions and has never been run.

## 0.9.0 — 2026-08-30

First public release.

### What Heimdall is

An AzerothCore module that bridges in-game GM tickets to Discord. Tickets appear as private Discord
channels; staff claim and answer them there; replies reach the player in game as whispers from a
real GM character. The module reads `gm_ticket` and never writes it — every in-game change goes
through documented GM commands over SOAP.

### The realm module

- **Read-only ticket polling** that resumes from a persisted per-realm watermark. An idle realm
  writes nothing; a restarted worldserver does not re-announce tickets it has already seen.
- **Closure from either side.** Tickets closed in Discord close in game (`.ticket close` over SOAP);
  tickets closed in game — including a player abandoning theirs, or a GM at the console — close in
  Discord, with the same channel move, notice and retention clock.
- **GM identities held in world.** Each configured identity is a real character brought into the
  world with no game client attached: whisperable, invisible in `/who`, and carrying the client's
  `<GM>` chat badge on its replies (`Heimdall.GmChatTag`, on by default) — a protocol flag a player
  character cannot forge.
- **A published identity list.** The names that survive startup validation are published to the
  bot, so a typo in `/ticket staff-add` is refused when it is made, not discovered mid-conversation.
- **A GM command audit trail** (`Heimdall.CommandAuditEnabled`) batched to Discord, with the bot
  attributing its own SOAP commands to the Discord user who pressed the button.
- **Multi-realm support**: tickets carry a realm tag, so several realms can share one Characters
  database without colliding.
- **A startup line that states the resolved configuration** — command audit, GM chat tag, poll
  timings — so a config file silently reverted by a rebuild is visible in the log rather than
  discovered when a feature is missed.
- **A realm-tag guard**: the tag is chosen once at install; the worldserver warns at startup —
  ERROR-level for stranded open tickets — when tickets exist under any other tag, because changing
  the prefix mid-life re-imports open tickets and orphans the old records.

### The Discord bot (bot/)

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
  staff; a claimed one only to its claimant and admins. In-game tickets are worked directly in the
  staff-only channel — header, player card, account notes, controls and discussion in one place.
  Discord-opened tickets keep a private staff thread, because the reporter shares that channel and
  must not see staff content.
- **`/ticket refresh`** redraws a ticket's header and controls on demand — inside the ticket
  channel, or by ticket id from anywhere. Staff-level, not admin-only. Headers otherwise redraw
  only when a ticket changes state, which made layout upgrades invisible on open tickets.
- **Consolidated controls**: three rows — Claim / Reply / a login-logout toggle that acts on the
  identity's actual current state / Close; then Reopen Ticket and the player-card utilities; then
  one GM-actions menu (revive, unstuck, stop combat, teleport, kick last). Two rows of headroom
  against Discord's five-row ceiling.
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

- One small core patch (shipped in `patches/`, 15 lines, no behaviour change) is required before
  building. An upstream pull request is planned so the step can eventually disappear.
- The bot must run on the same host as the realm — it needs loopback MySQL and loopback SOAP — and
  its database account is scoped to the module's own `heimdall_*` tables. It is never given access
  to player data or `gm_ticket`.
- Windows is tested end to end. Linux and Docker should work and are documented, but no one has run
  them yet; reports welcome.
