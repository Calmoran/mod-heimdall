# Security guide

- Keep the Discord token, the MySQL password, and queue data out of git,
  logs, screenshots, and public channels. Use a mode-600 environment file.
- Run as the dedicated `heimdall` service account. The supplied unit uses
  restart protection and filesystem hardening; review it for your distribution.
- **The bot holds no realm credentials and no remote command channel.** Its environment file
  contains no game account, and it cannot execute anything. It asks for one of a fixed list of
  actions by writing a row - action and arguments as separate fields - and the module composes and
  runs the command inside the worldserver. A row cannot express a command that is not on the list,
  so this boundary is structural rather than a matter of trusting the bot.
- **The GM identity is a realm account, and it is the module's, not the bot's.** The module logs
  its character into the world with no client attached, from inside the worldserver. That
  account's password appears nowhere in the bot's configuration and nowhere in this repository, so
  a fully compromised bot cannot log into it, cannot speak as it, and cannot raise its own
  privileges - the most it can do is queue an action from the list against a ticket that exists.
- **The one realm privilege Heimdall asks for is gmlevel 1 on the GM characters staff are rostered
  under**, because the core refuses to assign a ticket to a character whose account is below it.
  Moderator is the lowest level that satisfies the check and nothing here uses more. That privilege
  sits on realm accounts, granted by your own GM commands; Heimdall neither stores it nor grants
  it, and the bot never sees it.
- **The bot never connects to a realm database. Its database contains Heimdall's own tables and
  nothing else.** The module keeps those tables in a database of their own (`Heimdall.Database`,
  default `heimdall`) and refuses to run with the realm's characters database named there. The
  bot's account is granted that database, as `bot/deploy/mysql-grants.sql` shows, and no other:
  a `SELECT` against a realm table is refused by MySQL with `ERROR 1142 (42000): SELECT command
  denied`, and `SHOW DATABASES` from that account lists Heimdall's and nothing of the realm's.
  Keep MySQL bound to loopback; do not grant the account Characters, Auth, or World access.
- **Nothing here updates itself.** The module is compiled into your worldserver and the bot runs
  the code you checked out; neither fetches code at runtime, and a release reaches your realm only
  when you pull it and rebuild or restart deliberately. Read the changelog before you do. Should a
  release ever carry something it should not, the database boundary above is what contains it -
  the bot's code, whatever it says, reaches only Heimdall's database - and the grants behind it are
  the fallback: an account with `SELECT, INSERT, UPDATE, DELETE` on one database cannot read a
  realm table, drop one of its own, or alter a schema.
- Do not give the Discord bot Administrator. Use only the documented channel,
  interaction, history, message, and overwrite permissions.
- Every ticket control checks role eligibility, and actions that speak for a GM
  also require an enabled roster mapping. Administrators retain oversight.
- Bot-created content disables broad mentions. Attachment names are sanitized,
  content is size limited, and files are saved outside the web root with hashes.
- Treat closure notes as internal. No user-controlled text is ever spliced into
  command syntax: the module builds each command from validated fields.
- Back up Heimdall's database and private archive together; see the backup section
  of `docs/OPERATIONS.md`.

If a secret is exposed, revoke/rotate it immediately, invalidate active bot
sessions by changing the token, update the environment file, and restart only
the bot after verifying the replacement.

## Fixed findings

### 2.0.0 — a command's target came from the request, not from the ticket

**Reported by @AbyssalJake, 2026-09-03**, reading the delivery path on a TrinityCore server.

**What it was.** Heimdall's bot cannot send command text; it writes a row asking for one of a fixed
list of actions, and the module composes and runs the command inside the worldserver. The *action*
was constrained by that list. The *target* was not: the character name, the in-game ticket number
and the ticket's key were read out of the request's own JSON. The module trusted them because in
practice only the bot writes those rows, and the bot fills them from the ticket.

**What it meant.** Anything able to write to Heimdall's database — a compromised bot, or its
database account — could attach an allowlisted action to a ticket it was entitled to and aim it at
any character on the realm. It was never arbitrary command execution: the list is fixed, and a row
still could not express a command that is not on it. But "revive, unstuck, combat stop, teleport or
kick, against whoever the row names" is a far wider reach than "against the player whose ticket
this is", and the same was true of the identity's whispers.

Reviewing the same code found the command path was looser than reported: it did not join the ticket
table at all, so a hand-written row needed no real ticket behind it, and not one belonging to the
realm that would run the command.

**The rule now.** *The module resolves the target from its own ticket row. The request can say only
what to do, never to whom.* The character, the in-game ticket number and the ticket's key all come
from `heimdall_ticket`; the request contributes the action, a teleport destination, the message
text, and the GM identity's name. A command row that does not resolve to a ticket on this realm is
refused and marked dead with a reason, rather than performed or left queued unexplained. Replies
are whispered to the ticket's character resolved by GUID, so a ticket with no character behind it —
any ticket opened in Discord — is refused rather than aimed at a name.

The GM identity's name is still supplied by the request, and that is deliberate rather than an
oversight: the module only ever acts for characters you listed in `Heimdall.GmIdentities`, so a
name that is not on your list resolves to no held identity and nothing happens. It is gated by your
consent, in your own config file.

Names read back out of the database are still validated before they reach a command, because the
database is not a trusted source of command text either — a stored name containing a space would
otherwise become a second argument.

**If you run 1.x**, this is fixed in 2.0.0 and there is no configuration change to make. The
exposure required write access to Heimdall's database, which is also the point at which someone
could alter tickets directly.
