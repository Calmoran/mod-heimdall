# Heimdall for TrinityCore

Heimdall bridges in-game GM tickets into private Discord channels. This directory is the
TrinityCore half of the same repository — the AzerothCore module in `src/` at the repository root
is the reference implementation, and the two release together under one version.

## Status: feature-complete except the command audit, with one unproven gate

**What works:** Heimdall creates its own tables, reads `gm_ticket` on a timer and mirrors every
ticket into its own records, performs the commands staff press in Discord — Claim, Close, Revive,
Teleport, Kick, Unstuck — through the core's own command handlers, and carries the conversation
both ways: a GM's reply reaches the player as an ordinary whisper carrying the `<GM>` badge, and
the player's answer reaches the ticket channel.

**What is not here:** the GM command audit, which records who asked for each command. Doing that
faithfully needs a pre-command hook this core does not have, and a partial audit is worse than
none — see the end of `conf/heimdall.conf.dist`.

**What is not yet proven — read this before running it on a live realm.** If a player logs in on a
character Heimdall is currently holding as a GM identity, the module stands down and hands the
character back (`heimdall_login_watch` in `src/heimdall.cpp`). The design is sound and it runs
earlier than the AzerothCore equivalent, but it has **not** been observed with a real game client,
because the development realm has none. Until it has, treat a GM identity as a character nobody
logs into.

`gm_ticket` is read-only to this module and always will be: every change to a ticket is made by
the core's own `.ticket` handlers, never by SQL.

### One place this core is thinner than AzerothCore

Before Heimdall logs a GM identity in, it refuses if anyone is connected on that account or if the
character is already in the world. On AzerothCore it can also ask the core about a session that has
been closed but whose character has not finished leaving; **TrinityCore keeps no such record**, so
that question cannot be asked here.

In practice: if a real player disconnects from a GM identity's character and an identity login is
requested in the same few seconds, Heimdall may not see that the character is still on its way out
of the world. Nothing else in normal operation reaches that window — an identity is logged in
deliberately, by a GM or at startup, not automatically on a timer. If it matters to you, wait a few
seconds after disconnecting a GM identity's character before holding it.

## The core it is built against

**`ElunaLuaEngine/ElunaTrinityWotlk`, commit `bb74941e685a1e84425668b72afc3cc477fde854`**
(2026-08-31, "Merge TrinityCore 3.3.5 to ElunaTrinityWotlk"), built on Windows with Visual Studio
2022, `RelWithDebInfo`, `SCRIPTS=static`.

Stock upstream, no accommodations for any particular server. A core modified beyond what upstream
ships may need more than this; that part is yours.

## Installing it

The core has no module system, so Heimdall's source is copied into your core tree and compiled
into the worldserver. Seven steps.

### 1. Get the repository

Clone it anywhere outside your core tree:

```
git clone https://github.com/Calmoran/mod-heimdall.git
```

### 2. Apply the two core patches

They are small and they are explained in [`patches/README.md`](patches/README.md). From the root
of your TrinityCore checkout:

```
git apply /path/to/mod-heimdall/trinitycore/patches/0001-expose-loginqueryholder-to-modules.patch
git apply /path/to/mod-heimdall/trinitycore/patches/0002-guard-socketless-session-in-worldsession-update.patch
git diff --stat
```

Three files should be changed.

### 3. Copy the source in

Copy the **contents** of `trinitycore/src/` into a new directory in your core tree:

```
src/server/scripts/Custom/heimdall/
```

so that you end up with all six files under `src/server/scripts/Custom/heimdall/`. Three of them
are named `mod_heimdall_*` while the rest are named `heimdall_*`, which looks like an oversight and
is not: those three are byte-identical copies of the AzerothCore module's own headers, shared
rather than retyped so the schema and the command switch cannot drift between the two cores. A test
in this repository fails if a copy falls behind, and the copy keeps the original's name because
that is what "byte-identical" means. Do not edit them here.

The core's CMake collects `Custom/` recursively, so no CMake file needs
editing — but the collection happens when CMake *configures*, not when it builds, so a new file
is only picked up after step 5's configure step.

Copy, rather than symlink or junction: a link means a `git pull` in either tree can change the
other one under you, and that is a hard thing to diagnose later.

### 4. Register it — the one file of your own core you edit

`src/server/scripts/Custom/custom_script_loader.cpp` is stock two lines. Add the two marked lines
so it reads exactly:

```cpp
// This is where scripts' loading functions should be declared:
void AddSC_heimdall();                       // <-- add this line

// The name of this function should match:
// void Add${NameOfDirectory}Scripts()
void AddCustomScripts()
{
    AddSC_heimdall();                        // <-- and this one
}
```

If you already have custom scripts, add the two lines alongside your existing ones; the order does
not matter.

### 5. Configure, build, install

From your build directory — the configure step is what makes CMake notice the new source files:

```
cmake -S /path/to/TrinityCore -B /path/to/build
cmake --build /path/to/build --config RelWithDebInfo --target install
```

Both patches touch `WorldSession.h`, which most of the core includes, so expect close to a full
rebuild.

**On Windows, `install` copies `worldserver.exe` but not its `.pdb`.** If you keep debug symbols
next to the binary, copy `build/bin/RelWithDebInfo/worldserver.pdb` yourself after every install —
a stale PDB beside a fresh executable produces wrong symbols in a crash dump, which is worse than
having none.

### 6. Configure the settings

Create a `worldserver.conf.d` directory next to your `worldserver.conf`, and copy
[`conf/heimdall.conf.dist`](conf/heimdall.conf.dist) into it as `heimdall.conf`:

```
<server>/worldserver.conf.d/heimdall.conf
```

Worldserver reads every `.conf` file in that directory at startup, so `worldserver.conf` itself is
left alone. Two things to know about how this core reads those files:

- keep the single `[worldserver]` section header — only the **first** section of an additional
  file is read, and a second one is silently ignored;
- a malformed or empty file **stops worldserver from starting**, and the reason is printed before
  the log opens ("Error in additional config files");
- save it as plain UTF-8 **without a byte order mark**. Several Windows editors add one silently,
  and the realm then refuses to start with `'=' character not found in line
  (...heimdall.conf:1)` — a real trap, hit while writing this guide.

`Heimdall.Enabled` defaults to `0`. Set it to `1`, and set `Heimdall.RealmPrefix` once — it keys
every ticket this realm ever bridges and must not change afterwards.

### 7. Create the database — the one piece of manual SQL

Heimdall's tables live in a database of their own, so that the companion bot's MySQL account can be
granted that database and nothing else. The module creates the tables itself at startup, but it
cannot create the database or grant itself rights on it. Run this once, as a MySQL administrator,
replacing the account with the one your worldserver connects with (the user in
`CharacterDatabaseInfo`, with the host MySQL sees it from — over TCP to 127.0.0.1 that is the
`'127.0.0.1'` account, not `'localhost'`):

```sql
CREATE DATABASE IF NOT EXISTS `heimdall` DEFAULT CHARACTER SET utf8mb4;
GRANT ALL PRIVILEGES ON `heimdall`.* TO 'trinity'@'127.0.0.1';
FLUSH PRIVILEGES;
```

`deploy/create-heimdall-database.sql` at the repository root is the same script with AzerothCore's
account name in it. If the database is missing or ungranted, Heimdall says so at startup and
disables itself rather than creating tables somewhere else.

## Confirming it works

Start the worldserver and look in the console or `Server.log`. With the bridge off you get one
line:

```
Heimdall 2.0.0 for TrinityCore: the bridge is DISABLED. Set Heimdall.Enabled = 1 in heimdall.conf to turn it on.
```

With `Heimdall.Enabled = 1` you should see the schema line, the enabled line and the resolved
configuration:

```
Heimdall schema ready in `heimdall`: 7 tables, schema version 1 (created on this start).
Heimdall 2.0.0 enabled for realm tag "TRIN"; gm_ticket polling is read-only. First run: seeded a new watermark with import mode "open".
Resolved configuration: ticket poll 15s, delivery poll 1s, archive retention 180 day(s), command audit unavailable on this core. ...
```

If you see no Heimdall line at all, the most likely cause is that `heimdall.conf` was not
installed: the `Logger.heimdall` line that makes Heimdall's output visible lives in it, because
this core's stock `root` logger is at level 5 (error) and an unconfigured category inherits from
it. A missing config file also makes the core warn that `Heimdall.Enabled` is missing, which is
the other thing to look for.

## Licence

AGPL-3.0, the same as the rest of the repository. See `LICENSE` at the repository root.
