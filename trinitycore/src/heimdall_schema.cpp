/*
 * Heimdall's tables, created by the module itself. Ported from src/mod_heimdall_schema.cpp.
 *
 * TrinityCore's SQL updater only targets the realm databases, and Heimdall's tables do not live in
 * one: they sit in a database of their own (Heimdall.Database) so the companion bot's MySQL
 * account can be granted that database and nothing else. So the module carries its DDL
 * (mod_heimdall_schema_ddl.h, a byte-identical copy of the AzerothCore module's header, which is
 * itself deploy/heimdall-schema.sql verbatim) and runs it at startup on the core's characters
 * connection, qualifying every table name with the database.
 *
 * Copyright (C) Calmoran. Licensed under the GNU AGPL v3 (see LICENSE at the repository root).
 */

#include "DatabaseEnv.h"
#include "Log.h"
#include "QueryResult.h"
#include "StringConvert.h"

#include "heimdall_shared.h"
#include "mod_heimdall_schema_ddl.h"

#include <string>
#include <string_view>

namespace Heimdall
{
namespace
{
// Bumped when a later release changes the tables. A database stamped with a higher number than
// this was created by a newer module and is refused rather than guessed at. The same number as the
// AzerothCore module's, because it is the same schema.
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

// How many of Heimdall's tables exist in `schemaExpr`, a quoted database name. This query names
// the tables inside string literals, which Qualify() leaves alone, so the whole statement can go
// straight to the connection.
uint32 CountTables(std::string const& schemaExpr)
{
    QueryResult result = CharacterDatabase.PQuery(
        "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = {} AND TABLE_NAME IN ({})",
        schemaExpr, TableNameList());
    return result ? (*result)[0].GetUInt32() : 0;
}

bool SchemaExists(std::string const& escapedDatabase)
{
    QueryResult result = CharacterDatabase.PQuery(
        "SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '{}'", escapedDatabase);
    return result && (*result)[0].GetUInt32() > 0;
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
        TC_LOG_ERROR(HEIMDALL_LOG, "Database `{}` does not exist, or the core's MySQL user has no rights on it. "
            "Create it and grant the core's user access - deploy/create-heimdall-database.sql does both - "
            "then restart. Bridge disabled.", database);
        return false;
    }

    // Counted before the DDL runs, so the startup line below can say whether this start created
    // the tables or found them already there.
    uint32 const existing = CountTables(quotedDatabase);

    // Statement by statement: the connection is not opened for multi-statement queries, and the
    // splitter drops the comment lines first (test/qualify_test.cpp checks it yields exactly the
    // seven CREATE TABLE statements from the real DDL).
    for (std::string const& statement : Sql::SplitStatements(Sql::SCHEMA_DDL))
    {
        std::string const qualified = Q(statement);
        CharacterDatabase.DirectExecute(qualified.c_str());
    }

    uint32 const present = CountTables(quotedDatabase);
    if (present != Sql::TABLES.size())
    {
        TC_LOG_ERROR(HEIMDALL_LOG, "After running the schema, `{}` holds {} of Heimdall's {} tables. The MySQL error is "
            "logged above under sql.sql; the usual cause is a grant on `{}` without CREATE, ALTER or REFERENCES. "
            "Bridge disabled.", database, present, uint32(Sql::TABLES.size()), database);
        return false;
    }

    std::string const versionSql = Q("SELECT setting_value FROM heimdall_setting WHERE setting_key = 'schema.version'");
    QueryResult versionRow = CharacterDatabase.Query(versionSql.c_str());
    if (versionRow)
    {
        uint32 const stored = Trinity::StringTo<uint32>((*versionRow)[0].GetString()).value_or(0);
        if (stored > SCHEMA_VERSION)
        {
            TC_LOG_ERROR(HEIMDALL_LOG, "`{}` is at Heimdall schema version {} but this module only knows version {}. "
                "It was created by a newer Heimdall; upgrade the module rather than running the old one against "
                "it. Bridge disabled.", database, stored, SCHEMA_VERSION);
            return false;
        }
    }
    else
    {
        std::string const stamp = Qf(
            "INSERT INTO heimdall_setting (setting_key, setting_value) VALUES ('schema.version', '{}')",
            SCHEMA_VERSION);
        CharacterDatabase.DirectExecute(stamp.c_str());
    }

    TC_LOG_INFO(HEIMDALL_LOG, "Heimdall schema ready in `{}`: {} tables, schema version {} ({}).",
        database, present, SCHEMA_VERSION, existing == 0 ? "created on this start" : "already present");
    return true;
}
}
