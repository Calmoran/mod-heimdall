-- Creates the database Heimdall keeps its tables in and lets the core reach it. Run once, as a
-- MySQL administrator, before the first start of a worldserver with Heimdall 2.x. New installs
-- 2.0.0 is a fresh-install release; there is no upgrade path from 1.x.
--
-- Replace the two placeholders:
--   heimdall            the database name - must match Heimdall.Database in heimdall.conf
--   'acore'@'localhost' the account the core's worldserver actually authenticates as. Do not infer
--                       it from the transport: MySQL picks a matching row out of its grant table,
--                       and hostname resolution decides which. Ask the server instead - connect
--                       with the host, port and credentials from CharacterDatabaseInfo in
--                       worldserver.conf and run SELECT CURRENT_USER(). Grant exactly what that
--                       prints. Granting a plausible-looking account that is not the matching one
--                       leaves the module without access and reads like a wrong password.
--
-- The module creates its own tables at startup on the core's connection, so the core's account
-- needs the right to create tables here. Nothing else does: the bot's account is set up by
-- bot/deploy/mysql-grants.sql and is never given rights beyond this one database.

CREATE DATABASE IF NOT EXISTS `heimdall` DEFAULT CHARACTER SET utf8mb4;

GRANT ALL PRIVILEGES ON `heimdall`.* TO 'acore'@'localhost';

FLUSH PRIVILEGES;
