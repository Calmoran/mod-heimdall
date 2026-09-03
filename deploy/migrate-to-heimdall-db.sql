-- Moves an existing Heimdall 1.x install's tables out of the realm's characters database into
-- Heimdall's own database. Run once, as a MySQL administrator, with the worldserver and the bot
-- both stopped. Every step is reversible: rollback-to-characters-db.sql is the exact inverse.
--
-- Replace the placeholders before running:
--   acore_characters       the realm's characters database
--   heimdall               the new database - must match Heimdall.Database in heimdall.conf
--   'acore'@'localhost'    the account the core's worldserver connects with - the user in
--                          CharacterDatabaseInfo, with the host MySQL sees it from. A core that
--                          connects over TCP to 127.0.0.1 matches the '127.0.0.1' account, not
--                          'localhost'; SELECT user, host FROM mysql.user shows what exists.
--   'heimdall_bot'@...     the bot's account(s), as created by bot/deploy/mysql-grants.sql
--
-- What it does:
--   1. creates the database and grants the core's account on it;
--   2. moves the seven tables in one RENAME TABLE. Same server, so this is a metadata change:
--      no rows are copied, it takes milliseconds regardless of size, the foreign keys between
--      the tables come along, and it is atomic - either all seven move or none do;
--   3. removes the row that recorded heimdall.sql as applied to the characters database, so the
--      core's updater stops tracking a file that no longer exists;
--   4. takes every privilege away from the bot's account and grants it the new database only.
--      Table-level grants do not follow a RENAME TABLE, so without this the bot would keep
--      seven dangling grants on the characters database and none on the tables it needs.
--
-- Afterwards set MYSQL_DATABASE in the bot's .env to the new database name and start the
-- worldserver first, then the bot. See docs/INSTALL.md, "Upgrading from 1.x".

-- 1. The database.
CREATE DATABASE IF NOT EXISTS `heimdall` DEFAULT CHARACTER SET utf8mb4;
GRANT ALL PRIVILEGES ON `heimdall`.* TO 'acore'@'localhost';

-- 2. The tables, data and all.
RENAME TABLE
  `acore_characters`.`heimdall_ticket`     TO `heimdall`.`heimdall_ticket`,
  `acore_characters`.`heimdall_event`      TO `heimdall`.`heimdall_event`,
  `acore_characters`.`heimdall_delivery`   TO `heimdall`.`heimdall_delivery`,
  `acore_characters`.`heimdall_attachment` TO `heimdall`.`heimdall_attachment`,
  `acore_characters`.`heimdall_staff`      TO `heimdall`.`heimdall_staff`,
  `acore_characters`.`heimdall_setting`    TO `heimdall`.`heimdall_setting`,
  `acore_characters`.`heimdall_audit`      TO `heimdall`.`heimdall_audit`;

-- 3. The updater's record of the old file.
DELETE FROM `acore_characters`.`updates` WHERE `name` = 'heimdall.sql';

-- 4. The bot's account: nothing, then the new database.
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'heimdall_bot'@'localhost', 'heimdall_bot'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON `heimdall`.* TO 'heimdall_bot'@'localhost', 'heimdall_bot'@'127.0.0.1';
FLUSH PRIVILEGES;

-- Check. The first should list the seven tables, the second nothing; the third shows the grants.
SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'heimdall' ORDER BY TABLE_NAME;
SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'acore_characters' AND TABLE_NAME LIKE 'heimdall%';
SHOW GRANTS FOR 'heimdall_bot'@'localhost';
