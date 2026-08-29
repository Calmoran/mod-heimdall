# Test and release checklist

Run `npm test` and `npm run check` before every release. Then use a separate
Discord guild and development realm to verify the following:

- Module config and SQL load; no query writes to `gm_ticket` occur.
- Repeated polls and bot restarts do not create duplicate channels, events, or
  player messages.
- A temporary SOAP failure is leased, retried, and eventually delivered once.
- A player-offline reply remains queued and delivers in sequence after login.
- Discord-native categories create unique `DIS-` channels and enforce one open
  ticket per Discord user.
- In-game tickets create staff-only channels keyed by the realm tag, such as `R1-42`.
- Claim hides the channel from other Moderators/Game Masters; Admin retains
  access; reassign, reopen, close, transcript archive, and retention cleanup work.
- Attachments are private, size-limited, included in backup/restore testing, and
  removed with the transcript at expiry.
- Whisper handling proves no regression to ordinary whispers between players,
  invalid recipients, or unrelated chat: only a whisper addressed to a held GM
  identity, from a player with an open ticket, is intercepted.
- The development-realm identity test proves a GM reply arrives in game from the
  identity's name, and that a player reply to that identity reaches the original
  ticket channel.

Release in this order: development realm and private test guild, staff pilot,
public server launch, then public source release and module-catalogue submission.
