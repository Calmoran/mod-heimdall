# Install troubleshooting

Organised by what you saw, not by which step you were on. The install guides are
[INSTALL.md](INSTALL.md) (module) and [INSTALL-bot.md](INSTALL-bot.md) (bot).

## Build and patch

### The core patch will not apply

Two different situations produce the same error, and only one is safe to skip. Test which:

```bash
git apply --reverse --check modules/mod-heimdall/patches/0001-expose-loginqueryholder-to-modules.patch \
  && echo "ALREADY APPLIED"
```

If it prints `ALREADY APPLIED`, skip the step. If it prints nothing, the patch does not fit your
core version — do not force it. Confirm what is actually in the header:

```bash
grep -n LoginQueryHolder src/server/game/Server/WorldSession.h
```

A patched header declares `class LoginQueryHolder : public CharacterDatabaseQueryHolder`; stock
AzerothCore only forward-declares it. **A core update can revert the patch**; reapply it before
rebuilding. Forgetting shows up as a compile failure — `use of undefined type 'LoginQueryHolder'` —
never as odd behaviour.

### The build succeeds but Heimdall is not there

A module the build does not discover produces no error. Check that
`modules/gen_scriptloader/static/ModulesLoader.cpp` in your build tree calls
`Addmod_heimdallScripts()`, and that `MODULES` is not `none`.

If you copied the repository into `modules/` rather than linking it, copy it again after every
source change — a copy does not track the original, so the build recompiles the old code and
succeeds, which looks exactly like a change that did not work.

### Windows builds

- Build from **PowerShell or `cmd`, not Git Bash**. A POSIX shell rewrites the `/p:` switch and
  MSBuild rejects it with `MSB1008: Only one project can be specified`.
- An unrestricted parallel build can exhaust the paging file and fail with `C3859` and system error
  `1455`. Limit it: `--parallel 2 -- /p:CL_MPCount=2`.
- CMake does not copy the runtime DLLs beside the executables. Copy `libmysql.dll`,
  `libcrypto-*.dll`, `libssl-*.dll` and `legacy.dll` from your MySQL and OpenSSL directories.
  Upstream documentation still names the OpenSSL 3 filenames while recent builds link OpenSSL 4.
- The CMake option is `TOOLS_BUILD`, not `BUILD_TOOLS`.
- `CONF_DIR` may not end up where the configure summary says. Find `worldserver.conf.dist` on disk
  and put `heimdall.conf` beside it — that is the rule that matters.

## Configuration

### A setting you changed has no effect

You almost certainly edited a `.dist`. The worldserver reads `heimdall.conf`; every `*.conf.dist`
is a template the build rewrites on each compile, and a build tree holds several copies (including
under `build/bin/Release/` and `build/bin/RelWithDebInfo/`). Editing any of them changes nothing,
silently.

The startup line states what was actually resolved — read it rather than trusting the file:

```
Resolved configuration: command audit disabled, GM chat tag on, ticket poll 15s, ...
```

### `Config::LoadFile: Failure to read line number 1`

The file has a UTF-8 BOM. Notepad adds one by default. Save it as plain UTF-8 without a BOM.

### After an upgrade, an option you set is at its default

Your `heimdall.conf` is never overwritten, so a release that adds an option leaves your file
without it and the new option runs at its shipped default. Diff your file against the new
`.dist` after every upgrade.

## Database and grants

### Access denied that looks like a wrong password

`localhost` and `127.0.0.1` are **different accounts** in MySQL: `localhost` matches a socket
connection, `127.0.0.1` matches TCP. The bot connects over TCP. `bot/deploy/mysql-grants.sql`
creates both on purpose; granting only one produces an access-denied error indistinguishable from a
bad password.

### `ERROR 1819: Your password does not satisfy the current policy requirements`

MySQL's default policy needs at least eight characters with an upper-case letter, a lower-case
letter, a digit **and a symbol**. The error never mentions which rule you broke.

### `mysql -u root -p` fails on Ubuntu

Stock Ubuntu MySQL uses socket authentication for root. Use `sudo mysql` instead.

### The module logs that the database does not exist

```
Database `heimdall` does not exist, or the core's MySQL user has no rights on it
```

Run `deploy/create-heimdall-database.sql`, editing the account name in it to match the user in your
`CharacterDatabaseInfo`. The realm starts normally without Heimdall in the meantime.

### Proving the bot cannot command your realm

The bot writes an action and its arguments as separate fields; the module composes the command
inside the worldserver from a fixed list. Nothing the bot writes is executed as text:

```sql
SELECT kind, payload_json FROM heimdall_delivery
 WHERE kind IN ('assign_ticket','close_ticket','gm_action','identity_login','identity_logout')
 ORDER BY id DESC LIMIT 5;
```

Every row is fields. No row contains a command. The account's only grant is Heimdall's own
database — `SELECT` against a realm table fails with `ERROR 1142`.

## The bot will not start

### `Missing required environment values: ...`

It names them. An untouched `replace_with_...` placeholder counts as missing. If *every* value is
reported missing, the environment file was never opened: `HEIMDALL_ENV_FILE` names it, and with the
variable unset the bot falls back to the `.env` beside itself (`bot/.env`).

### `Used disallowed intents`

One of the three gateway intents is off in the Developer Portal. Message Content is the privileged
one.

### `Another ticket bot instance is already running`

The instance lock is per database and lasts 60 seconds. A clean stop releases it immediately; a
force-kill leaves it held until it goes stale. If the line repeats endlessly, the bot is
crash-looping under a restart policy and **the real error is the oldest distinct line, not the
last**:

```bash
docker compose logs heimdall-bot | grep -v 'already running' | head -30
journalctl -u heimdall-bot | grep -v 'already running' | head -30
```

### It runs by hand but fails under systemd

The unit in [INSTALL-bot.md](INSTALL-bot.md#5-keep-it-running) matches the documented layout. If you
adapted an older unit that sets `ProtectHome=true`, a bot living under `/home` is unreadable to the
service. Either move it to `/opt` or drop that directive deliberately.

### Transcripts arrive with no words in them

The Message Content intent is off. Messages arrive with authors, timestamps and attachments and no
text. Nothing errors.

## Discord permissions and channels

### `Missing Access` on channels the bot created

Almost always an old `DISCORD_BOT_ROLE_ID` naming a role someone created by hand. A bot cannot be
added to a role — Discord creates one managed role per application, and that is the only role a bot
is ever in. The channel overwrites then grant access to a role the bot is not in, and it locks
itself out of channels it cannot repair, because Discord does not let you manage a channel you
cannot view.

Current versions refuse to start in this state and name the correct id. Correcting `.env` alone is
not enough — the overwrites already exist:

1. Stop the bot.
2. Delete the categories and channels Heimdall created (Open, Claimed, Closed, the support
   category, `open-a-ticket`, `ticket-queue`).
3. Remove `DISCORD_BOT_ROLE_ID` from `.env` entirely.
4. Start the bot once; it recreates everything with the correct role and prints the new ids.

If you pinned any channel id in `.env`, blank it first — a configured id is never self-healed, by
design.

### The bot cannot see channels after the application was deleted and recreated

Deleting an application deletes its managed role, and every overwrite naming that role is orphaned.
The new application is in none of them and cannot repair them. Delete the categories and channels
Heimdall created and let it rebuild on the next start. Stored ids self-heal; **pinned ids do not**.
Open tickets get their channels back on the next poll; closed ones keep their transcripts in the
database and the archive rather than in Discord.

### The startup preflight stops with a missing permission

It names the permission and the place. The bot checks all seven places — the server, four
categories, the panel and the queue board — and refuses to run half-working. Check for a channel
overwrite denying what the server-level role grants; a channel-level deny beats a server-level
allow.

## In-game tickets and the GM identity

### Claiming a ticket fails with `Invalid name specified`

```
Invalid name specified. Name should be that of an online Gamemaster.
```

The message misleads twice: the name is almost certainly right, and the character does not need to
be online. `.ticket assign` checks the **account** behind that character, reading `account_access`,
and refuses anything below gmlevel 1. Whispering needs no level, which is why the rest of the
install looks healthy.

The name checked is the GM name the claiming staff member is rostered under (`/ticket staff-add`).
Fix it from the worldserver console — nothing needs restarting:

```
account set gmlevel <account name> 1 -1
```

The queued job retries with backoff for about 81 minutes, so a prompt fix needs no second Claim. If
it already dead-lettered, only the core's `assignedTo` stays empty; the ticket is claimed in
Heimdall and replies and closure work normally.

### `is not a configured GM identity`

`Heimdall.GmIdentities` is empty, which is the shipped default. Name a character that already
exists on the realm and restart the worldserver — the list is read once at startup.

### The identity will not hold: `Account N is connected right now`

The module refuses to log an identity in while its account has a live session, so a misconfigured
identity can never kick somebody off their own character. Give the identity an account nobody plays
on.

### A character cannot log in to the test realm

`realmlist.wtf` takes the **auth server's** address and port, not the world server's. Pointing a
client at the world port produces a login that hangs.

## Docker

The module is compiled into the worldserver, so it goes in at image build time: clone it under
`modules/` and apply the core patch **before** `docker compose up -d --build`. Adding the module to
a running container does nothing.

- **The database port collides.** The shipped compose publishes MySQL on host port 3306. Set
  `DOCKER_DB_EXTERNAL_PORT=127.0.0.1:64306` in the `.env` beside `docker-compose.yml`. Nothing
  inside the network uses it; services reach each other by name.
- **Nothing creates `heimdall.conf`.** The entrypoint creates `.conf` from `.dist` for the core's
  own configs but not for modules, so every `Heimdall.*` setting reads as missing until you copy it
  yourself in the bind-mounted directory:
  `cp env/dist/etc/modules/heimdall.conf.dist env/dist/etc/modules/heimdall.conf`, then restart the
  worldserver.
- **The database and the bot account are created once**, by `deploy/docker/heimdall-init.sh`, which
  the bot's compose fragment mounts into the MySQL container. It runs only on the **first** start
  with an empty data volume, taking the password from `HEIMDALL_BOT_DB_PASSWORD` in the compose
  `.env`. Against an existing volume it never runs: create the database and account by hand with
  `deploy/create-heimdall-database.sql` and `bot/deploy/mysql-grants.sql`, changing the account host
  from `localhost`/`127.0.0.1` to `%`, because a bot in another container connects from the Compose
  network's address range.
- **Addresses are service names.** `MYSQL_HOST=ac-database`, `MYSQL_PORT=3306`. `127.0.0.1` in a
  container is the container itself. If MySQL runs on the host, `host.docker.internal` reaches it on
  Docker Desktop; on Linux that needs `--add-host=host.docker.internal:host-gateway`.
- **A crash loop hides its own cause** — see
  [`Another ticket bot instance is already running`](#another-ticket-bot-instance-is-already-running).

## Anything else

`AzerothCore` itself, not Heimdall: `server shutdown 0` is rejected — the current syntax takes a
duration, `server shutdown 1s 0`.

Ticket lifecycle, retention, staff permissions and day-to-day questions are in
[OPERATIONS.md](OPERATIONS.md). Configuration reference: [CONFIGURATION.md](CONFIGURATION.md).
