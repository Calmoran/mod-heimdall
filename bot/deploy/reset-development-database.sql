-- DEVELOPMENT ONLY. NOT PART OF INSTALLING HEIMDALL.
--
-- This script destroys every Heimdall table and everything in them: tickets, transcripts,
-- attachment metadata, the staff roster, and the stored Discord channel and message ids. It exists
-- so a development realm can be put back to a clean state between test runs.
--
-- Do not run this on a server anyone is using. Installing Heimdall does not mean running this
-- file: the module creates its tables itself on first start.
--
-- Run it against Heimdall's database (Heimdall.Database in heimdall.conf, `heimdall` by default)
-- as an administrator, not as the bot's account - the bot deliberately has no DROP privilege.
--
-- After running it, start the worldserver: the module recreates the tables. Then start the bot.
-- Both will re-provision their Discord channels on first run, which leaves the previous ones
-- behind in Discord for you to delete by hand.

DROP TABLE IF EXISTS heimdall_attachment;
DROP TABLE IF EXISTS heimdall_delivery;
DROP TABLE IF EXISTS heimdall_event;
DROP TABLE IF EXISTS heimdall_audit;
DROP TABLE IF EXISTS heimdall_staff;
DROP TABLE IF EXISTS heimdall_setting;
DROP TABLE IF EXISTS heimdall_ticket;

-- The order matters: attachment, delivery and event reference ticket (and attachment references
-- event) by foreign key, so the referencing tables go first and heimdall_ticket goes last.
