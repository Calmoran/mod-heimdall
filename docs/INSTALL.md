# Install the module

Heimdall is one repository with two halves. This page installs the module into your worldserver;
[INSTALL-bot.md](INSTALL-bot.md) installs the Discord bot from the same clone. Do both.

> Examples assume AzerothCore at `/home/acore/azerothcore-wotlk`, built with `./acore.sh`, running
> as the user `acore`. Adjust the paths if yours differ. Windows differences are marked.
>
> If a step fails, see [INSTALL-troubleshooting.md](INSTALL-troubleshooting.md).

## 1. Clone it into the core's `modules/`

```bash
cd /home/acore/azerothcore-wotlk/modules
git clone --branch master https://github.com/Calmoran/mod-heimdall.git
```

`master` is the released version; `nightly` is the development branch. One clone brings both halves.

## 2. Apply the core patch

```bash
cd /home/acore/azerothcore-wotlk
git apply modules/mod-heimdall/patches/0001-expose-loginqueryholder-to-modules.patch
```

Fifteen lines, no behaviour change — it moves a class declaration into a header so the module can
build the same login query the core does. If it refuses to apply, check whether it is already there
before doing anything else:

```bash
git apply --reverse --check modules/mod-heimdall/patches/0001-expose-loginqueryholder-to-modules.patch \
  && echo "ALREADY APPLIED - skip this step"
```

If that does not print `ALREADY APPLIED`, the patch does not fit your core version — see
[Troubleshooting: the core patch](INSTALL-troubleshooting.md#the-core-patch-will-not-apply). Why the
patch exists: [patches/README.md](../patches/README.md).

## 3. Rebuild the worldserver

**`acore.sh` install** (`CMODULES` is already `static`; `config.sh` must exist first):

```bash
cd /home/acore/azerothcore-wotlk
cp -n conf/dist/config.sh conf/config.sh
./acore.sh compiler build
```

**Raw CMake install:** add `-DMODULES=static` to the configure command you already build with, and
rebuild.

The configure output must list `mod-heimdall`. A module the build does not discover produces no
error at all — it simply is not there. On a box that is also serving players, cap the build's
threads (`MTHREADS` in `conf/config.sh`) and run it inside `tmux` so an SSH drop does not cost an
hour. Windows: build from PowerShell, not Git Bash — see
[Troubleshooting: Windows builds](INSTALL-troubleshooting.md#windows-builds).

## 4. Create Heimdall's database

Heimdall's seven tables live in **their own database on the same MySQL instance** as the realm —
never inside `acore_characters`, and the bot's account cannot reach any realm database.

```bash
sudo mysql < /home/acore/azerothcore-wotlk/modules/mod-heimdall/deploy/create-heimdall-database.sql
```

Edit that file first if your core's MySQL user is not `'acore'@'localhost'`. The module creates the
tables itself on first start; there is no SQL to import. On stock Ubuntu `sudo mysql` works and
`mysql -u root -p` does not.

## 5. Install the config file

```bash
cd /home/acore/azerothcore-wotlk
cp modules/mod-heimdall/conf/heimdall.conf.dist env/dist/etc/modules/heimdall.conf
```

Windows: the same file goes beside `worldserver.conf`, typically
`server\configs\modules\heimdall.conf`. **Edit `heimdall.conf`, never the `.dist`** — the build
overwrites the `.dist` on every compile, and it is not the file the server reads. **Save it as
plain UTF-8 with no BOM**; Notepad adds one and the server then logs `Config::LoadFile: Failure to
read line number 1` and ignores that line.

## 6. Start the worldserver and read the log line

**Set `Heimdall.Enabled = 1`** — it ships `0`, and a disabled module starts silently, with none of
the lines below. Leave `Heimdall.GmIdentities` empty for now: it needs a character that does not
exist yet.

```
Heimdall schema ready in `heimdall`: 7 tables, schema version 1
Heimdall 2.0.0 enabled for realm tag "..."; gm_ticket polling is read-only.
```

Heimdall logs into the general server log unless you give it a file of its own. For `Heimdall.log`,
add these two lines to `worldserver.conf`, in its Appenders and Loggers sections:

```
Appender.Heimdall=2,5,0,Heimdall.log,w
Logger.module.heimdall=4,Console Heimdall
```

## 7. Create the GM identity

The identity is an ordinary character the module logs in with no client attached, so it can whisper
players. It needs an account nobody plays on, at gmlevel 1. From the worldserver console:

```
account create heimdall <password>
account set gmlevel heimdall 1 -1
```

Log in with the game client on that account, create the character, log out again. Then name it in
`heimdall.conf` and restart the worldserver:

```
Heimdall.GmIdentities = "Heimdallbot"
```

The startup log should say `1 GM identity(ies)`. **gmlevel 1 is not optional**: whispering works
without it, so a missing level stays hidden until the first Claim fails with `Invalid name
specified` — see
[Troubleshooting: claiming fails](INSTALL-troubleshooting.md#claiming-a-ticket-fails-with-invalid-name-specified).

## 8. Install the bot

[INSTALL-bot.md](INSTALL-bot.md) — same clone, `bot/` directory.

---

**Rollback:** set `Heimdall.Enabled = 0`, stop the bot, restart the worldserver. Keep the database.

**Coming from 1.x:** there is no upgrade path. Drop the seven `heimdall_*` tables from the
characters database and install 2.0.0 fresh.

**Upgrading, rebuilding after a core update, and keeping the clone outside the core tree:**
[OPERATIONS.md](OPERATIONS.md#upgrade).
