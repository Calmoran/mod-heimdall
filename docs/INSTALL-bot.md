# Quick-start installer guide

This guide is written for a separate development Discord server and a test
realm. Do not start on a public realm.

## 1. Install the module first

Follow [the module installation guide](INSTALL.md), including its one small core patch before
building. Confirm the module's SQL tables exist in the Characters database.

The bot is not a second download: it lives in this repository's `bot/` directory, so the clone you
just installed the module from already contains it. Every command in this guide runs from `bot/`
unless it says otherwise. Keep the bot account limited to those tables using
`deploy/mysql-grants.sql`; replace every placeholder before running it.

That file creates the account for both `@localhost` and `@127.0.0.1`, and you
need both. MySQL treats them as separate accounts: `localhost` matches a
unix-socket or named-pipe connection, while a TCP connection to `127.0.0.1`
matches the `127.0.0.1` host. The bot connects over TCP, so an account granted
only on `@localhost` fails with an access-denied error that reads exactly like
a wrong password.

## 2. Create the Discord application

In the Discord Developer Portal, create a bot application and enable these
gateway intents. Heimdall asks the gateway for all three at connect time, and Discord closes the
connection on an intent the application has not been granted - so a missing one is not a degraded
feature, it is a bot that will not start:

- **Guilds** - the bot has to see the guild, its channels and its roles at all. Nothing works
  without it.
- **Guild Messages** - ticket channels and staff threads deliver their messages. Without it staff
  discussion never reaches Heimdall and nothing is transcribed.
- **Message Content** (privileged) - message *bodies*. Discord delivers a message event without its
  text unless this is on, so the failure is quiet and specific: transcripts and the private archive
  fill with messages that have authors, timestamps and attachments, and no words. It is a toggle on
  the same portal page; a self-hosted bot in one guild is well under the 100-server threshold where
  Discord starts asking applications to justify it.

A start that dies with `Used disallowed intents` means one of these is off in the portal.

Invite it with exactly the permissions below and no others. These are the same names, in the same
two groups, that the bot prints at startup if one is missing, so a startup warning and this guide
always agree.

Heimdall does not work at all without these:

- View Channels — otherwise it cannot see ticket channels
- Send Messages — no ticket header, no replies, no queue board
- Read Message History — headers and the panel cannot be found again, so they are reposted or lost
- Embed Links — every header and the queue board are embeds and will not post
- Manage Channels — ticket channels and categories cannot be created, moved or deleted
- Manage Permissions — per-ticket visibility cannot be applied, so tickets may be readable by the
  wrong people
- Create Private Threads — no ticket gets a staff thread, so no ticket has any controls
- Send Messages in Threads — staff threads are created empty and stay empty

These each break one feature, and Heimdall will still start without them:

- Manage Threads — archived staff threads cannot be reopened, so older tickets become unusable
- Manage Webhooks — in-game messages post as the bot instead of under the player's character name
- Mention @everyone, @here and All Roles — with an empty staff roster, Heimdall cannot add
  administrators to a ticket thread. Only needed while your administrator role is not itself marked
  mentionable, which is the default. Making that role mentionable instead is the narrower choice.

That set is `361582775312` if you would rather build the invite URL yourself. Add the
`applications.commands` scope alongside `bot` so the `/ticket` commands can register — that is a
scope, not a permission, and it governs the commands rather than the bot's access to your server.

**Do not grant Administrator.** It silently satisfies every check above, including the startup
preflight, so a guild that grants it never finds out whether the permissions are actually right.

Check the same permissions are not denied by an overwrite on the ticket categories, the panel
channel, or the queue board channel. The bot checks every permission in all seven places at startup —
the server, the four categories, the panel and the queue board — reports both how many places it
could check and how many it expected, and **stops** if a permission it cannot work without is
missing, naming each one and where. It does not start half-working: a ticket system that runs while
unable to see ticket channels tells players they have reached someone when nobody comes.

Decide which of your existing roles work tickets. **Role names do not matter** — Heimdall reads
IDs, and your roles can be called anything; you do not need to create roles named for our variables
(that instinct is exactly what used to brick installs — see Troubleshooting in the module guide).

Two lists in the environment file:

- `DISCORD_STAFF_ROLE_IDS` — comma-separated, required. These roles can see unclaimed tickets and
  claim, reply, and close their own.
- `DISCORD_ADMIN_ROLE_IDS` — optional. These can additionally manage the staff roster, reassign and
  reopen tickets, and close or drive the GM identity on a ticket claimed by someone else. **Leave it
  empty** and anyone with Discord's own Manage Server permission is the admin tier — a small server
  configures exactly one role variable and is done. (With it empty, admin-only channels such as the
  command audit are visible only to members with the Administrator permission.)

Installs configured before these lists existed keep working: the old
`DISCORD_ADMIN_ROLE_ID`, `DISCORD_MODERATOR_ROLE_ID` and `DISCORD_GM_ROLE_ID` are still read and
folded in.

**Do not create a role for the bot.** Discord creates one automatically when you invite the
application — a *managed* role named after it, which you cannot delete and cannot add anyone to. That
is the only role the bot is ever in, and Heimdall finds it by itself. There is no
`DISCORD_BOT_ROLE_ID` in `.env.example` for that reason.

Making a role called "Bot" by hand and pasting its id is the single worst mistake available on a
first install: the bot grants channel access to a role it is not in, locks itself out of the channels
it just created, and cannot repair them afterwards because Discord does not let you manage a channel
you cannot view. Current versions refuse to start rather than provision in that state; the recovery
for an install that already did is in the module's INSTALL guide under Troubleshooting.

Drag that managed role **above** any role whose channel permissions the bot must manage.

You do not need to create channels. Heimdall provisions its own on first run — a support category
holding the `open-a-ticket` panel and the `ticket-queue` board, plus the Open, Claimed and Closed
ticket categories — appended to the end of your channel list, and remembers them. It prints the ids
afterwards if you would rather pin them in `.env`.

## 3. How the bot reaches your realm

It does not, directly - and that is the design, so it is worth thirty seconds before you install.

The bot cannot send your realm a command. When a staff member claims a ticket, closes one, or uses
a GM action, the bot writes a row to its own database naming **an action and its arguments as
separate fields**. The module, inside your worldserver, picks that row up and performs the action
through the core's own command handlers. The command text is composed in the module, from a fixed
list of actions, and nothing the bot writes is ever executed as a command.

So there is no game account to create for the bot, no remote command service to enable, and no
credential to guard. What a compromised bot could do is queue "close ticket 7". It cannot express
`.ban`, because no field it writes could carry one - the module would see an action it does not
have, and refuse it.

The bot's only access to your realm is the MySQL account you create in the next step: per-table
grants on seven `heimdall_*` tables, no DDL, loopback only.

### Checking that for yourself

Worth a minute, because a claim you can falsify beats a paragraph:

```sql
SELECT kind, payload_json FROM heimdall_delivery
 WHERE kind IN ('assign_ticket', 'close_ticket', 'gm_action', 'identity_login', 'identity_logout')
 ORDER BY id DESC LIMIT 5;
```

Every row is fields. No row contains a command.

## 4. Configure private storage and secrets

On the server, create a dedicated unprivileged account and paths:

```text
user/group: heimdall
application: /opt/heimdall-bot
environment: /etc/heimdall-bot/heimdall.env (mode 600)
archive: /var/lib/heimdall/archive (not under a public web root)
```

Copy `.env.example` to the environment location and replace every placeholder.
Keep MySQL loopback-only. The token, the database password, and the environment
file must never be committed or shared in tickets/screenshots.

## 5. Install and start

Install Node.js 20 or later and production dependencies, copy
`deploy/heimdall-bot.service` to the system service directory, review its
paths, reload service definitions, enable it, and start it. Follow your Linux
distribution's normal service-management procedure. The bot opens no public web
listener; it connects out to Discord and locally to MySQL.

## 6. Running the bot on your platform

> **All three have been run end to end**: Windows, Linux, and Docker on Docker Desktop. Each
> section below describes what that install actually needed, not what it ought to need.

### Windows — tested

`run-bot.cmd` sets `HEIMDALL_ENV_FILE` to the `.env` beside it and starts the bot - which is also
where the bot looks when nothing sets that variable, so `node src/index.js` from the `bot` directory
finds the same file. Run it from a terminal first and watch the startup lines; once it is behaving,
wrap it with NSSM or Task Scheduler so it survives a reboot. `deploy/heimdall-bot.service` is a
Linux unit and does not apply.

### Linux — tested

Run on Ubuntu 24.04 with Node 22 and MySQL 8.4, alongside AzerothCore built with clang.

Copy `deploy/heimdall-bot.service` to your system service directory, review every path in it, then
enable and start it the way your distribution expects. The unit sets `HEIMDALL_ENV_FILE`, runs as a
dedicated unprivileged account, and restricts writes to the archive directory.

**Review those paths properly, because the shipped unit and this guide disagree by default.** The
unit assumes the bot lives at `/opt/heimdall-bot` with its environment file in `/etc/heimdall-bot/`,
while step 1 of the module guide has you clone the repository into the core's `modules/` directory,
which on a typical Linux install is somewhere under `/home`. The unit also sets
`ProtectHome=true`, which makes `/home` unreadable to the service, so a bot left where the clone
put it fails to start under the unit even though it runs fine by hand. Either move the bot to
`/opt` as the unit expects, or change `WorkingDirectory`, `ExecStart`, `Environment` and
`ProtectHome` to match where it actually is. Do not change `ProtectHome` without deciding you
meant to.

To watch the first start before committing to a unit, run it directly with
`HEIMDALL_ENV_FILE=/path/to/.env node src/index.js` and read the startup lines.

**`HEIMDALL_ENV_FILE` is how the bot is told where its environment file is**, and every launcher
here sets it. Started by hand with the variable unset, the bot falls back to the `.env` beside it -
`bot/.env` in this clone, which is where the Windows launcher points anyway. Anywhere else, name the
file: a bot whose environment file was never opened fails with every required value reported
missing, which reads like a broken `.env` rather than an unread one.

### Docker — tested

Run against AzerothCore's own `docker-compose.yml` on Docker Desktop for Windows, with the bot in
its own container on the Compose network. A ticket filed in game reached Discord, was claimed,
whispered both ways and closed, with the GM identity held in world.

The module half needs nothing special: clone this repository into the core's `modules/`, apply the
core patch, and `docker compose up -d --build`. The build context includes `modules/`, so the module
is compiled in, and the schema imports itself through `ac-db-import` like any other module's SQL.

Five things are Docker-specific: three will stop you, one will point you at the wrong problem
entirely, and one only bites if your database is somewhere unexpected.

**The database port collides.** The shipped compose publishes MySQL on host port **3306**, which is
whatever MySQL you already have installed. Compose reads a `.env` beside `docker-compose.yml`:

```
DOCKER_DB_EXTERNAL_PORT=127.0.0.1:64306
```

Nothing inside the network uses this; services reach each other by name. The `127.0.0.1:` prefix
keeps the published port on the host's loopback rather than on every interface.

**`heimdall.conf` is an ordinary file, but nothing creates it.** The config directory is bind-mounted
from `./env/dist/etc` in your checkout, so you edit it with any editor. The container's entrypoint
copies `.dist` files in and creates `.conf` from `.dist` for the core's own configs — but **not for
modules**. So `env/dist/etc/modules/heimdall.conf.dist` appears and `heimdall.conf` does not, and
every `Heimdall.*` setting reads as missing until you copy it yourself:

```
cp env/dist/etc/modules/heimdall.conf.dist env/dist/etc/modules/heimdall.conf
```

Then restart the worldserver. (AzerothCore also accepts `AC_`-prefixed environment variables —
`AC_HEIMDALL_GM_CHAT_TAG` and so on — if you would rather keep configuration in Compose.)

**The shipped MySQL grants do not apply.** `deploy/mysql-grants.sql` grants to `'heimdall_bot'@'localhost'`
and `@'127.0.0.1'`. A bot in another container connects from neither — it arrives from the Compose
network's address range. Grant to `'heimdall_bot'@'%'` instead; the network is isolated, and the
account still reaches only the seven `heimdall_*` tables.

**Addresses are service names.** `MYSQL_HOST=ac-database`, `MYSQL_PORT=3306`. `127.0.0.1` in a
container is the container itself. If MySQL runs on the host instead, `host.docker.internal` reaches
it on Docker Desktop; on Linux that needs `--add-host=host.docker.internal:host-gateway`.

**A bot that cannot start looks like a bot that is already running.** With `restart:
unless-stopped`, a container that fails during startup is relaunched every few seconds, and each
relaunch finds the previous one's 60-second instance lock still held. The log then fills with
`Another ticket bot instance is already running` - one line per attempt, dozens per minute - and the
real error scrolls past once and never again. Reading the last line sends you hunting for a second
bot that does not exist.

Read the **oldest distinct** error in the log, not the last one:

```
docker compose logs heimdall-bot | grep -v 'already running' | head -30
```

The lock is not the fault; it is working exactly as designed, and it is what keeps two bots off one
database. It is only noisy about it.

The bot container needs to reach the database and nothing else — it sends the realm no commands, so
there is no second address to get right and no port to publish for it.

`deploy/docker-compose.bot.yml` is a worked example of the bot container, and `Dockerfile` in this
directory builds its image. Copy the fragment to `docker-compose.override.yml` in your core
checkout; Compose merges it automatically. The archive directory is a named volume there, because it
holds attachments that must outlive the container.

## 7. Things that will bite you

Collected from a clean AzerothCore build done from scratch. None of these are Heimdall's doing, but
all of them cost someone an afternoon.

- **CMake does not install the runtime DLLs beside the Windows executables.** `libmysql.dll`,
  `libcrypto-*.dll`, `libssl-*.dll` and `legacy.dll` have to be copied from your installed MySQL and
  OpenSSL directories. Current upstream documentation still names the OpenSSL 3 filenames; a recent
  build links against OpenSSL 4, so the names will not match what you are reading.
- **An unrestricted parallel build can exhaust the Windows paging file** and fail with compiler error
  `C3859` and system error `1455`. Limiting it fixes it: `--parallel 2 -- /p:CL_MPCount=2`.
- **`CONF_DIR` may not end up where the configure summary says.** On a recent Windows build the
  `.dist` files were installed to `server\configs` regardless. Look for `worldserver.conf.dist` and
  put `heimdall.conf` beside it — that is the rule that matters, not the value you passed to CMake.
- **The CMake option is `TOOLS_BUILD`, not `BUILD_TOOLS`.**
- **`server shutdown 0` is rejected.** The current syntax takes a duration: `server shutdown 1s 0`.
- **`localhost` and `127.0.0.1` are different MySQL accounts.** `deploy/mysql-grants.sql` creates
  both on purpose; granting only one produces an access-denied error that reads exactly like a wrong
  password.

## 8. Upgrading

1. Read the release notes and back up the `heimdall_*` tables together with the archive directory.
2. **Stop the bot cleanly** — Ctrl+C, or `systemctl stop`, not a force-kill. A clean stop releases the
   single-instance lock immediately, so the upgraded bot starts at once. A force-kill leaves the lock
   held by a process that no longer exists and the new one waits out a 60-second staleness window,
   saying so.

   Check nothing is left running before you start the new one. Older versions could not detect a
   second copy of themselves, so an install that has been restarted a few times may have more than
   one bot running without ever having said so — the symptom is every action happening twice and the
   loser complaining about work the winner already did. On Windows,
   `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` lists them.
3. Update the repository — one `git pull` brings both halves, so they cannot drift apart.
4. Apply any module SQL the release names, in order.
5. **On stock AzerothCore, reapply the core patch if you also updated the core.** A core update can
   revert it. Forgetting shows up as a compile failure, not as odd behaviour.
6. **Rebuild the worldserver if the module changed** — anything touching `modules/mod-heimdall/src`
   or its `.conf.dist`. A release that only changes the bot does not need a rebuild; a release that
   changes the module does, and the module will not behave as documented until you do. Release notes
   say which.
7. Compare your `heimdall.conf` against the new `heimdall.conf.dist` and add any new options. The
   worldserver warns about missing ones at startup and falls back to compiled defaults.
8. Compare your `.env` against `.env.example` the same way. Note that `DISCORD_BOT_ROLE_ID` is no
   longer required: if yours names a role you created by hand rather than the managed role Discord
   made for the application, the bot now refuses to start and names the correct id. Removing the line
   is the recommended fix — it then finds the role itself.
9. Start the worldserver, then the bot, and read both logs. The bot's permissions preflight runs at
   startup and names anything missing.
10. Smoke test one Discord ticket and one in-game ticket.

Rolling back: stop the bot, restore the previous code and configuration, and rebuild the worldserver
if the module changed. Restore the table backup only if a migration cannot be carried forward. Do
not edit `gm_ticket` to force a rollback.

## 9. Moving Heimdall to a different guild

Supported, with one thing that does not come across. Read the whole section before starting.

Every ticket row records the Discord channel it was given, and those ids belong to the old guild.
**Open tickets recover by themselves** — the module re-reads every open ticket on each poll, finds
the channel missing, and rebuilds it in the new guild. **Closed tickets do not.** Their channels stay
behind in the old guild and nothing in the new one links to them.

What that costs is less than it sounds: the transcript itself lives in the `heimdall_event` table and
the archive directory, not in Discord, so nothing is lost — the closed ticket's *Discord channel* is
what becomes unreachable. If those channels matter to you, export them from the old guild before you
start, because after the move nothing points at them.

1. Stop the bot.
2. Back up the `heimdall_*` tables.
3. Invite the application to the new guild and create your staff and admin roles there. Do not create a
   role for the bot; Discord makes one when you invite it.
4. Update `DISCORD_GUILD_ID` and the role id lists in `.env`, and blank any pinned channel or
   category id back to its placeholder — those ids name channels in the old guild and the bot will
   refuse to start while they do not resolve.
5. Clear the stored Discord layout, so the bot provisions a new one instead of looking for the old:

   ```sql
   DELETE FROM heimdall_setting WHERE setting_key LIKE 'discord.%';
   ```

   That covers the categories, the panel and queue channels, their message ids, the audit channel and
   the per-ticket staff thread ids.
6. Drop the queued channel deletions for the old guild, which can no longer succeed and would
   otherwise retry to `dead`:

   ```sql
   DELETE FROM heimdall_delivery WHERE kind = 'delete_channel' AND state <> 'delivered';
   ```

7. Optionally clear the stale channel ids on closed tickets, so nothing reads as though it still has
   somewhere to point:

   ```sql
   UPDATE heimdall_ticket SET discord_channel_id = NULL
    WHERE status IN ('closed', 'cancelled');
   ```

8. Start the bot. It provisions the new layout and prints the ids. Open tickets get their channels
   back on the next poll — within `Heimdall.TicketPollSeconds`, 15 seconds by default.

Do not run the bot against both guilds at once by copying the `.env`. The single-instance lock is
per process and both copies would be answering the same tickets; the second one refuses to start,
which is the intended outcome but not a migration strategy.

## 10. Fresh-install verification

1. The bot starts without printing secrets and posts one panel, not a duplicate.
2. A player creates Support, Bug Report, and Player Report tickets; each receives
   a unique `DIS-` channel and a second open ticket is rejected.
3. Every configured staff and admin role can see an unclaimed ticket. A player can
   see only their own Discord ticket.
4. Add a staff mapping with `/ticket staff-add`. Confirm that an eligible role
   without a mapping cannot claim or reply. **The GM character you map must be on an account with
   gmlevel 1 or higher**, or claiming an *in-game* ticket fails with the core's
   `Invalid name specified` — see the entry in
   [INSTALL.md](INSTALL.md#claiming-a-ticket-fails-with-invalid-name-specified). Discord-opened
   tickets are unaffected; they never touch the realm.
5. Claim a ticket. Confirm only the claimant, Admin, bot, and creator can see it.
6. Add a normal message and attachment. Confirm it is archived privately and is
   not publicly reachable.
7. Close, reopen, and reassign a ticket. Confirm the configured closed-channel
   deletion window works.
8. On a development realm only, test the full in-game flow: whisper the GM
   identity from a player character and confirm the message reaches the ticket
   channel, then reply from Discord and confirm it arrives in game.
