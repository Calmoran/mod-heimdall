# Install the bot

Do [INSTALL.md](INSTALL.md) first — the bot is in the same clone, under `bot/`, and it needs the
module's database to exist. Use a test guild and a test realm for your first install.

> Examples assume the clone at `/home/acore/azerothcore-wotlk/modules/mod-heimdall`, running as the
> user `acore`. Every command runs from `bot/` unless it says otherwise.
>
> If a step fails, see [INSTALL-troubleshooting.md](INSTALL-troubleshooting.md).

## 1. Create the Discord application

In the [Developer Portal](https://discord.com/developers/applications), create an application, add
a bot, and copy its token. Enable all three gateway intents on the Bot page:

- **Guilds** and **Guild Messages** — without them the bot cannot start.
- **Message Content** (privileged) — **turn this on.** Without it Discord delivers messages with no
  text, so transcripts fill with authors, timestamps and attachments and no words. Nothing errors.

Invite it with this URL, replacing the application id (Developer Portal → **General Information**;
it is not the token):

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_APPLICATION_ID&permissions=361582775312&scope=bot%20applications.commands
```

That URL grants exactly what the bot checks for at startup, and no more. Required, or it refuses to
run: View Channels, Send Messages, Read Message History, Embed Links, Manage Channels,
Manage Permissions, Create Private Threads, Send Messages in Threads. Optional, each costing a
feature:
Manage Threads, Manage Webhooks, and Mention @everyone, @here and All Roles.

**Do not grant Administrator.** It satisfies every permission check silently, including the bot's
own startup preflight, so you never find out whether the permissions are right.

**Do not create a role for the bot.** Discord makes one managed role per application when you
invite it; that is the only role a bot is ever in, and Heimdall finds it itself. Drag that managed
role above any role whose channel permissions the bot must manage.

You do not need to create channels. The bot builds its own categories, panel and queue board on
first run and remembers them.

## 2. Create the bot's MySQL account

Copy the grants file out of the repository before editing it, so a live password never sits in a
tracked file:

```bash
cd /home/acore/azerothcore-wotlk/modules/mod-heimdall
cp bot/deploy/mysql-grants.sql /tmp/grants.sql
nano /tmp/grants.sql          # replace the password in both CREATE USER lines
sudo mysql < /tmp/grants.sql
rm /tmp/grants.sql
```

**The password needs an upper-case letter, a lower-case letter, a digit and a symbol.** MySQL's
default policy rejects anything else with `ERROR 1819`, which does not mention passwords.

The file creates the account twice on purpose — `@localhost` and `@127.0.0.1` are different
accounts in MySQL, and granting only one produces an access-denied error that reads exactly like a
wrong password. The account gets Heimdall's database and nothing else: a `SELECT` against the
realm's characters table fails with `ERROR 1142`.

## 3. Configure the bot

```bash
cd /home/acore/azerothcore-wotlk/modules/mod-heimdall/bot
cp .env.example .env
chmod 600 .env
sudo mkdir -p /var/lib/heimdall/archive
sudo chown -R acore:acore /var/lib/heimdall
nano .env
```

Fill in `DISCORD_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_STAFF_ROLE_IDS`, `MYSQL_PASSWORD` and
`BOT_INSTANCE_ID` (any name you will recognise in logs, e.g. `lin-heimdall`). Role **ids**, not
names — your roles can be called anything. Leave `DISCORD_ADMIN_ROLE_IDS` empty and anyone with
Discord's Manage Server permission is the admin tier.

## 4. Install dependencies and start it by hand

```bash
npm ci --omit=dev
node src/index.js
```

Start it by hand the first time: a missing or wrong value is named explicitly on the first line and
is far easier to read here than through a service manager. Fix whatever it names, then stop it with
Ctrl+C.

Healthy output ends with `Discord ticket bot ready as <name>` and a line for each channel it
provisioned.

## 5. Keep it running

**Linux (systemd)** — paths filled in for the layout at the top of this page:

```bash
sudo tee /etc/systemd/system/heimdall-bot.service > /dev/null <<'UNIT'
[Unit]
Description=Heimdall Discord bot
After=network-online.target mysql.service
Wants=network-online.target

[Service]
Type=simple
User=acore
WorkingDirectory=/home/acore/azerothcore-wotlk/modules/mod-heimdall/bot
Environment=HEIMDALL_ENV_FILE=/home/acore/azerothcore-wotlk/modules/mod-heimdall/bot/.env
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=15
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now heimdall-bot
systemctl status heimdall-bot --no-pager
```

The same unit ships as `bot/deploy/heimdall-bot.service` if you would rather copy the file.

**Windows** — `run-bot.cmd` sets `HEIMDALL_ENV_FILE` to the `.env` beside it and starts the bot.
Run it from a terminal first, then wrap it with NSSM or Task Scheduler so it survives a reboot.

**Docker** — the bot runs as its own container on the Compose network:

```bash
cp bot/deploy/docker-compose.bot.yml /path/to/azerothcore-wotlk/docker-compose.override.yml
docker compose up -d --build
```

Inside the network the database is `MYSQL_HOST=ac-database`, `MYSQL_PORT=3306`. Three Docker traps —
the host port collision, the config file the entrypoint does not create, and a restart loop that
hides its own first error — are in
[Troubleshooting: Docker](INSTALL-troubleshooting.md#docker).

## 6. Check it works

```bash
npm run diagnose
```

Then, in the guild: add yourself with `/ticket staff-add`, open a ticket from the panel, claim it,
reply, and close it. **The GM name you map must be on an account with gmlevel 1 or higher**, or
claiming an in-game ticket fails — see
[INSTALL.md step 7](INSTALL.md#7-create-the-gm-identity).

For the in-game half, whisper the GM identity from a player character and confirm it reaches the
ticket channel, then reply from Discord and confirm it arrives in game.

---

**Upgrading** and **moving Heimdall to a different guild**: [OPERATIONS.md](OPERATIONS.md#upgrade).
