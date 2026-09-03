-- Creates the database Heimdall keeps its tables in and lets the core reach it. Run once, as a
-- MySQL administrator, before the first start of a worldserver with Heimdall 2.x. New installs
-- 2.0.0 is a fresh-install release; there is no upgrade path from 1.x.
--
-- Replace the two placeholders:
--   heimdall            the database name - must match Heimdall.Database in heimdall.conf
--   'acore'@'localhost' the account the core's worldserver connects with (the user in
--                       CharacterDatabaseInfo in worldserver.conf, with the host MySQL sees it
--                       from - over TCP to 127.0.0.1 that is the '127.0.0.1' account, not
--                       'localhost'; SELECT user, host FROM mysql.user shows what exists)
--
-- The module creates its own tables at startup on the core's connection, so the core's account
-- needs the right to create tables here. Nothing else does: the bot's account is set up by
-- bot/deploy/mysql-grants.sql and is never given rights beyond this one database.

CREATE DATABASE IF NOT EXISTS `heimdall` DEFAULT CHARACTER SET utf8mb4;

GRANT ALL PRIVILEGES ON `heimdall`.* TO 'acore'@'localhost';

FLUSH PRIVILEGES;
