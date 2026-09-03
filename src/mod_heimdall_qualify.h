#ifndef MOD_HEIMDALL_QUALIFY_H
#define MOD_HEIMDALL_QUALIFY_H

// Schema qualification for the module's SQL. Heimdall's seven tables live in their own database
// (Heimdall.Database, default "heimdall") while every query still runs on the core's characters
// connection, so each table name has to be written as `heimdall`.`heimdall_ticket`. Rather than
// spelling that at ~50 call sites, the SQL is written with bare names and passed through
// Qualify() once, which rewrites exactly those seven names and nothing else.
//
// This header deliberately depends on the standard library only: test/qualify_test.cpp compiles
// it on its own, outside the core's build, and that test is what guards the one way this can go
// wrong - matching a table name inside a longer identifier. Constraint and index names contain
// the table names (fk_heimdall_event_ticket, ix_heimdall_status), and a substring replace would
// turn the DDL into garbage. A name is only rewritten when neither neighbour is an identifier
// character, so `heimdall_event(` and ` heimdall_ticket ` are rewritten and
// `fk_heimdall_event_ticket` and `uq_heimdall_source` are not.

#include <array>
#include <string>
#include <string_view>

namespace Heimdall::Sql
{
constexpr std::array<std::string_view, 7> TABLES = {
    "heimdall_ticket",
    "heimdall_event",
    "heimdall_delivery",
    "heimdall_attachment",
    "heimdall_staff",
    "heimdall_setting",
    "heimdall_audit",
};

// MySQL's unquoted-identifier alphabet, plus the backquote and the dot so that a name that is
// already quoted or already qualified is left alone, plus the string quotes so that a table name
// inside a string literal ('heimdall_ticket' in an information_schema lookup) stays a string.
constexpr bool IsIdentifierChar(char c)
{
    return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
        || c == '_' || c == '$' || c == '`' || c == '.' || c == '\'' || c == '"';
}

// True when `database` is something MySQL accepts as a bare identifier, which is also the set of
// values that cannot smuggle anything into the statements this builds.
constexpr bool IsValidDatabaseName(std::string_view database)
{
    if (database.empty() || database.length() > 64)
        return false;

    for (char c : database)
        if (!((c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_' || c == '$'))
            return false;

    return true;
}

inline std::string Qualify(std::string_view sql, std::string_view database)
{
    std::string out;
    out.reserve(sql.size() + 64);

    std::size_t pos = 0;
    while (pos < sql.size())
    {
        std::size_t hit = sql.find("heimdall_", pos);
        if (hit == std::string_view::npos)
        {
            out.append(sql.substr(pos));
            break;
        }

        out.append(sql.substr(pos, hit - pos));

        std::string_view matched;
        if (hit == 0 || !IsIdentifierChar(sql[hit - 1]))
        {
            for (std::string_view table : TABLES)
            {
                if (sql.substr(hit, table.size()) != table)
                    continue;

                std::size_t after = hit + table.size();
                if (after < sql.size() && IsIdentifierChar(sql[after]))
                    continue;

                matched = table;
                break;
            }
        }

        if (matched.empty())
        {
            // Not a table name at a boundary: copy the prefix and carry on scanning after it.
            out.append("heimdall_");
            pos = hit + 9;
            continue;
        }

        out.push_back('`');
        out.append(database);
        out.append("`.`");
        out.append(matched);
        out.push_back('`');
        pos = hit + matched.size();
    }

    return out;
}
}

#endif
