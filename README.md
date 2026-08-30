# Heimdall (mod-heimdall)

**A Discord ticket system for AzerothCore.** Heimdall turns in-game GM tickets into private Discord
channels your staff can work in, and lets players open tickets from Discord without a game account —
so a small team can run support from one place instead of watching two.

One repository, two halves that release together: the server module at the root, compiled into your
worldserver, and the bot in [bot/](bot/), which talks to Discord. The module reads tickets and
publishes what staff need; the bot never touches player data — they share nothing but seven
`heimdall_*` tables. Clone the whole repository into your core's `modules/` directory; the build
finds the module at the root and ignores `bot/`.

Requires: AzerothCore, MySQL, Node.js 20 or later, and a Discord bot you control. The bot runs on
the same host as the realm — it needs loopback MySQL and loopback SOAP.

## What the module does

- Reads AzerothCore ticket state from `gm_ticket`; it never writes that table.
- Creates idempotent local ticket, event, audit, and delivery-queue records.
- Lets the bot use official SOAP ticket commands for assignment and closure.
- Keeps player-facing replies durable for ordered delivery when the player is online.

## Two-way whisper chat

Each GM identity is a real character the module holds in-world with no game client
attached, so a whisper addressed to it is an ordinary whisper that the stock script
hooks already see. Nothing bypasses normal whisper validation, and the chat path
itself is untouched. Replies carry the client's `<GM>` chat badge
(`Heimdall.GmChatTag`, default on) — a protocol flag a player character cannot
forge, so players can trust who is answering.

Holding a character that way needs one small patch to stock AzerothCore, shipped in
[patches/](patches/): it moves a class declaration into a header so a module can build
the login query the core's own login path builds. Fifteen lines, no behaviour change.
Cores based on mod-playerbots already carry the equivalent and need nothing. A pull
request to upstream it is planned, after which the patch step disappears.

## Staff workflow

- Discord users press one button on the panel and pick Support, Bug Report, or
  Player Report from a menu. Each gets one private `DIS-` ticket channel.
- An in-game ticket produces a staff-only channel keyed by the realm's tag, such
  as `R1-42`; the player does not need a Discord account. Staff work directly in
  that channel â€” header, player card, GM controls and discussion â€” because no
  player can read it.
- Before claim, every configured staff and admin role can see a ticket; roles
  are IDs in two lists, named whatever your server names them, with as many
  tiers as you have.
- After claim, only the claimant, the admin roles, the ticket creator when
  applicable, and the bot can see it. Admins can also reassign, reopen, and act
  on tickets claimed by someone else; staff work their own.
- On a Discord-opened ticket the reporter shares the channel, so staff work in
  a private thread they cannot see. Either way, only the explicit **Reply to
  Player** control queues a player-facing message.

## Where to go next

Install the module first — [docs/INSTALL.md](docs/INSTALL.md) — then the bot —
[docs/INSTALL-bot.md](docs/INSTALL-bot.md). Reference: [docs/CONFIGURATION.md](docs/CONFIGURATION.md),
[docs/LIMITS.md](docs/LIMITS.md) for what it will not do, and
[docs/OPERATIONS.md](docs/OPERATIONS.md) and [docs/SECURITY.md](docs/SECURITY.md) for running it.
Architecture notes are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

License: AGPL-3.0-or-later. The full license text is available from the
[GNU AGPL page](https://www.gnu.org/licenses/agpl-3.0.html).
