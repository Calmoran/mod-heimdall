# Security guide

- Keep Discord token, MySQL password, SOAP password, and queue data out of git,
  logs, screenshots, and public channels. Use a mode-600 environment file.
- Run as the dedicated `heimdall` service account. The supplied unit uses
  restart protection and filesystem hardening; review it for your distribution.
- Keep SOAP and MySQL bound to loopback. Grant the bot only the module table
  privileges shown in `deploy/mysql-grants.sql`; do not grant broad Characters,
  Auth, or World access.
- Do not give the Discord bot Administrator. Use only the documented channel,
  interaction, history, message, and overwrite permissions.
- Every ticket control checks role eligibility, and actions that speak for a GM
  also require an enabled roster mapping. Administrators retain oversight.
- Bot-created content disables broad mentions. Attachment names are sanitized,
  content is size limited, and files are saved outside the web root with hashes.
- Treat closure notes as internal. The bot does not splice user-controlled text
  into SOAP command syntax.
- Back up the module tables and private archive together; see the backup section
  of `docs/OPERATIONS.md`.

If a secret is exposed, revoke/rotate it immediately, invalidate active bot
sessions by changing the token, update the environment file, and restart only
the bot after verifying the replacement.
