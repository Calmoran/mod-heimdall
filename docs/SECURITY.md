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
- Keep MySQL bound to loopback. Grant the bot only the module table privileges shown in
  `deploy/mysql-grants.sql`; do not grant broad Characters, Auth, or World access. That account is
  the whole of the bot's access to your realm.
- Do not give the Discord bot Administrator. Use only the documented channel,
  interaction, history, message, and overwrite permissions.
- Every ticket control checks role eligibility, and actions that speak for a GM
  also require an enabled roster mapping. Administrators retain oversight.
- Bot-created content disables broad mentions. Attachment names are sanitized,
  content is size limited, and files are saved outside the web root with hashes.
- Treat closure notes as internal. No user-controlled text is ever spliced into
  command syntax: the module builds each command from validated fields.
- Back up the module tables and private archive together; see the backup section
  of `docs/OPERATIONS.md`.

If a secret is exposed, revoke/rotate it immediately, invalidate active bot
sessions by changing the token, update the environment file, and restart only
the bot after verifying the replacement.
