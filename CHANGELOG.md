# Changelog

One version for both halves: the realm module and the Discord bot release together from this
repository, and each prints the version in its startup line.

## 2.0.0 — 2026-09-02

Heimdall's tables leave the realm's characters database, and the ticket channel is rebuilt around
what a GM actually does in it. This is a major version because the move is a one-time migration on
every existing install, because it changes the one sentence that matters most about the bot - **the
bot never connects to a realm database. Its database contains Heimdall's own tables and nothing
else** - and because staff will find the interface behaves differently on the first ticket after
the upgrade.

### The ticket channel, if you are coming from 1.x

Nothing here needs configuring. It is written down because your staff will notice all of it.

- **The card is two boxes now, not one embed.** The ticket - its number, who opened it, and what
  they wrote - is on top in the stronger colour, because that is what you open the channel to
  read. The player, their history, their notes and the controls are underneath. Discord caps the
  message at 4,000 characters, so a very long ticket with a talkative account drops notes first,
  then history, then the player's background, and truncates the ticket text last - **and it always
  prints what it left out**. Nothing is hidden silently.

  Headers written by 1.x stay as they are until the ticket next changes state, then they are
  replaced. `/ticket refresh` does it immediately.

- **Successful button presses no longer say anything.** Claim, Reply, the identity toggle, Add
  Note, Remove Note, Refresh, the GM actions and Reopen used to each answer with a private message
  repeating what the card was about to show. They now just change the card. Errors are still
  private messages, and Close still asks for confirmation first, because closing is destructive.
  If a press looks like it did nothing, read the card.

- **The GM's replies are in the channel.** The channel used to say only "X replied in game", so
  half of every conversation was missing from the one place you would look for it. The words are
  now posted under the GM identity's name, beside the player's, with a line underneath saying
  whether the player was online when it was sent or whether it is waiting for them to log in. If
  Heimdall gives up on delivering one, that line is corrected to say so.

- **Staff chatter moved off the conversation.** Notes, GM-action lines, identity changes and
  reopen notices go to the ticket's work thread. A Discord-opened ticket uses the private staff
  thread it already had. An in-game ticket gets a `work-<ticket>` thread under its channel - the
  channel is already staff-only, so the thread is too, and nobody needs adding to it. Threads do
  not count against Discord's channel limits.

- **The player card actually refreshes.** "Refresh Player Info" never redrew anything: the module
  wrote a new snapshot within a second and nothing repainted, which is also why a player who had
  logged out could still read as online a quarter of an hour later. The card now redraws itself
  when the snapshot changes, and `Heimdall.ContextRefreshSeconds` **defaults to 15 instead of 60**.
  A sweep that finds nothing changed queues nothing, so this costs a query per open ticket rather
  than Discord traffic. An existing `heimdall.conf` keeps whatever value it already states - change
  it yourself if you want the new pace.

- **A closure driven from Discord says so.** Every close runs through the realm's `.ticket close`,
  so the channel reported all of them as "closed in game", including the one a GM had just clicked.
  It now reads "Closed by *GM* from Discord", and the realm's confirmation no longer posts a second
  notice contradicting the first.

- **Administrators can no longer act on a player through someone else's ticket.** This one is a
  behaviour change an admin will hit within a day. Revive, Unstuck, Combat stop, Teleport, Kick and
  the in-game identity toggle are now the claiming GM's alone - exactly as replying to the player
  always was. Close, Reopen, Reassign and the new Grant stay with administrators. An admin who
  needs to act takes the ticket with `/ticket reassign` first, which leaves a record of the
  handover; the refusal message says so.

  Identity is included deliberately: logging a GM's character in or out puts it in the world,
  visible and answerable, across every ticket that GM holds - not just the one being looked at.

- **`/ticket grant <ticket_id> <user>`** (administrators) lets one rostered GM read a closed ticket
  without reopening it. Reopening was previously the only way, and it clears the claim and puts the
  ticket back in the pool - far too much just so somebody can read.

- **Notes show the GM's name**, not a Discord mention that rendered as a blue pill mid-sentence
  and, once that account had left the server, as a bare numeric id.

### Changed

- **Heimdall has a database of its own.** The seven `heimdall_*` tables now live in a database
  named by the new `Heimdall.Database` setting - `heimdall` by default - on the same MySQL server
  as the realm. The module addresses it by name from the core's characters connection, so no new
  connection, pool or credential is involved; every query is qualified at the call site, and a
  name that is not a plain identifier, or that *is* the characters database, is refused at
  startup with the module disabled.

  Until now the bot's account was granted seven named tables inside the characters database, and
  the boundary held only as long as those grants were exact. Now the account is granted one
  database that has nothing of the realm's in it. A `SELECT` against `characters` from that account
  is refused by MySQL itself - `ERROR 1142 (42000): SELECT command denied` - and `SHOW DATABASES`
  from it lists Heimdall's and no realm database. `bot/deploy/mysql-grants.sql` is rewritten
  accordingly, and `npm run diagnose` now prints what the account can see and warns when that is
  more than it should be.

- **The module creates its own tables.** AzerothCore's updater is no longer involved: the schema
  moved from `data/sql/db-characters/base/heimdall.sql` to `deploy/heimdall-schema.sql`, the same
  text is compiled into the module, and on startup it creates whatever is missing and records a
  schema version in `heimdall_setting`. A test fails the build if the two copies differ by a byte.
  The startup guard refuses to run against a 1.x install that has not been migrated - it finds the
  tables in the characters database and none in Heimdall's, says so, and creates nothing - and
  refuses a schema version newer than it knows.

- **Upgrading is one `RENAME TABLE`.** `deploy/migrate-to-heimdall-db.sql` creates the database,
  renames the seven tables into it in a single atomic statement - no rows copied, ids and foreign
  keys intact - forgets the 1.x installer's row in the characters database's `updates` table, and
  replaces the bot's grants. `deploy/rollback-to-characters-db.sql` is the exact inverse. The
  steps, and the one ordering mistake the module catches for you, are under "Upgrading from 1.x"
  in `docs/INSTALL.md`. The bot's `MYSQL_DATABASE` must then name the new database.

- **Docker creates the database for you.** The compose fragment mounts
  `deploy/docker/heimdall-init.sh` into the MySQL container, which creates Heimdall's database and
  the bot's account on the first start with an empty volume, from `HEIMDALL_BOT_DB_PASSWORD` in
  the compose `.env`. An existing volume is never touched.

### Documentation

- `docs/SECURITY.md` states the database boundary and, new, the supply-chain posture: nothing
  here updates itself, a release reaches a realm only when its operator pulls it, and the database
  boundary is what contains a bad one, with the grants as the fallback behind it.
- INSTALL, INSTALL-bot, CONFIGURATION, ARCHITECTURE, OPERATIONS and the README no longer describe
  the tables as living in the characters database, because they do not.

## 1.1.3 — 2026-09-01

Documentation, and one small thing the bot does differently. The install guide told you the GM
identity could live on a plain account. It cannot, and the way that goes wrong is worth reading
before it happens to you.

### Fixed

- **The install guide was wrong about GM level, and it cost a first install its Claim button.**
  Step 6 said in bold that the identity's account needs no GM level, on the reasoning that the
  module gives game-master rights to the session it creates. It does — and whispering works
  perfectly on a plain account, which is exactly why this hid. But claiming an in-game ticket runs
  `.ticket assign`, and the core checks the **account's** stored gmlevel in `account_access`, never
  the session. Below 1, it refuses with

  ```
  Invalid name specified. Name should be that of an online Gamemaster.
  ```

  which names neither the real cause nor the right thing to look at: the name is fine, and the
  character need not be online. The name being checked is the one the claiming staff member is
  rostered under, which on most installs is the identity character too.

  The guide now says to give that account gmlevel 1 — Moderator, the lowest level the check
  accepts — and there is a troubleshooting entry keyed on the error text, in `docs/INSTALL.md`.
  **An existing install that claims tickets successfully already satisfies this and needs no
  change.**

- **The bot reads the `.env` beside it when `HEIMDALL_ENV_FILE` is unset.** Every launcher sets that
  variable; `node src/index.js` by hand does not, and the resulting failure pointed the wrong way —
  no file had been opened, so configuration validation reported every required value as missing,
  which reads like a broken `.env` rather than an unread one.

### Documentation

- `docs/SECURITY.md` and the README now draw the boundary between the three actors precisely, which
  matters more now that the guide asks for a GM level: the bot holds no realm credentials and cannot
  execute anything; the GM identity is a realm account operated only by the module inside the
  worldserver, its password nowhere in the bot's configuration; and the one privilege Heimdall asks
  of your realm is gmlevel 1 on the GM characters staff are rostered under.
- The Discord application's three gateway intents are each explained, including what goes quietly
  wrong without **Message Content**: transcripts keep authors, timestamps and attachments, and lose
  the words.
- Docker: a bot that fails at startup is relaunched into its own instance lock, so the log fills
  with `Another ticket bot instance is already running` and the real error appears once a minute
  among them. Read the oldest distinct error, not the last.
- `DELIVERY_MAX_ATTEMPTS` and `Heimdall.DeliveryMaxAttempts` must match, and nothing enforces it —
  the guide now says what drifting apart actually costs.

## 1.1.2 — 2026-09-01

Heimdall asks your server for one permission fewer, and a fresh install no longer opens with a
warning that was never true.

### Changed

- **Heimdall no longer asks for Manage Messages.** It wanted it for one thing: pinning the queue
  board. The board is the only message that will ever sit in that channel, so the pin bought nothing
  and has been removed, and the permission went with it.

  **The invite permission set is now `361582775312`, was `361582783504`.** Nothing needs doing to an
  existing install - it simply holds a permission Heimdall no longer uses, and you may remove it at
  your leisure. New installs ask for less.

  Heimdall also stopped *granting* Manage Messages in the channel overwrites it writes for admin
  roles and for its own role. It had to: Discord refuses to let a bot grant a permission it does not
  itself hold, so a bot invited under the narrower set could not have built its own channels at all.
  Admins keep whatever their own server roles give them. Nothing is granted that is not also asked
  for, and a test now holds that line.

### Fixed

- **A fresh install greeted you with `Could not pin the queue board: Missing Permissions`.** It was
  not a permission fault: the pin was attempted before Discord had finished applying the new
  channel's overwrites. Worse, the code claimed it would fix itself on the next start, and it could
  not - the pin was only ever attempted on the run that *created* the board, so once the message id
  was stored no further attempt was made and the board stayed unpinned for good.

- Documentation: the install guide now explains what happens if you delete and recreate the bot's
  Discord application. Channel permissions name the application's managed role, and that role dies
  with it, so a replacement application cannot see - or repair - the channels its predecessor made.
  Deleting them and letting the bot rebuild is the cure.

- `.env.example` now shows a Windows answer for `ARCHIVE_DIR` and `LOG_DIR` beside the Linux
  defaults, instead of leaving Windows operators with `/var/lib/heimdall/archive` and a `LOG_DIR`
  of `.` that lands wherever the launcher happened to run.

No module changes: **the worldserver does not need rebuilding for this release.**

## 1.1.1 — 2026-09-01

**Upgrade from 1.1.0 immediately: the bot in 1.1.0 cannot start.**

### Fixed

- **The bot exited before it logged anything, on every start.** 1.1.0 removed the SOAP client, but
  two references to its configuration survived, and one of them runs before everything else: the log
  writer is built from the list of secrets to redact, and that list named the SOAP password. Every
  start died with `Cannot read properties of undefined (reading 'password')`. On Windows, launched
  from `run-bot.cmd`, the console window opens and closes with the message still in it.

  There is no workaround in 1.1.0 and no configuration that avoids it. Pull this release; nothing
  else needs to change, and the realm module is unaffected.

  `diagnose.js` printed the same values and is fixed with it.

## 1.1.0 — 2026-08-31

The bot no longer holds any credential for the realm. This is the release to point at if anyone asks
what your Discord bot is allowed to do on your server.

### Changed

- **The realm's own module runs Heimdall's commands.** Claiming a ticket, closing one, holding a GM
  identity and the five GM actions are now asked for rather than sent: the bot writes a row naming
  an action and its arguments as separate fields, and the module leases that row and performs the
  action inside the worldserver, through the core's own command handlers.

  The command text is composed in the module, from a fixed list of actions. Nothing the bot writes
  is executed as a command, so a compromised bot can queue "close ticket 7" and cannot express
  `.ban` — there is no field that could carry one. The boundary is structural rather than a
  question of trusting the bot, which is the only kind of assurance worth offering.

  The bot's whole access to the realm is now its MySQL account: per-table grants on seven
  `heimdall_*` tables, no DDL, loopback only. `docs/INSTALL-bot.md` has a query you can run to
  confirm for yourself that what the bot queues is fields and never commands.

- **A staff member's click reaches the realm in about a second.**
  `Heimdall.DeliveryPollSeconds` now defaults to **1**, was 5. It used to be a background retry
  cadence; it is now also the delay between pressing a ticket control and the realm acting on it.
  Your own `heimdall.conf` is never rewritten by an upgrade, so an install carrying the old value
  keeps it — change the line yourself to get the new responsiveness. Raising it makes every ticket
  control slower by the amount you raise it.

- **`Heimdall.DeliveryMaxAttempts` is new**, default 12, matching the bot's `DELIVERY_MAX_ATTEMPTS`.
  Both halves now fail a queued job by the same rule — same attempt count, same backoff, same
  definition of dead — so a command the realm gives up on is buried exactly as one the bot gives up
  on, and the warning after the third failure and the dead letter still arrive in the ticket
  channel, naming the action and the true number of attempts.

## 1.0.0 — 2026-08-31

The first release verified end to end on all three supported platforms: Windows, Linux and Docker.
Nothing in the module or the bot changed to make Docker work — the walkthrough found five install
blockers that were all documentation, and the docs now match what actually happens.

### Fixed

- **A GM name added to the staff roster was stored exactly as it was typed.** The realm matches
  character names case-sensitively when a ticket is assigned, so `heimdalltest` was rejected with
  *"Invalid name specified"* against a character called `Heimdalltest`. Worse, the mistyped value did
  not stay in the roster: claiming a ticket copies it onto the ticket, so one bad roster entry
  poisoned every ticket that person touched.

  Staff-add now stores the realm's own spelling and tells you when it corrected you. Rows already
  stored wrong repair themselves the first time they are used — there is no migration to run.

- **A message to the realm that kept failing was given up on in silence.** Twelve attempts over
  roughly 81 minutes, and then the job was buried with nothing said in the channel, before or after.
  A ticket could sit unassigned in game while Discord showed it claimed.

  Heimdall now warns in the ticket's channel after the third consecutive failure, and posts a
  dead-letter when it gives up: which ticket, how many attempts it actually made, and the last error
  the realm returned. Transient failures that recover on their own still say nothing.

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
through documented GM commands.

### The realm module

- **Read-only ticket polling** that resumes from a persisted per-realm watermark. An idle realm
  writes nothing; a restarted worldserver does not re-announce tickets it has already seen.
- **Closure from either side.** Tickets closed in Discord close in game (`.ticket close`);
  tickets closed in game — including a player abandoning theirs, or a GM at the console — close in
  Discord, with the same channel move, notice and retention clock.
- **GM identities held in world.** Each configured identity is a real character brought into the
  world with no game client attached: whisperable, invisible in `/who`, and carrying the client's
  `<GM>` chat badge on its replies (`Heimdall.GmChatTag`, on by default) — a protocol flag a player
  character cannot forge.
- **A published identity list.** The names that survive startup validation are published to the
  bot, so a typo in `/ticket staff-add` is refused when it is made, not discovered mid-conversation.
- **A GM command audit trail** (`Heimdall.CommandAuditEnabled`) batched to Discord, with the bot
  attributing the commands it causes to the Discord user who pressed the button.
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
  attributes every one of them to "Console".
- **Logs that answer the first three support questions**: version, run id and pid on the startup
  line; a permissions preflight that names what is missing, where, and what breaks; and secrets
  redacted before anything reaches the log file, whatever path they took.

### Requirements worth knowing before installing

- One small core patch (shipped in `patches/`, 15 lines, no behaviour change) is required before
  building. An upstream pull request is planned so the step can eventually disappear.
- The bot must run on the same host as the realm — it needs loopback MySQL — and its database
  account is scoped to the module's own `heimdall_*` tables. It is never given access to player
  data or `gm_ticket`.
- Windows is tested end to end. Linux and Docker should work and are documented, but no one has run
  them yet; reports welcome.
