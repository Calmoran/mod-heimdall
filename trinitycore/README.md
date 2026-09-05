# Heimdall for TrinityCore

In-game GM tickets become private Discord channels, and a GM's reply reaches the player as an
ordinary whisper. The AzerothCore module in `src/` is the reference implementation; both halves
release together under one version.

## What is verified, and what is not

**Verified** on stock `ElunaLuaEngine/ElunaTrinityWotlk` at `bb74941e`, Windows, Visual Studio
2022, `RelWithDebInfo`, `SCRIPTS=static` — with a real game client, 2026-09-04: GM reply delivered
as a whisper with the `<GM>` badge, player's answer captured, and a real client logging into a held
identity takes the character back cleanly.

**Not verified: Linux and Docker.** Nothing here is Windows-specific; nobody has run it there yet.

**Not included: the GM command audit** — recording who asked for each command needs a pre-command
hook this core does not have, so there is no setting for it.

**Two limits, both true of the AzerothCore module too:**

- Wait a few seconds after a player disconnects from an identity's character before holding it;
  this core cannot see a session that has left the session list while its character is still going.
- `.ban account` and `.kick` do not reach a held identity — it stays in the world and can still
  whisper. Log it out first. Filed for 2.2.

`gm_ticket` is read-only to this module: every ticket change goes through the core's own `.ticket`
handlers, never SQL.

## Installing it

TrinityCore has no module system, so Heimdall's source is compiled into your worldserver.
**Examples use one layout — core source `C:\TrinityCore`, build `C:\TrinityCore\build`, running
realm `C:\TrinityCore\server`, this repository `C:\heimdall`. Adjust if yours differs.**

### 1. Clone this repository at the release tag

```
git clone --branch v2.1.0 https://github.com/Calmoran/mod-heimdall.git C:\heimdall
```

The `trinitycore/` directory exists from `v2.1.0` onwards.

### 2. Apply the two core patches

```
cd C:\TrinityCore
git apply C:\heimdall\trinitycore\patches\0001-expose-loginqueryholder-to-modules.patch
git apply C:\heimdall\trinitycore\patches\0002-guard-socketless-session-in-worldsession-update.patch
git diff --stat
```

Three files change. [`patches/README.md`](patches/README.md) explains both and shows the
non-mutating `--check` form.

### 3. Copy the source in

All six files, into a new directory:

```
mkdir C:\TrinityCore\src\server\scripts\Custom\heimdall
copy C:\heimdall\trinitycore\src\* C:\TrinityCore\src\server\scripts\Custom\heimdall\
```

Copy rather than link, or a `git pull` in either tree changes the other under you. The three
`mod_heimdall_` names are deliberate: those files are byte-identical to the AzerothCore module's.

### 4. Register it — the one file of your own core you edit

Add the two marked lines to `C:\TrinityCore\src\server\scripts\Custom\custom_script_loader.cpp`.
Leave the rest of the file, including its licence notice, alone:

```cpp
// This is where scripts' loading functions should be declared:
void AddSC_heimdall();                       // <-- add this line

void AddCustomScripts()
{
    AddSC_heimdall();                        // <-- and this one
}
```

If you already have custom scripts, add these alongside yours; order does not matter.


### 5. Configure, build, install

Configure first: CMake collects `Custom/` when it configures, not when it builds.

```
cmake -S C:\TrinityCore -B C:\TrinityCore\build
cmake --build C:\TrinityCore\build --config RelWithDebInfo --target install
```

**Confirm Custom scripts are compiled**, or `AddSC_heimdall` never runs and Heimdall prints
nothing:

```
findstr /C:"SCRIPTS:" /C:"SCRIPTS_CUSTOM:" C:\TrinityCore\build\CMakeCache.txt
```

`SCRIPTS` must not be `minimal` or `none`, and `SCRIPTS_CUSTOM` must not be `disabled`. Expect
close to a full rebuild — patch 0001 edits a header most of the core includes.

**`install` copies `worldserver.exe` but not its `.pdb`**, so copy it after every install or a
crash dump gives you wrong symbols:

```
copy C:\TrinityCore\build\bin\RelWithDebInfo\worldserver.pdb C:\TrinityCore\server\
```

### 6. Install the settings file

Worldserver reads every `.conf` in an **additional-config directory**, which is its own
command-line option — `--config-dir` / `-cd`, not derived from wherever `-c` points. On Windows it
defaults to the process working directory, so for a realm started from `C:\TrinityCore\server`:

```
mkdir C:\TrinityCore\server\worldserver.conf.d
copy C:\heimdall\trinitycore\conf\heimdall.conf.dist C:\TrinityCore\server\worldserver.conf.d\heimdall.conf
```

If your launcher passes `-c` with a path elsewhere, pass the directory too:
`worldserver.exe -c C:\Realm\worldserver.conf -cd C:\Realm\worldserver.conf.d`. **A directory that
is not found is accepted silently** — no error, and no Heimdall output to tell you why.

Then edit `heimdall.conf`: set `Heimdall.Enabled = 1`, and set `Heimdall.RealmPrefix` to a short
tag like `ARCA` — it keys every ticket, so **choose it once**; changing it later strands the
tickets filed under the old one. `Heimdall.GmIdentities` is step 8.

Keep the single `[worldserver]` section header, and save as UTF-8 **without a byte order mark**:
several Windows editors add one silently and the realm then refuses to start.

### 7. Create Heimdall's database

Its tables live in a database of their own so the bot's account can be granted that and nothing
else. The module creates the tables; it cannot create the database.

First ask the core which account it authenticates as — not always the one you would guess. Connect
as the worldserver does (host, port and credentials from `CharacterDatabaseInfo`) and run:

```sql
SELECT CURRENT_USER();
```

Then, as a MySQL administrator, granting exactly that account:

```sql
CREATE DATABASE IF NOT EXISTS `heimdall` DEFAULT CHARACTER SET utf8mb4;
GRANT ALL PRIVILEGES ON `heimdall`.* TO 'trinity'@'127.0.0.1';
FLUSH PRIVILEGES;
```

A missing or ungranted database disables the bridge at startup, with the reason.

### 8. Give it a GM identity

Without one, tickets reach Discord but nobody can whisper a player. An identity is an ordinary
character Heimdall logs in headlessly and speaks as.

1. Pick an existing character. Its **account** needs permission to be assigned tickets — security
   level 1 or above has it by default.
2. Put the character's name in `Heimdall.GmIdentities` (comma-separated for more than one) and
   restart the worldserver.
3. Hold it, from the worldserver console: `.heimdall identity login <charactername>`

`.heimdall identity status` shows what is held. If the account is sitting at the character-select
screen the login is refused — log that account out to the login screen, not just the character.

### 9. Confirm it works

Start the worldserver. On a first run with the bridge on you should see:

```
Heimdall schema ready in `heimdall`: 7 tables, schema version 1 (created on this start).
Heimdall 2.1.0 enabled for realm tag "ARCA"; gm_ticket polling is read-only. First run: seeded a new watermark with import mode "open" and 1 GM identity(ies).
Resolved configuration: GM chat tag on, ticket poll 15s, delivery poll 1s, whisper limit 240 bytes, archive retention 180 day(s), command audit unavailable on this core. ...
```

Later starts say `Resuming at watermark …`, and an existing database says `already present`. With
no identity configured you also get a warning saying so — act on it.

**If you see no Heimdall lines at all**, there are two causes and the core tells you which.
Worldserver prints `Loaded additional config file …` for each file it read, before its own log
opens: if yours is not listed, step 6's directory is wrong (and only this case also warns that
`Heimdall.Enabled` is missing). If it *was* listed and there is still no Heimdall output,
`AddSC_heimdall` is not in your binary — recheck step 5's cache values, then step 4's two lines.

### 10. Then set up the bot

The realm half is done. The Discord half is a separate program sharing its guide with the
AzerothCore install: **[`docs/INSTALL-bot.md`](../docs/INSTALL-bot.md)**. Two things differ — the
bot connects to the `heimdall` database from step 7, on this realm's MySQL host and port rather
than wherever an AzerothCore install keeps its own (`MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_DATABASE`),
and the bot's MySQL account goes on that same server (`bot/deploy/mysql-grants.sql`), granted that
database and nothing else. Ignore the guide's AzerothCore module directory; you have just done the
module half here.

## Licence

AGPL-3.0, the same as the rest of the repository. See `LICENSE` at the repository root.
