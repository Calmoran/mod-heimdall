# Module installation

1. Start from a supported AzerothCore source tree and put this repository in its `modules/` folder
   as `modules/mod-heimdall`. One clone brings both halves: the module the build compiles, and the
   Discord bot in `bot/`, which the build ignores. Cloning straight into `modules/` works; linking
   it in from its own directory is better, and is described under "Keeping the repository outside
   the core tree" below.
2. **On stock AzerothCore, apply the core patch first.** From the root of your core checkout:

   ```
   git apply modules/mod-heimdall/patches/0001-expose-loginqueryholder-to-modules.patch
   ```

   It moves a class declaration into a header so the module can build the same login query the
   core's own login path builds. Fifteen lines, no behaviour change. Cores based on mod-playerbots
   already carry the equivalent and must skip this step - the patch will refuse to apply, which is
   the correct outcome. See [patches/README.md](../patches/README.md).
3. Reconfigure and rebuild AzerothCore so its module loader includes `mod-heimdall`. Modules are controlled by the `MODULES` CMake variable, which must not be `none`:

   ```
   cmake -S <source> -B <build> -DMODULES=static
   ```

   Confirm it worked before building: the configure output should list `mod-heimdall`, and the generated `modules/gen_scriptloader/static/ModulesLoader.cpp` in your build tree should call `Addmod_heimdallScripts()`. A module the build does not discover produces no error at all - it simply is not there.
4. Apply `data/sql/db_characters/base/heimdall.sql` to the Characters database during a maintenance window. Back up that database first. The connection details are in your `worldserver.conf` under `CharacterDatabaseInfo`:

   ```
   mysql -h <host> -P <port> -u <user> -p <characters_database> < data/sql/db_characters/base/heimdall.sql
   ```

   It creates seven tables named `heimdall_*` and touches nothing else. Running it twice is safe.
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
   2. Log in with the game client and create the character your GM identity will use. An ordinary
      character; the module supplies GM mode at login.
   3. Set `Heimdall.GmIdentities = "ThatName"` in `heimdall.conf`.
   4. **Restart the worldserver** — the list is read once at startup.
   5. Check the startup line in the module log. Healthy is `1 GM identity(ies)` (or however many
      you named); `0 GM identity(ies)` plus a warning means the name did not resolve.

   The identity's whispers carry the client's `<GM>` chat badge, governed by `Heimdall.GmChatTag`
   (default on). The badge is rendered from a protocol flag a player character cannot forge, so a
   player can both notice a staff reply and trust who sent it; turn it off only for an in-character
   support desk.
7. Install the bot from this same clone's `bot/` directory, following
   [INSTALL-bot.md](INSTALL-bot.md). Give its MySQL account privileges only on tables named
   `heimdall_%`. There is no second repository: the two halves version together and a single
   `git pull` updates both.

The module only reads `gm_ticket`. All in-game lifecycle changes must use documented AzerothCore GM commands over the existing loopback SOAP service; never grant the bot write access to `gm_ticket`.

Set `Heimdall.ArchiveRetentionDays` to the same value as the companion
bot's `TRANSCRIPT_RETENTION_DAYS` so an in-game ticket that the player closes in
the game receives the same retention treatment.

Rollback: set `Heimdall.Enabled = 0`, stop the companion bot, and restart the worldserver during maintenance. Keep the module tables for audit and rollback unless the operator explicitly decides to remove them after a backup.

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

### Whispers are refused with "is not a configured GM identity"

`Heimdall.GmIdentities` is empty, which is the shipped default. Set it to a character that exists on
the realm and restart the worldserver. The startup log says so explicitly, and `/ticket staff-add`
refuses a name the realm has not accepted rather than letting it fail later, mid-conversation.

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

**Linux — untested.** Nothing in this module is Windows-specific and it should build with the rest of
the core, but no one has done it. Please report what was wrong.

**Docker — untested.** The module is compiled into the worldserver, so it goes in at image build
time: add the source under `modules/` and apply the core patch before the build step, then rebuild
the image. Adding the module
to a running container does nothing — a module cannot be loaded without rebuilding the worldserver
binary.

## Rebuilding after an update

**On stock AzerothCore, a core update can revert the patch.** Reapply it before rebuilding. You will
know if you forget: the module fails to compile with `use of undefined type 'LoginQueryHolder'`. It
cannot silently half-work.

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
