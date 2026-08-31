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
gateway intents:

- Guilds
- Guild Messages
- **Message Content** (privileged; needed to archive normal ticket messages)

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
- Manage Messages — the queue board cannot be pinned
- Mention @everyone, @here and All Roles — with an empty staff roster, Heimdall cannot add
  administrators to a ticket thread. Only needed while your administrator role is not itself marked
  mentionable, which is the default. Making that role mentionable instead is the narrower choice.

That set is `361582783504` if you would rather build the invite URL yourself. Add the
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

## 3. Enable SOAP and create the account the bot uses

The bot makes every in-game change through AzerothCore's SOAP service, so it needs that service
switched on and an account to authenticate with. Neither is created for you.

In `worldserver.conf`:

```
SOAP.Enabled = 1
SOAP.IP = "127.0.0.1"
SOAP.Port = 7878
```

Keep it on loopback. It accepts GM commands, so exposing it publicly is the same as handing out a
console.

Then create a dedicated game account for the bot and give it GM rights, at the worldserver console:

```
account create heimdallsoap <a strong password>
account set gmlevel heimdallsoap 3 -1
```

The level matters: the bot assigns and closes tickets, and a lower level fails with a permission
error that looks like a bug. Use a separate account rather than a person's, so its actions are
identifiable in the command audit log.

Put that account's name and password in `SOAP_USER` and `SOAP_PASSWORD`, and the URL in `SOAP_URL`.

## 4. Configure private storage and secrets

On the server, create a dedicated unprivileged account and paths:

```text
user/group: heimdall
application: /opt/heimdall-bot
environment: /etc/heimdall-bot/heimdall.env (mode 600)
archive: /var/lib/heimdall/archive (not under a public web root)
```

Copy `.env.example` to the environment location and replace every placeholder.
Keep MySQL and SOAP loopback-only. The token, database password, SOAP password,
and environment file must never be committed or shared in tickets/screenshots.

## 5. Install and start

Install Node.js 20 or later and production dependencies, copy
`deploy/heimdall-bot.service` to the system service directory, review its
paths, reload service definitions, enable it, and start it. Follow your Linux
distribution's normal service-management procedure. The bot opens no public web
listener; it connects out to Discord and locally to MySQL/SOAP.

## 6. Running the bot on your platform

> **Windows and Linux have both been run. Docker has not.** The Docker section is written from the
> code and from the platform's normal conventions and has never been executed. Treat it as a
> starting point, and please report what was wrong.

### Windows — tested

`run-bot.cmd` sets `HEIMDALL_ENV_FILE` to the `.env` beside it and starts the bot. Run it from a
terminal first and watch the startup lines; once it is behaving, wrap it with NSSM or Task Scheduler
so it survives a reboot. `deploy/heimdall-bot.service` is a Linux unit and does not apply.

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

### Docker — untested

The bot has no Dockerfile. If you build one, the thing that will break is not the image, it is the
addresses.

`MYSQL_HOST=127.0.0.1` and `SOAP_URL=http://127.0.0.1:7878/` are correct only when the bot shares a
host with MySQL and the worldserver. **Inside a container, `127.0.0.1` is the container itself.** On
a Compose network, use the service names — `MYSQL_HOST=mysql`, `SOAP_URL=http://worldserver:7878/` —
and make sure the bot is on the same network as both. If MySQL or the worldserver is on the host
rather than in a container, `host.docker.internal` reaches it on Docker Desktop; on Linux you need
`--add-host=host.docker.internal:host-gateway` or host networking.

The archive directory must be a volume. It holds attachments that are supposed to outlive the
container, and it must not be inside a web root.

Keep SOAP and MySQL bound to loopback or to the internal network. Do not publish either port.

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
3. Invite the application to the new guild and create the three staff roles there. Do not create a
   role for the bot; Discord makes one when you invite it.
4. Update `DISCORD_GUILD_ID` and the three role ids in `.env`, and blank any pinned channel or
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
3. Admin, Moderator, and Game Master can see an unclaimed ticket. A player can
   see only their own Discord ticket.
4. Add a staff mapping with `/ticket staff-add`. Confirm that an eligible role
   without a mapping cannot claim or reply.
5. Claim a ticket. Confirm only the claimant, Admin, bot, and creator can see it.
6. Add a normal message and attachment. Confirm it is archived privately and is
   not publicly reachable.
7. Close, reopen, and reassign a ticket. Confirm the configured closed-channel
   deletion window works.
8. On a development realm only, test the full in-game flow: whisper the GM
   identity from a player character and confirm the message reaches the ticket
   channel, then reply from Discord and confirm it arrives in game.
