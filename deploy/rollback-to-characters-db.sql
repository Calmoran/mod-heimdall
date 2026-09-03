-- The inverse of migrate-to-heimdall-db.sql: puts Heimdall's tables back in the realm's characters
-- database for a return to a 1.x module. Run as a MySQL administrator with the worldserver and the
-- bot both stopped, then set MYSQL_DATABASE in the bot's .env back to the characters database.
--
-- Same placeholders as the migration. Same properties: one atomic RENAME TABLE, no rows copied.
--
-- The updates row is not restored on purpose. A 1.x worldserver that does not find it re-applies
-- heimdall.sql, which is CREATE TABLE IF NOT EXISTS seven times over tables that now exist, and
-- records it again. Nothing is lost either way.

RENAME TABLE
  `heimdall`.`heimdall_ticket`     TO `acore_characters`.`heimdall_ticket`,
  `heimdall`.`heimdall_event`      TO `acore_characters`.`heimdall_event`,
  `heimdall`.`heimdall_delivery`   TO `acore_characters`.`heimdall_delivery`,
  `heimdall`.`heimdall_attachment` TO `acore_characters`.`heimdall_attachment`,
  `heimdall`.`heimdall_staff`      TO `acore_characters`.`heimdall_staff`,
  `heimdall`.`heimdall_setting`    TO `acore_characters`.`heimdall_setting`,
  `heimdall`.`heimdall_audit`      TO `acore_characters`.`heimdall_audit`;

-- The 1.x grants: the seven tables in the characters database, and nothing else.
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'heimdall_bot'@'localhost', 'heimdall_bot'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON `acore_characters`.`heimdall_ticket`     TO 'heimdall_bot'@'localhost', 'heimdall_bot'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON `acore_characters`.`heimdall_event`      TO 'heimdall_bot'@'localhost', 'heimdall_bot'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON `acore_characters`.`heimdall_delivery`   TO 'heimdall_bot'@'localhost', 'heimdall_bot'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON `acore_characters`.`heimdall_attachment` TO 'heimdall_bot'@'localhost', 'heimdall_bot'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON `acore_characters`.`heimdall_staff`      TO 'heimdall_bot'@'localhost', 'heimdall_bot'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON `acore_characters`.`heimdall_setting`    TO 'heimdall_bot'@'localhost', 'heimdall_bot'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON `acore_characters`.`heimdall_audit`      TO 'heimdall_bot'@'localhost', 'heimdall_bot'@'127.0.0.1';
FLUSH PRIVILEGES;

-- The empty database can stay; drop it once you are sure you are not coming back:
--   DROP DATABASE `heimdall`;
