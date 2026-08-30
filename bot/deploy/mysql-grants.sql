-- Replace the account name and password before use. Run this as a database administrator.
-- The bot is intentionally limited to the module's tables in the Characters database.
--
-- Both @localhost and @127.0.0.1 are created on purpose. MySQL treats them as different
-- accounts: 'localhost' matches a unix-socket or named-pipe connection, while a TCP connection
-- to 127.0.0.1 matches the '127.0.0.1' host. The bot connects over TCP, so granting only
-- @localhost produces an access-denied error that reads exactly like a wrong password.

CREATE USER IF NOT EXISTS 'heimdall_bot'@'localhost' IDENTIFIED BY 'replace_with_a_strong_unique_password';
CREATE USER IF NOT EXISTS 'heimdall_bot'@'127.0.0.1' IDENTIFIED BY 'replace_with_a_strong_unique_password';

GRANT SELECT, INSERT, UPDATE, DELETE ON `your_characters_database`.`heimdall_ticket` TO 'heimdall_bot'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `your_characters_database`.`heimdall_event` TO 'heimdall_bot'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `your_characters_database`.`heimdall_delivery` TO 'heimdall_bot'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `your_characters_database`.`heimdall_attachment` TO 'heimdall_bot'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `your_characters_database`.`heimdall_staff` TO 'heimdall_bot'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `your_characters_database`.`heimdall_setting` TO 'heimdall_bot'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON `your_characters_database`.`heimdall_audit` TO 'heimdall_bot'@'localhost';

GRANT SELECT, INSERT, UPDATE, DELETE ON `your_characters_database`.`heimdall_ticket` TO 'heimdall_bot'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON `your_characters_database`.`heimdall_event` TO 'heimdall_bot'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON `your_characters_database`.`heimdall_delivery` TO 'heimdall_bot'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON `your_characters_database`.`heimdall_attachment` TO 'heimdall_bot'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON `your_characters_database`.`heimdall_staff` TO 'heimdall_bot'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON `your_characters_database`.`heimdall_setting` TO 'heimdall_bot'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON `your_characters_database`.`heimdall_audit` TO 'heimdall_bot'@'127.0.0.1';

FLUSH PRIVILEGES;
