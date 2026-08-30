# heimdall-bot

**A Discord ticket system for AzerothCore.** Heimdall turns in-game GM tickets into private Discord
channels your staff can work in, and lets players open tickets from Discord without a game account —
so a small team can run support from one place instead of watching two.

It is two halves: `mod-heimdall`, a server module compiled into your worldserver, and this bot. The
module reads tickets and publishes what staff need; the bot talks to Discord. They share nothing but
seven tables, and the bot is never given access to player data.

Requires: AzerothCore, MySQL, Node.js 20 or later, and a Discord bot you control.

## Staff workflow

- Discord users press one button on the panel and pick Support, Bug Report, or
  Player Report from a menu. Each gets one private `DIS-` ticket channel.
- An in-game ticket produces a staff-only channel keyed by the realm's tag, such
  as `R1-42`; the player does not need a Discord account.
- Before claim, every configured staff and admin role can see a ticket; roles
  are IDs in two lists, named whatever your server names them, with as many
  tiers as you have.
- After claim, only the claimant, the admin roles, the ticket creator when
  applicable, and the bot can see it. Admins can also reassign, reopen, and act
  on tickets claimed by someone else; staff work their own.
- Staff work in a private thread on each ticket. Only the explicit **Reply to
  Player** control queues a player-facing message.

Read [docs/INSTALL.md](docs/INSTALL.md) before running it, and
[docs/LIMITS.md](docs/LIMITS.md) for what it will not do. Operational,
security, backup, upgrade, rollback, retention, and troubleshooting procedures
are in [docs/OPERATIONS.md](docs/OPERATIONS.md) and
[docs/SECURITY.md](docs/SECURITY.md).

Two-way in-game whisper chat works through real characters: each GM identity is a
character the module holds in-world with no game client attached, so a whisper to
it is an ordinary whisper and the stock script hooks are enough. The chat path is
untouched. Holding a character that way needs one small patch to stock AzerothCore,
shipped with the module and not needed on mod-playerbots based cores.

License: AGPL-3.0-or-later.
