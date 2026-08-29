# Quick-start installer guide

This guide is written for a separate development Discord server and a test
realm. Do not start on a public realm.

## 1. Install the module first

Follow the module installation guide. Confirm its SQL tables exist in the
Characters database. Keep the bot account limited to those tables using
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
channel, or the queue board channel. The bot checks all six places at startup and names anything
missing.

Create or retain these guild roles: Admin, Moderator, Game Master, and Bot.
Create an `#open-a-ticket` panel channel, an Open Tickets category, and a
Claimed Tickets category. Copy their IDs and the role IDs into the environment
file. Place the Bot role above roles whose channel permissions it must manage.

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

> **Only Windows has been run.** Everything in this section for Linux and Docker is written from the
> code and from the platform's normal conventions, and has never been executed. Treat it as a
> starting point, and please report what was wrong.

### Windows — tested

`run-bot.cmd` sets `HEIMDALL_ENV_FILE` to the `.env` beside it and starts the bot. Run it from a
terminal first and watch the startup lines; once it is behaving, wrap it with NSSM or Task Scheduler
so it survives a reboot. `deploy/heimdall-bot.service` is a Linux unit and does not apply.

### Linux — untested

Copy `deploy/heimdall-bot.service` to your system service directory, review every path in it, then
enable and start it the way your distribution expects. The unit sets `HEIMDALL_ENV_FILE`, runs as a
dedicated unprivileged account, and restricts writes to the archive directory.

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
2. Stop the bot.
3. Update both trees.
4. Apply any module SQL the release names, in order.
5. **Rebuild the worldserver if the module changed** — anything touching `modules/mod-heimdall/src`
   or its `.conf.dist`. A release that only changes the bot does not need a rebuild; a release that
   changes the module does, and the module will not behave as documented until you do. Release notes
   say which.
6. Compare your `heimdall.conf` against the new `heimdall.conf.dist` and add any new options. The
   worldserver warns about missing ones at startup and falls back to compiled defaults.
7. Compare your `.env` against `.env.example` the same way.
8. Start the worldserver, then the bot, and read both logs. The bot's permissions preflight runs at
   startup and names anything missing.
9. Smoke test one Discord ticket and one in-game ticket.

Rolling back: stop the bot, restore the previous code and configuration, and rebuild the worldserver
if the module changed. Restore the table backup only if a migration cannot be carried forward. Do
not edit `gm_ticket` to force a rollback.

## 9. Fresh-install verification

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
