# Heimdall for TrinityCore

Heimdall bridges in-game GM tickets into private Discord channels. This directory is the
TrinityCore half of the same repository — the AzerothCore module in `src/` at the repository root
is the reference implementation, and the two release together under one version.

## Status: phase 1 of several. This is a skeleton.

**It builds into a worldserver, reads one setting, and writes one line at startup. That is all it
does.** No tickets are polled, no commands are executed, no GM identity is held, nothing is sent
to Discord, and the companion bot is not involved. Ticket polling, the delivery queue, command
execution and the GM identity arrive in later phases.

It is published now so the packaging, the patches and the build steps can be checked by someone
other than their author.

## The core it is built against

**`ElunaLuaEngine/ElunaTrinityWotlk`, commit `bb74941e685a1e84425668b72afc3cc477fde854`**
(2026-08-31, "Merge TrinityCore 3.3.5 to ElunaTrinityWotlk"), built on Windows with Visual Studio
2022, `RelWithDebInfo`, `SCRIPTS=static`.

Stock upstream, no accommodations for any particular server. A core modified beyond what upstream
ships may need more than this; that part is yours.

## Installing it

The core has no module system, so Heimdall's source is copied into your core tree and compiled
into the worldserver. Five steps.

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

so that you end up with `src/server/scripts/Custom/heimdall/heimdall.cpp` and
`heimdall_shared.h`. The core's CMake collects `Custom/` recursively, so no CMake file needs
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

`Heimdall.Enabled` defaults to `0`.

## Confirming it works

Start the worldserver and look in the console or `Server.log` for:

```
Heimdall 2.0.0 for TrinityCore: the bridge is DISABLED. Set Heimdall.Enabled = 1 in heimdall.conf to turn it on.
```

If you see no Heimdall line at all, the most likely cause is that `heimdall.conf` was not
installed: the `Logger.heimdall` line that makes Heimdall's output visible lives in it, because
this core's stock `root` logger is at level 5 (error) and an unconfigured category inherits from
it. A missing config file also makes the core warn that `Heimdall.Enabled` is missing, which is
the other thing to look for.

With `Heimdall.Enabled = 1` the line instead says the bridge is enabled and that this build is the
phase 1 skeleton — because at this phase, enabling it still does nothing.

## Licence

AGPL-3.0, the same as the rest of the repository. See `LICENSE` at the repository root.
