// Standalone test for Heimdall::Sql::Qualify. Builds with nothing but a C++17 compiler:
//
//   g++ -std=c++17 -Wall -Wextra -Werror -I src test/qualify_test.cpp -o qualify_test && ./qualify_test
//   cl /std:c++17 /EHsc /W4 /WX /I src test\qualify_test.cpp && qualify_test.exe
//
// The case that matters most is the first one: a CONSTRAINT line whose name contains a table name
// must come out byte-for-byte untouched. Everything else is here so a future change to the matcher
// cannot quietly widen or narrow what it rewrites.

#include "mod_heimdall_qualify.h"
#include "mod_heimdall_schema_ddl.h"

#include <cstdio>
#include <string>

namespace
{
int failures = 0;

void Expect(char const* name, std::string const& actual, std::string const& expected)
{
    if (actual == expected)
        return;

    ++failures;
    std::printf("FAIL %s\n  expected: %s\n  actual:   %s\n", name, expected.c_str(), actual.c_str());
}

void ExpectCount(char const* name, std::string const& haystack, std::string const& needle, std::size_t expected)
{
    std::size_t count = 0;
    for (std::size_t pos = haystack.find(needle); pos != std::string::npos; pos = haystack.find(needle, pos + needle.size()))
        ++count;

    if (count == expected)
        return;

    ++failures;
    std::printf("FAIL %s\n  expected %zu occurrence(s) of %s, found %zu\n", name, expected, needle.c_str(), count);
}

void ExpectBool(char const* name, bool actual, bool expected)
{
    if (actual == expected)
        return;

    ++failures;
    std::printf("FAIL %s\n  expected: %s\n  actual:   %s\n", name, expected ? "true" : "false", actual ? "true" : "false");
}
}

int main()
{
    using Heimdall::Sql::Qualify;
    using Heimdall::Sql::IsValidDatabaseName;

    // The operator's requirement: constraint names that contain table names are not table names.
    {
        std::string const line = "CONSTRAINT fk_heimdall_event_ticket FOREIGN KEY (ticket_id) REFERENCES heimdall_ticket (id) ON DELETE CASCADE";
        Expect("constraint name untouched, REFERENCES qualified",
               Qualify(line, "heimdall"),
               "CONSTRAINT fk_heimdall_event_ticket FOREIGN KEY (ticket_id) REFERENCES `heimdall`.`heimdall_ticket` (id) ON DELETE CASCADE");
    }
    {
        std::string const line = "  CONSTRAINT fk_heimdall_attachment_event FOREIGN KEY (event_id) REFERENCES heimdall_event (id) ON DELETE SET NULL,";
        Expect("constraint with two table names inside it",
               Qualify(line, "heimdall"),
               "  CONSTRAINT fk_heimdall_attachment_event FOREIGN KEY (event_id) REFERENCES `heimdall`.`heimdall_event` (id) ON DELETE SET NULL,");
    }

    // Index names are the same shape.
    Expect("index name untouched",
           Qualify("KEY ix_heimdall_status (status, updated_at),", "heimdall"),
           "KEY ix_heimdall_status (status, updated_at),");
    Expect("unique index name untouched",
           Qualify("UNIQUE KEY uq_heimdall_source (source, source_id)", "heimdall"),
           "UNIQUE KEY uq_heimdall_source (source, source_id)");

    // A table name that is the suffix of a longer identifier is not a table name either.
    Expect("suffix inside longer identifier untouched",
           Qualify("SELECT old_heimdall_ticket FROM t", "heimdall"),
           "SELECT old_heimdall_ticket FROM t");
    Expect("table name as prefix of longer identifier untouched",
           Qualify("SELECT heimdall_ticket_count FROM t", "heimdall"),
           "SELECT heimdall_ticket_count FROM t");

    // Plain DML in the shapes the module actually uses.
    Expect("SELECT ... FROM",
           Qualify("SELECT id, status FROM heimdall_ticket WHERE id = 1", "heimdall"),
           "SELECT id, status FROM `heimdall`.`heimdall_ticket` WHERE id = 1");
    Expect("INSERT INTO",
           Qualify("INSERT INTO heimdall_event (ticket_id, kind) VALUES (1, 'reply')", "heimdall"),
           "INSERT INTO `heimdall`.`heimdall_event` (ticket_id, kind) VALUES (1, 'reply')");
    Expect("UPDATE",
           Qualify("UPDATE heimdall_delivery SET state = 'sent' WHERE id = 3", "heimdall"),
           "UPDATE `heimdall`.`heimdall_delivery` SET state = 'sent' WHERE id = 3");
    Expect("DELETE FROM",
           Qualify("DELETE FROM heimdall_setting WHERE name = 'x'", "heimdall"),
           "DELETE FROM `heimdall`.`heimdall_setting` WHERE name = 'x'");
    Expect("CREATE TABLE IF NOT EXISTS",
           Qualify("CREATE TABLE IF NOT EXISTS heimdall_staff (", "heimdall"),
           "CREATE TABLE IF NOT EXISTS `heimdall`.`heimdall_staff` (");
    Expect("join with two tables and a trailing newline",
           Qualify("SELECT t.id FROM heimdall_ticket t JOIN heimdall_audit a ON a.ticket_id = t.id\n", "heimdall"),
           "SELECT t.id FROM `heimdall`.`heimdall_ticket` t JOIN `heimdall`.`heimdall_audit` a ON a.ticket_id = t.id\n");
    Expect("table name at the very start and very end",
           Qualify("heimdall_attachment", "heimdall"),
           "`heimdall`.`heimdall_attachment`");
    Expect("every table in one statement",
           Qualify("heimdall_ticket,heimdall_event,heimdall_delivery,heimdall_attachment,heimdall_staff,heimdall_setting,heimdall_audit", "hd"),
           "`hd`.`heimdall_ticket`,`hd`.`heimdall_event`,`hd`.`heimdall_delivery`,`hd`.`heimdall_attachment`,`hd`.`heimdall_staff`,`hd`.`heimdall_setting`,`hd`.`heimdall_audit`");

    // Already quoted or already qualified names are left alone: running Qualify twice is a no-op.
    Expect("backquoted name untouched",
           Qualify("SELECT 1 FROM `heimdall_ticket`", "heimdall"),
           "SELECT 1 FROM `heimdall_ticket`");
    {
        std::string const once = Qualify("SELECT 1 FROM heimdall_ticket", "heimdall");
        Expect("idempotent", Qualify(once, "heimdall"), once);
    }
    Expect("dotted name untouched",
           Qualify("SELECT 1 FROM other.heimdall_ticket", "heimdall"),
           "SELECT 1 FROM other.heimdall_ticket");

    // A table name inside a string literal is data, not a table reference.
    Expect("string literal untouched",
           Qualify("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_NAME = 'heimdall_ticket'", "heimdall"),
           "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_NAME = 'heimdall_ticket'");
    Expect("double-quoted literal untouched",
           Qualify("SELECT \"heimdall_event\"", "heimdall"),
           "SELECT \"heimdall_event\"");

    // The prefix alone, or with an unknown suffix, is not a table.
    Expect("unknown heimdall_ name untouched",
           Qualify("SELECT heimdall_nothing FROM t", "heimdall"),
           "SELECT heimdall_nothing FROM t");
    Expect("bare prefix untouched",
           Qualify("heimdall_", "heimdall"),
           "heimdall_");
    Expect("no heimdall at all",
           Qualify("SELECT guid FROM characters WHERE name = ?", "heimdall"),
           "SELECT guid FROM characters WHERE name = ?");
    Expect("empty input",
           Qualify("", "heimdall"),
           "");

    // The DDL the module actually runs at startup, end to end. Seven CREATE TABLE names and four
    // REFERENCES are rewritten; every constraint and index name survives verbatim.
    {
        std::string const ddl = Qualify(Heimdall::Sql::SCHEMA_DDL, "heimdall");
        ExpectCount("ddl: seven CREATE TABLE targets", ddl, "CREATE TABLE IF NOT EXISTS `heimdall`.`heimdall_", 7);
        ExpectCount("ddl: four REFERENCES targets", ddl, "REFERENCES `heimdall`.`heimdall_", 4);
        ExpectCount("ddl: eleven qualified names in total", ddl, "`heimdall`.`", 11);
        ExpectCount("ddl: fk_heimdall_event_ticket intact", ddl, "CONSTRAINT fk_heimdall_event_ticket\n", 1);
        ExpectCount("ddl: fk_heimdall_delivery_ticket intact", ddl, "CONSTRAINT fk_heimdall_delivery_ticket\n", 1);
        ExpectCount("ddl: fk_heimdall_attachment_ticket intact", ddl, "CONSTRAINT fk_heimdall_attachment_ticket\n", 1);
        ExpectCount("ddl: fk_heimdall_attachment_event intact", ddl, "CONSTRAINT fk_heimdall_attachment_event\n", 1);
        ExpectCount("ddl: no backquote leaked into a constraint name", ddl, "fk_`", 0);
        ExpectCount("ddl: no backquote leaked into an index name", ddl, "ix_`", 0);
        ExpectCount("ddl: no backquote leaked into a unique name", ddl, "uq_`", 0);
        ExpectCount("ddl: index names untouched", ddl, "KEY ix_heimdall_", 10);
        ExpectCount("ddl: unique names untouched", ddl, "UNIQUE KEY uq_heimdall_", 7);
    }
    Expect("REFERENCES with no space before the column list",
           Qualify("REFERENCES heimdall_ticket(id) ON DELETE CASCADE", "heimdall"),
           "REFERENCES `heimdall`.`heimdall_ticket`(id) ON DELETE CASCADE");

    // The database-name validator, which is what keeps the conf value from becoming SQL.
    ExpectBool("valid: heimdall", IsValidDatabaseName("heimdall"), true);
    ExpectBool("valid: acore_heimdall_2", IsValidDatabaseName("acore_heimdall_2"), true);
    ExpectBool("valid: dollar", IsValidDatabaseName("heimdall$prod"), true);
    ExpectBool("invalid: empty", IsValidDatabaseName(""), false);
    ExpectBool("invalid: backquote", IsValidDatabaseName("heim`dall"), false);
    ExpectBool("invalid: hyphen", IsValidDatabaseName("heimdall-db"), false);
    ExpectBool("invalid: space", IsValidDatabaseName("heimdall db"), false);
    ExpectBool("invalid: dot", IsValidDatabaseName("a.b"), false);
    ExpectBool("invalid: 65 chars", IsValidDatabaseName(std::string(65, 'a')), false);
    ExpectBool("valid: 64 chars", IsValidDatabaseName(std::string(64, 'a')), true);

    if (failures)
    {
        std::printf("%d failure(s)\n", failures);
        return 1;
    }

    std::printf("qualify_test: all checks passed\n");
    return 0;
}
