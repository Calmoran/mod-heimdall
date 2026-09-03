-- Creates the database Heimdall keeps its tables in and lets the core reach it. Run once, as a
-- MySQL administrator, before the first start of a worldserver with Heimdall 2.x. New installs
-- only; an existing 1.x install runs migrate-to-heimdall-db.sql instead, which includes this.
--
-- Replace the two placeholders:
--   heimdall            the database name - must match Heimdall.Database in heimdall.conf
--   'acore'@'localhost' the account the core's worldserver connects with (the user in
--                       CharacterDatabaseInfo in worldserver.conf)
--
-- The module creates its own tables at startup on the core's connection, so the core's account
-- needs the right to create tables here. Nothing else does: the bot's account is set up by
-- bot/deploy/mysql-grants.sql and is never given rights beyond this one database.

CREATE DATABASE IF NOT EXISTS `heimdall` DEFAULT CHARACTER SET utf8mb4;

GRANT ALL PRIVILEGES ON `heimdall`.* TO 'acore'@'localhost';

FLUSH PRIVILEGES;
