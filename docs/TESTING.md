# Test and release checklist

Run `npm test` and `npm run check` before every release. `npm test` includes a smoke test that
launches the bot as a real process and waits for its startup line, because a release once shipped a
bot that could not start at all: every other test exercised the service without ever running the
program.

Before tagging, install from the artifact rather than from your working tree - clone the tag into an
empty directory, `npm ci --omit=dev`, and start the bot against a test guild. A working tree can
hold files the tag does not. Then use a separate
Discord guild and development realm to verify the following:

- Module config and SQL load; no query writes to `gm_ticket` occur.
- Repeated polls and bot restarts do not create duplicate channels, events, or
  player messages.
- A temporary failure of a queued realm command is leased, retried, and
  eventually delivered once — and one the realm keeps refusing warns in the
  ticket channel on the third attempt and posts a dead letter when it is given up
  on, whichever side performed it.
- The full ticket lifecycle works with no game account configured for the bot:
  claim, identity login, reply, close.
- A queued intent row naming an action the module does not perform is refused,
  and refused the same way whatever its other fields contain.
- A player-offline reply remains queued and delivers in sequence after login.
- Discord-native categories create unique `DIS-` channels and enforce one open
  ticket per Discord user.
- In-game tickets create staff-only channels keyed by the realm tag, such as `R1-42`.
- Claim hides the channel from other staff roles; admin roles retain
  access; reassign, reopen, close, transcript archive, and retention cleanup work.
- Attachments are private, size-limited, included in backup/restore testing, and
  removed with the transcript at expiry.
- Whisper handling proves no regression to ordinary whispers between players,
  invalid recipients, or unrelated chat: only a whisper addressed to a held GM
  identity, from a player with an open ticket, is intercepted.
- The development-realm identity test proves a GM reply arrives in game from the
  identity's name, and that a player reply to that identity reaches the original
  ticket channel.

Every release runs this checklist on a development realm and a private test
guild before it is tagged; a public realm is never the first place a change runs.
