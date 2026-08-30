-- DEVELOPMENT ONLY. NOT PART OF INSTALLING HEIMDALL.
--
-- This script destroys every Heimdall table and everything in them: tickets, transcripts,
-- attachment metadata, the staff roster, and the stored Discord channel and message ids. It exists
-- so a development realm can be put back to a clean state between test runs.
--
-- Do not run this on a server anyone is using. Installing Heimdall means applying
-- data/sql/db_characters/base/heimdall.sql from the module; it does not mean running this file.
--
-- Run it against the Characters database as an administrator, not as the bot's account - the bot
-- deliberately has no DROP privilege.
--
-- After running it, apply the module's heimdall.sql to recreate the tables, then restart the
-- worldserver and the bot. Both will re-provision their Discord channels on first run, which
-- leaves the previous ones behind in Discord for you to delete by hand.

DROP TABLE IF EXISTS heimdall_attachment;
DROP TABLE IF EXISTS heimdall_delivery;
DROP TABLE IF EXISTS heimdall_event;
DROP TABLE IF EXISTS heimdall_audit;
DROP TABLE IF EXISTS heimdall_staff;
DROP TABLE IF EXISTS heimdall_setting;
DROP TABLE IF EXISTS heimdall_ticket;

-- The tables carry no foreign keys, so the order above is only for readability.
