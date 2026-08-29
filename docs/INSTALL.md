# Module installation

1. Start from a supported AzerothCore source tree and put this directory in its `modules/` folder. Cloning it there works; linking it in from its own directory is better, and is described under "Keeping the module outside the core tree" below.
2. Reconfigure and rebuild AzerothCore so its module loader includes `mod-heimdall`. Modules are controlled by the `MODULES` CMake variable, which must not be `none`:

   ```
   cmake -S <source> -B <build> -DMODULES=static
   ```

   Confirm it worked before building: the configure output should list `mod-heimdall`, and the generated `modules/gen_scriptloader/static/ModulesLoader.cpp` in your build tree should call `Addmod_heimdallScripts()`. A module the build does not discover produces no error at all - it simply is not there.
3. Apply `data/sql/db_characters/base/heimdall.sql` to the Characters database during a maintenance window. Back up that database first. The connection details are in your `worldserver.conf` under `CharacterDatabaseInfo`:

   ```
   mysql -h <host> -P <port> -u <user> -p <characters_database> < data/sql/db_characters/base/heimdall.sql
   ```

   It creates seven tables named `heimdall_*` and touches nothing else. Running it twice is safe.
4. Copy `conf/heimdall.conf.dist` to the server's module configuration directory as `heimdall.conf`.
5. Leave `Heimdall.Enabled = 0` while validating SQL and configuration loading. Enable only after the bot and the development-realm checks are ready.
6. Install the companion bot using its own guide. Give its MySQL account privileges only on tables named `heimdall_%`.

The module only reads `gm_ticket`. All in-game lifecycle changes must use documented AzerothCore GM commands over the existing loopback SOAP service; never grant the bot write access to `gm_ticket`.

Set `Heimdall.ArchiveRetentionDays` to the same value as the companion
bot's `TRANSCRIPT_RETENTION_DAYS` so an in-game ticket that the player closes in
the game receives the same retention treatment.

Rollback: set `Heimdall.Enabled = 0`, stop the companion bot, and restart the worldserver during maintenance. Keep the module tables for audit and rollback unless the operator explicitly decides to remove them after a backup.

## Keeping the module outside the core tree

AzerothCore discovers modules by looking in `modules/` inside its source tree, which means a module
checked out there sits inside someone else's repository. That is awkward: the core's `.gitignore`
excludes `modules/*`, so your module's own history lives somewhere the core does not track and every
core update is a chance to lose it.

Keeping the module in its own directory and linking it in avoids that. On Windows:

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

## Platform notes

**Windows — tested.** Build with the Visual Studio generator. Limit parallelism if the build fails
with `C3859` or system error `1455`: `--parallel 2 -- /p:CL_MPCount=2`. CMake does not copy the MySQL
and OpenSSL runtime DLLs beside the executables; copy them yourself, and note that current upstream
documentation still names the OpenSSL 3 filenames while a recent build links OpenSSL 4.

**Linux — untested.** Nothing in this module is Windows-specific and it should build with the rest of
the core, but no one has done it. Please report what was wrong.

**Docker — untested.** The module is compiled into the worldserver, so it goes in at image build
time: add the source under `modules/` before the build step and rebuild the image. Adding the module
to a running container does nothing — a module cannot be loaded without rebuilding the worldserver
binary.

## Rebuilding after an update

Any change under `src/` requires reconfiguring and rebuilding the worldserver. The module is
statically linked; there is no plugin to swap. A release that changes only the companion bot needs no
rebuild.

Before testing a change, confirm the installed `worldserver` binary is newer than the module source.
A stale binary produces results that look like bugs in your configuration.
