-- The bot's MySQL account. Replace the password before use and run this as a database
-- administrator, after deploy/create-heimdall-database.sql (or the migration) has created the
-- database.
--
-- The account is granted Heimdall's own database and nothing else. It never connects to a realm
-- database: no realm database is named in this file, and a SELECT against one fails with
--   ERROR 1142 (42000): SELECT command denied to user 'heimdall_bot'@'localhost' for table ...
-- It also has no DROP or ALTER, so it cannot change the tables, only their rows.
--
-- Both @localhost and @127.0.0.1 are created on purpose. MySQL treats them as different
-- accounts: 'localhost' matches a unix-socket or named-pipe connection, while a TCP connection
-- to 127.0.0.1 matches the '127.0.0.1' host. The bot connects over TCP, so granting only
-- @localhost produces an access-denied error that reads exactly like a wrong password. A bot
-- in a container connects from neither; grant to 'heimdall_bot'@'%' there (docs/INSTALL-bot.md).
--
-- MySQL 8 validates the password you choose. The default policy (MEDIUM) needs at least eight
-- characters with an upper case letter, a lower case letter, a digit AND a symbol, so a password
-- generated as plain letters and digits is refused outright with
--   ERROR 1819 (HY000): Your password does not satisfy the current policy requirements
-- which does not say that your password is the problem. Include a symbol.
--
-- If you changed Heimdall.Database in heimdall.conf, change `heimdall` below to match.

CREATE USER IF NOT EXISTS 'heimdall_bot'@'localhost' IDENTIFIED BY 'replace_with_a_strong_unique_password';
CREATE USER IF NOT EXISTS 'heimdall_bot'@'127.0.0.1' IDENTIFIED BY 'replace_with_a_strong_unique_password';

GRANT SELECT, INSERT, UPDATE, DELETE ON `heimdall`.* TO 'heimdall_bot'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `heimdall`.* TO 'heimdall_bot'@'127.0.0.1';

FLUSH PRIVILEGES;
