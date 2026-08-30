# Changelog

Versions are shared with the companion bot (heimdall-bot): the two halves release together, and one
number answers "which Heimdall are you running" for both. The version appears in the worldserver's
startup line for this module.

## 0.9.0 — 2026-08-30

First public release.

### What Heimdall is

An AzerothCore module that bridges in-game GM tickets to Discord. Tickets appear as private Discord
channels; staff claim and answer them there; replies reach the player in game as whispers from a
real GM character. The module reads `gm_ticket` and never writes it — every in-game change goes
through documented GM commands over SOAP.

### What an operator gets

- **Read-only ticket polling** that resumes from a persisted per-realm watermark. An idle realm
  writes nothing; a restarted worldserver does not re-announce tickets it has already seen.
- **Closure from either side.** Tickets closed in Discord close in game (`.ticket close` over SOAP);
  tickets closed in game — including a player abandoning theirs, or a GM at the console — close in
  Discord, with the same channel move, notice and retention clock.
- **GM identities held in world.** Each configured identity is a real character brought into the
  world with no game client attached: whisperable, invisible in `/who`, and carrying the client's
  `<GM>` chat badge on its replies (`Heimdall.GmChatTag`, on by default) — a protocol flag a player
  character cannot forge.
- **A published identity list.** The names that survive startup validation are published to the
  bot, so a typo in `/ticket staff-add` is refused when it is made, not discovered mid-conversation.
- **A GM command audit trail** (`Heimdall.CommandAuditEnabled`) batched to Discord, with the bot
  attributing its own SOAP commands to the Discord user who pressed the button.
- **Multi-realm support**: tickets carry a realm tag, so several realms can share one Characters
  database without colliding.
- **A startup line that states the resolved configuration** — command audit, GM chat tag, poll
  timings — so a config file silently reverted by a rebuild is visible in the log rather than
  discovered when a feature is missed.

### Requirements worth knowing before installing

- On stock AzerothCore, one small core patch (shipped in `patches/`, 15 lines, no behaviour change)
  is required before building. mod-playerbots-based cores already carry the equivalent and need
  nothing. An upstream pull request is planned so the step can eventually disappear.
- The companion bot's database account is scoped to the module's own `heimdall_*` tables. It never
  needs — and must never be given — access to player data or `gm_ticket`.
- Windows is tested end to end. Linux and Docker should work and are documented, but no one has run
  them yet; reports welcome.
