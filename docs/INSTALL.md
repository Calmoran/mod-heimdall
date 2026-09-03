# Module installation

1. Start from a supported AzerothCore source tree and put this repository in its `modules/` folder
   as `modules/mod-heimdall`. One clone brings both halves: the module the build compiles, and the
   Discord bot in `bot/`, which the build ignores. Cloning straight into `modules/` works; linking
   it in from its own directory is better, and is described under "Keeping the repository outside
   the core tree" below.
2. **Apply the core patch first.** From the root of your core checkout:

   ```
   git apply modules/mod-heimdall/patches/0001-expose-loginqueryholder-to-modules.patch
   ```

   It moves a class declaration into a header so the module can build the same login query the
   core's own login path builds. Fifteen lines, no behaviour change. If the patch refuses to
   apply, your core already contains the change; skip the step - do not force it. See
   [patches/README.md](../patches/README.md).
3. Reconfigure and rebuild AzerothCore so its module loader includes `mod-heimdall`. Modules are controlled by the `MODULES` CMake variable, which must not be `none`:

   ```
   cmake -S <source> -B <build> -DMODULES=static
   ```

   Confirm it worked before building: the configure output should list `mod-heimdall`, and the generated `modules/gen_scriptloader/static/ModulesLoader.cpp` in your build tree should call `Addmod_heimdallScripts()`. A module the build does not discover produces no error at all - it simply is not there.
4. Create Heimdall's database. The module keeps its seven tables in a database of their own, on
   the same MySQL server as the realm, named by `Heimdall.Database` in `heimdall.conf` (default
   `heimdall`). It has to exist, and the core's own MySQL user needs full rights on it, before the
   worldserver starts. `deploy/create-heimdall-database.sql` does both: replace the placeholders
   and run it as a MySQL administrator.

   ```
   mysql -h <host> -P <port> -u root -p < deploy/create-heimdall-database.sql
   ```

   The tables install themselves. On startup the module checks that the database is there and
   creates whatever is missing from `deploy/heimdall-schema.sql` - the same file, compiled into the
   binary - then records its schema version in `heimdall_setting`. It creates seven tables named
   `heimdall_*` and touches nothing else; starting into an existing install is safe. AzerothCore's
   updater is not involved, so the `Updates.*` settings do not matter here, and the file can be
   read, or applied by hand, without any of that.

   If the database is missing or the core's user cannot see it, the module logs
   `Database `heimdall` does not exist, or the core's MySQL user has no rights on it` and disables
   itself; the realm starts normally without it. Coming from 1.x, where the tables lived in the
   characters database, read "Upgrading from 1.x" below before starting the new worldserver.

5. Copy `conf/heimdall.conf.dist` to the server's module configuration directory as `heimdall.conf`.

   **Then edit `heimdall.conf`, and only `heimdall.conf`.** The one file the worldserver reads is
   `server/configs/modules/heimdall.conf`. Every file named `*.conf.dist` is a template: the build
   rewrites them on each compile, and while your `.conf` exists none of them is read at all. A
   build tree contains several — including copies under `build/bin/Release/` and
   `build/bin/RelWithDebInfo/` — and editing any of them changes nothing, silently. If a setting
   you are certain you changed has no effect, check which file you changed.
6. Leave `Heimdall.Enabled = 0` while validating SQL and configuration loading. Enable only after the bot and the development-realm checks are ready.

   **The GM identity comes after the realm is running, not before.** `Heimdall.GmIdentities` must
   name a character that already exists on the realm — the module validates the list at startup and
   skips names it cannot resolve. But creating a character needs a running realm, which is later
   than this config step. Following this file top to bottom and filling in `GmIdentities` now
   produces a working install with no whisper capability and a warning you have not seen yet. The
   order that works:

   1. Build, install, and start the worldserver with `GmIdentities` still empty.
   2. **Create a game account for the identity, one nobody plays on.** The module holds the
      identity by logging its character into the world with no client attached, and it refuses to
      do that while that account has a live session: `Account N is connected right now - refusing
      to touch it.` The refusal is deliberate — a misconfigured identity must never kick somebody
      off their own character — but it means an identity sharing your own account stops working the
      moment you log in to play.

      **Give that account gmlevel 1**, from the worldserver console:

      ```
      account set gmlevel <account name> 1 -1
      ```

      Whispering does not need it. The module gives game-master rights to the session it creates, so
      an identity on a plain account holds, whispers, and hears the player answer back — which is
      exactly why a missing level hides until the first **Claim**. Claiming an in-game ticket runs
      `.ticket assign <ticket> <GM name>`, and the core refuses to assign a ticket to a character
      whose *account* is below gmlevel 1: it reads the stored level out of `account_access` and never
      looks at the session. The name it checks is the one the claiming staff member is rostered under
      (`/ticket staff-add`), which on most installs is this same character — so this is the account
      that gets checked. If you roster staff under their own GM characters, each of those accounts
      needs the level, and this one still needs nothing beyond it.

      `1` is Moderator, not Administrator — the lowest level the check accepts, and nothing here
      uses more. It is still one account fewer with administrator rights on your realm.
   3. Log in with the game client **on that account**, create the character your GM identity will
      use, then log out again. An ordinary character; the module supplies GM mode at login. The
      account has to be free for the module to use it.
   4. Set `Heimdall.GmIdentities = "ThatName"` in `heimdall.conf`.
   5. **Restart the worldserver** — the list is read once at startup.
   6. Check the startup line in the module log. Healthy is `1 GM identity(ies)` (or however many
      you named); `0 GM identity(ies)` plus a warning means the name did not resolve.

   The identity's whispers carry the client's `<GM>` chat badge, governed by `Heimdall.GmChatTag`
   (default on). The badge is rendered from a protocol flag a player character cannot forge, so a
   player can both notice a staff reply and trust who sent it; turn it off only for an in-character
   support desk.
7. Install the bot from this same clone's `bot/` directory, following
   [INSTALL-bot.md](INSTALL-bot.md). Its MySQL account is granted Heimdall's database and nothing
   else (`bot/deploy/mysql-grants.sql`); it never connects to a realm database. There is no second
   repository: the two halves version together and a single `git pull` updates both.

The module only reads `gm_ticket`. Every in-game lifecycle change goes through documented AzerothCore GM commands, which the module runs itself inside the worldserver from a queued intent row; never grant the bot write access to `gm_ticket`.

Set `Heimdall.ArchiveRetentionDays` to the same value as the companion
bot's `TRANSCRIPT_RETENTION_DAYS` so an in-game ticket that the player closes in
the game receives the same retention treatment.

Rollback: set `Heimdall.Enabled = 0`, stop the companion bot, and restart the worldserver during maintenance. Keep Heimdall's database for audit and rollback unless the operator explicitly decides to remove it after a backup.

## Upgrading from 1.x

2.0.0 moves Heimdall's tables out of the realm's characters database and into a database of their
own. The move is a single `RENAME TABLE`: no rows are copied, ids and foreign keys survive, and it
takes as long as a metadata change takes. In order:

1. Stop the bot and the worldserver. Back up the characters database.
2. Open `deploy/migrate-to-heimdall-db.sql` and replace the placeholders: the characters database
   name, the new database name (the value of `Heimdall.Database`; `heimdall` unless you change
   it), the core's MySQL user, and the bot's accounts. Run it as a MySQL administrator. It creates
   the database, renames the seven tables into it, deletes the `heimdall.sql` row from the
   characters database's `updates` table so the 1.x installer is forgotten, and replaces the
   bot's grants - the per-table 1.x grants on the characters database are revoked and the account
   is given Heimdall's database instead. The check queries at the end of the file should show
   seven tables in the new database, none left in the old one, and `SHOW GRANTS` naming only the
   new one.
3. Install the 2.0.0 worldserver. Add `Heimdall.Database` to `heimdall.conf` only if you chose a
   name other than `heimdall`.
4. Set `MYSQL_DATABASE` in the bot's `.env` to the new database name.
5. Start the worldserver, then the bot. `Heimdall.log` should say
   `Heimdall schema ready in `heimdall`: 7 tables, schema version 1 (already present)`.

The order matters in one place. A 2.0.0 worldserver started before the migration finds the tables
still in the characters database and none in the new one, logs `This is a Heimdall 1.x install
that has not been migrated`, and disables itself rather than create a second, empty set beside the
real one. Nothing is changed; run the migration and start it again.

Undo: `deploy/rollback-to-characters-db.sql` renames the tables back and restores the 1.x grants,
for a return to a 1.x module. It does not restore the `updates` row - a 1.x worldserver that misses
it re-applies its `heimdall.sql`, which is `CREATE TABLE IF NOT EXISTS` over tables that exist, and
records it again.

## Keeping the repository outside the core tree

AzerothCore discovers modules by looking in `modules/` inside its source tree, which means a
checkout there sits inside someone else's repository. That is awkward: the core's `.gitignore`
excludes `modules/*`, so this repository's history lives somewhere the core does not track and every
core update is a chance to lose it. It matters slightly more now that the bot lives here too — the
bot's `.env` and archive directory sit inside the core checkout, which is why this repository's
`.gitignore` covers them.

Keeping the repository in its own directory and linking it in avoids that. On Windows:

```
mklink /J "C:\path\to\azerothcore-wotlk\modules\mod-heimdall" "C:\path\to\mod-heimdall"
```

and on Linux:

```
ln -s /path/to/mod-heimdall /path/to/azerothcore-wotlk/modules/mod-heimdall
```

CMake follows the link, so the module is discovered, compiled and registered exactly as if it were
a real directory. Reconfigure after creating it. Confirm it worked by checking that the generated
`modules/gen_scriptloader/static/ModulesLoader.cpp` in your build tree calls
`Addmod_heimdallScripts()` — a module that is not discovered links cleanly and simply does nothing.

## Where the configuration file goes

`heimdall.conf` must sit in the module configuration directory **beside the worldserver's own
config**, not beside the module source. Find `worldserver.conf` and put it in the `modules`
directory next to it:

- typical Windows install: `...\server\configs\modules\heimdall.conf`
- typical Linux install: `.../etc/modules/heimdall.conf`

On Windows the install rules may not honour the `CONF_DIR` you passed to CMake. Locate
`worldserver.conf.dist` on disk and work from there rather than from what the configure summary
printed.

**Edit `heimdall.conf`, never `heimdall.conf.dist`.** The build copies the `.dist` into that
directory on every single build, so anything you write in it is overwritten the next time you
compile. It is also not the file the worldserver reads once `heimdall.conf` exists, so an edit
there has no effect in the meantime — it fails quietly in both directions. The `.dist` is a
reference copy of the shipped defaults; treat it as read-only and diff against it when upgrading.

Your `heimdall.conf` is yours and the build does not touch it. That means new options added by a
release will not appear in it either: after upgrading, diff it against the fresh `.dist` to see
what is new, and back it up first so you can tell what you changed.

## Troubleshooting

### "Missing Access" on channels the bot created

Symptom: the bot creates its channels, then immediately cannot post to them —
`DiscordAPIError[50001] Missing Access`, `Could not secure category ...`, and the permissions
preflight reporting missing **View Channels** on channels the bot made itself.

Cause: `DISCORD_BOT_ROLE_ID` was set to a role created by hand. A bot cannot be added to a role;
Discord creates one managed role per application, and that is the only role a bot is ever in. The
channel overwrites then grant access to a role the bot is not in, and a server-level permission does
not override a channel-level deny — so the bot locks itself out of channels it cannot then repair,
because Discord does not let you manage a channel you cannot view.

Current versions refuse to start in this state and name the correct id, so this should only affect
installs first provisioned by an older version. Correcting `.env` is **not** enough on its own: the
overwrites already exist and the bot cannot fix them.

Recovery:

1. Stop the bot.
2. In Discord, delete the categories and channels Heimdall created (`Open Tickets`,
   `Claimed Tickets`, `Closed Tickets`, the support category, `open-a-ticket`, `ticket-queue`).
3. Remove `DISCORD_BOT_ROLE_ID` from `.env` entirely, so the bot finds its own managed role.
4. Start the bot once. The stored ids no longer resolve, so it recreates everything with the correct
   role and reports the new ids.

If you pinned any channel id in `.env`, blank it back to the placeholder first — a configured id is
never self-healed, by design, and the bot will refuse to start while it names a channel that no
longer exists.

### The bot cannot see channels after you deleted and recreated its Discord application

Deleting a Discord application orphans every channel it created. A channel's permission overwrites
name the application's *managed role*, and that role is deleted with the application - so a
replacement application is named in none of them. It cannot see those channels, and it cannot repair
them either, because Discord does not let you manage a channel you cannot view. The symptoms are
`Could not secure category ...: Missing Access` and a refusal to start naming the missing **View
Channels**.

The cure is to delete the categories and channels Heimdall created and let the new bot rebuild them
on its next start. The stored ids self-heal - the bot notices each one no longer resolves and creates
a replacement - **provided you have not pinned them in `.env`**, since a pinned id is never
self-healed by design. Open tickets get their channels back on the next poll; closed ones do not, and
their transcripts are in the database and archive rather than in Discord.

### Whispers are refused with "is not a configured GM identity"

`Heimdall.GmIdentities` is empty, which is the shipped default. Set it to a character that exists on
the realm and restart the worldserver. The startup log says so explicitly, and `/ticket staff-add`
refuses a name the realm has not accepted rather than letting it fail later, mid-conversation.

### Claiming a ticket fails with "Invalid name specified"

Symptom: whispers work in both directions, the identity is held, everything looks healthy — and then
**Claim** on an in-game ticket leaves the realm's own copy unassigned. The `assign_ticket` row in
`heimdall_delivery` carries this in `last_error`, and it is the core's message, not Heimdall's:

```
Invalid name specified. Name should be that of an online Gamemaster.
```

It misleads twice. The name is almost certainly right, and the character does not have to be online.
What `.ticket assign` actually checks is the **account** behind that character: it reads the stored
gmlevel from `account_access` and refuses anything below 1. An account with no GM level fails here
and nowhere else, which is why the rest of the install looks fine.

The name being checked is the GM name the claiming staff member is rostered under
(`/ticket staff-add`) — not their Discord account, and not necessarily the GM identity, though on a
small install those are usually the same character. Fix it from the worldserver console:

```
account set gmlevel <account name> 1 -1
```

`1` is Moderator, which is the whole requirement; `-1` means every realm. Nothing needs restarting —
the core reads that level from the database on each assignment.

You do not have to press Claim again if you fix it promptly: the queued job retries on its own, with
backoff, for about 81 minutes, and the next attempt succeeds. If it has already been reported as a
dead letter, nothing else is broken — the ticket is claimed in Heimdall, replies and closure work
normally, and only the core's own `assignedTo` field stays empty for that one ticket.

### A character cannot log in to the test realm

The client's `realmlist.wtf` takes the **auth server's** address and port, not the world server's.
The world port is never typed by a player: it is what the `realmlist` table advertises to a client
that has already authenticated. Pointing a client at the world port produces a login that hangs.

## Platform notes

**Windows — tested.** Build with the Visual Studio generator. Limit parallelism if the build fails
with `C3859` or system error `1455`: `--parallel 2 -- /p:CL_MPCount=2`. Run that from PowerShell or
`cmd`, not from Git Bash - a POSIX shell rewrites the `/p:` switch into something MSBuild rejects
with `MSB1008: Only one project can be specified`. CMake does not copy the MySQL
and OpenSSL runtime DLLs beside the executables; copy them yourself, and note that current upstream
documentation still names the OpenSSL 3 filenames while a recent build links OpenSSL 4.

**Linux — tested.** Built and run end to end on Ubuntu 24.04 with clang and MySQL 8.4, including a
ticket filed in game, claimed in Discord, whispered both ways and closed.

**Docker — tested.** Run against AzerothCore's own `docker-compose.yml` on Docker Desktop. The
module is compiled into the worldserver, so it goes in at image build time: clone it under
`modules/` and apply the core patch *before* `docker compose up -d --build`. The build context
includes `modules/`, so that is all it takes. Adding the module to a running container does nothing
— a module cannot be loaded without rebuilding the worldserver binary.

Heimdall's database is created for you in Docker: the bot's compose fragment mounts
`deploy/docker/heimdall-init.sh` into the MySQL container, which creates the database and the bot's
account on the first start with an empty volume, with the bot's password taken from
`HEIMDALL_BOT_DB_PASSWORD` in the compose `.env`. The core connects as root in the shipped compose
and needs no grant. Details in [INSTALL-bot.md](INSTALL-bot.md#docker--tested).

Two Docker-specific traps are worth knowing before you start, and both are covered there as well:
the shipped compose publishes MySQL on host port
3306, which collides with any MySQL you already have, and the container entrypoint does **not**
create `heimdall.conf` from its `.dist` the way it does for the core's own configs — you copy that
one yourself, in the bind-mounted `env/dist/etc/modules/`.

## Rebuilding after an update

**A core update can revert the patch.** Reapply it before rebuilding. You will know if you
forget: the module fails to compile with `use of undefined type 'LoginQueryHolder'`. It cannot
silently half-work.

Any change under `src/` requires reconfiguring and rebuilding the worldserver. The module is
statically linked; there is no plugin to swap. A release that changes only the companion bot needs no
rebuild.

Before testing a change, confirm the installed `worldserver` binary is newer than the module source.
A stale binary produces results that look like bugs in your configuration.

**If you copied the repository into `modules/` rather than linking it, copy it again after every
source change.** A copy does not track the original, so the build recompiles the old code and succeeds,
which looks exactly like a change that did not work. A directory junction (`mklink /J` on Windows,
a symlink elsewhere) avoids the problem entirely and is transparent to CMake.

Back up `heimdall.conf` before upgrading and diff it against the new `heimdall.conf.dist`
afterwards. The build does not overwrite your file, but it does replace the `.dist` beside it, and a
release that adds an option leaves your file without it — so the new option silently runs at its
shipped default.

The worldserver states the settings it resolved at startup, in `Heimdall.log`:

```
Resolved configuration: command audit disabled, ticket poll 15s, delivery poll 5s, ...
```

Read that line after any upgrade. It is the fastest way to catch a feature you believe is on and
is not — the command audit in particular, because an accountability log that is switched off looks
exactly like one with nothing to report until the day you go looking for evidence.
