// Heimdall's tables, created by the module itself.
//
// AzerothCore's SQL auto-import only targets the realm databases, and Heimdall's tables no longer
// live in one: they sit in a database of their own (Heimdall.Database) so the companion bot's
// MySQL account can be granted that database and nothing else. So the module carries its DDL
// (mod_heimdall_schema_ddl.h, a verbatim copy of deploy/heimdall-schema.sql) and runs it at
// startup on the core's characters connection, qualifying every table name with the database.
//
// Before it creates anything it looks for a 1.x install's tables in the characters database. If
// they are there and the new database is empty, this is an un-migrated upgrade and the module
// refuses to start: creating fresh tables next to the old ones would leave the operator with two
// sets and every existing ticket in the wrong one. deploy/migrate-to-heimdall-db.sql moves them.

#include "DatabaseEnv.h"
#include "Log.h"
#include "QueryResult.h"
#include "StringConvert.h"

#include "mod_heimdall_schema_ddl.h"
#include "mod_heimdall_shared.h"

#include <string>
#include <string_view>

namespace Heimdall
{
namespace
{
// Bumped when a later release changes the tables. A database stamped with a higher number than
// this was created by a newer module and is refused rather than guessed at.
constexpr uint32 SCHEMA_VERSION = 1;

std::string TableNameList()
{
    std::string list;
    for (std::string_view table : Sql::TABLES)
    {
        if (!list.empty())
            list += ", ";
        list += "'";
        list += table;
        list += "'";
    }
    return list;
}

// How many of Heimdall's tables exist in `schemaExpr`, which is either a quoted database name or
// the DATABASE() function. These queries name the tables inside string literals, which Qualify()
// leaves alone, so the whole statement can go straight to the connection.
uint32 CountTables(std::string const& schemaExpr)
{
    QueryResult result = CharacterDatabase.Query(
        "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = {} AND TABLE_NAME IN ({})",
        schemaExpr, TableNameList());
    return result ? (*result)[0].Get<uint32>() : 0;
}

bool SchemaExists(std::string const& escapedDatabase)
{
    QueryResult result = CharacterDatabase.Query(
        "SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '{}'", escapedDatabase);
    return result && (*result)[0].Get<uint32>() > 0;
}
}

std::string_view SchemaDdl()
{
    return Sql::SCHEMA_DDL;
}

bool EnsureSchema()
{
    std::string const& database = CurrentSettings().database;
    std::string const escapedDatabase = Escape(database);
    std::string const quotedDatabase = "'" + escapedDatabase + "'";

    // information_schema only shows a user the databases it has some privilege on, so "missing"
    // and "not granted" look the same from here. The fix is the same one-off SQL either way.
    if (!SchemaExists(escapedDatabase))
    {
        LOG_ERROR(LOG_FILTER, "Database `{}` does not exist, or the core's MySQL user has no rights on it. "
            "Create it and grant the core's user access - deploy/create-heimdall-database.sql does both - "
            "then restart. Bridge disabled.", database);
        return false;
    }

    uint32 const inCharacters = CountTables("DATABASE()");
    uint32 const inHeimdall = CountTables(quotedDatabase);

    if (inCharacters > 0 && inHeimdall == 0)
    {
        LOG_ERROR(LOG_FILTER, "Found {} Heimdall table(s) in the characters database and none in `{}`. This is a "
            "Heimdall 1.x install that has not been migrated. Nothing has been created or changed. Stop the "
            "worldserver and run deploy/migrate-to-heimdall-db.sql, which moves the tables and their data with "
            "RENAME TABLE, then start again. Bridge disabled.", inCharacters, database);
        return false;
    }

    if (inCharacters > 0)
    {
        LOG_WARN(LOG_FILTER, "{} Heimdall table(s) still exist in the characters database alongside the live "
            "ones in `{}`. The module ignores them. If they are leftovers from a migration or a rollback, "
            "check they hold nothing you need and drop them.", inCharacters, database);
    }

    // Statement by statement: the connection is not opened for multi-statement queries, and the
    // splitter drops the comment lines first (test/qualify_test.cpp checks it yields exactly the
    // seven CREATE TABLE statements from the real DDL).
    for (std::string const& statement : Sql::SplitStatements(Sql::SCHEMA_DDL))
        CharacterDatabase.DirectExecute(Q(statement));

    uint32 const present = CountTables(quotedDatabase);
    if (present != Sql::TABLES.size())
    {
        LOG_ERROR(LOG_FILTER, "After running the schema, `{}` holds {} of Heimdall's {} tables. The MySQL error is "
            "logged above under sql.sql; the usual cause is a grant on `{}` without CREATE, ALTER or REFERENCES. "
            "Bridge disabled.", database, present, uint32(Sql::TABLES.size()), database);
        return false;
    }

    QueryResult versionRow = CharacterDatabase.Query(
        Q("SELECT setting_value FROM heimdall_setting WHERE setting_key = 'schema.version'"));
    if (versionRow)
    {
        uint32 const stored = Acore::StringTo<uint32>((*versionRow)[0].Get<std::string>()).value_or(0);
        if (stored > SCHEMA_VERSION)
        {
            LOG_ERROR(LOG_FILTER, "`{}` is at Heimdall schema version {} but this module only knows version {}. "
                "It was created by a newer Heimdall; upgrade the module rather than running the old one against "
                "it. Bridge disabled.", database, stored, SCHEMA_VERSION);
            return false;
        }
    }
    else
    {
        CharacterDatabase.DirectExecute(
            Q("INSERT INTO heimdall_setting (setting_key, setting_value) VALUES ('schema.version', '{}')"),
            SCHEMA_VERSION);
    }

    LOG_INFO(LOG_FILTER, "Heimdall schema ready in `{}`: {} tables, schema version {} ({}).",
        database, present, SCHEMA_VERSION, inHeimdall == 0 ? "created on this start" : "already present");
    return true;
}
}
