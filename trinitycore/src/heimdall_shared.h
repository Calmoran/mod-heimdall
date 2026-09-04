/*
 * Heimdall for TrinityCore - shared declarations.
 *
 * Copyright (C) Calmoran. Licensed under the GNU AGPL v3 (see LICENSE at the repository root).
 *
 * Reference implementation: src/mod_heimdall_shared.h at the repository root. Every deliberate
 * divergence from it carries a comment naming the core reason.
 */

#ifndef HEIMDALL_SHARED_H
#define HEIMDALL_SHARED_H

#include "Define.h"
#include "StringFormat.h"

#include "mod_heimdall_qualify.h"

#include <string>
#include <string_view>
#include <utility>

// The little that more than one translation unit of this port needs: the settings every part
// reads, string escaping for the SQL the module writes, and the schema entry points.
namespace Heimdall
{
constexpr char const* SCRIPT_NAME = "heimdall";

// DIVERGENCE (core): the AzerothCore module logs under "module.heimdall" so it inherits the stock
// Logger.module entry. TrinityCore has no such entry, and its stock Logger.root is at level 5
// (error), which would swallow every Info line this port writes - so the category is "heimdall"
// and heimdall.conf.dist ships the Logger.heimdall entry that makes it visible.
constexpr char const* HEIMDALL_LOG = "heimdall";

// Log output only. Kept in step with the companion bot's package.json and the AzerothCore
// HEIMDALL_VERSION: the halves release together, so one number answers "which Heimdall are you
// running" for all of them.
constexpr char const* HEIMDALL_VERSION = "2.0.0";

struct Settings
{
    bool enabled = false;
    // The database that holds Heimdall's seven tables. Not the realm's characters database: the
    // tables live in a schema of their own so the companion bot's MySQL account can be granted
    // rights on that schema and nothing else. Every query still runs on the core's characters
    // connection, with the table names qualified through Q() below.
    std::string database = "heimdall";
    uint32 ticketPollSeconds = 15;
    // One second, not five. A staff member pressing Revive or Close queues a row that this poll
    // picks up, so this interval is the whole of the delay between the button and the effect in
    // game, not a background retry cadence.
    uint32 deliveryPollSeconds = 1;
    // Mirrors the bot's DELIVERY_MAX_ATTEMPTS. Both halves fail a job by the same rule so a job
    // the module gives up on is buried exactly as one the bot gives up on.
    uint32 deliveryMaxAttempts = 12;
    uint32 archiveRetentionDays = 180;
    std::string realmPrefix;
    std::string realmTag;
    // What the very first poll on a realm does with the ticket history already in gm_ticket:
    // "open", "none" or "all". Only ever consulted when no watermark row exists yet.
    std::string firstRunImport = "open";
    // DIVERGENCE (core): no configuration key sets this on TrinityCore, so it is structurally
    // false. A faithful command audit needs a non-vetoable pre-command hook covering game, CLI and
    // SOAP, which this core does not offer without a third patch; shipping a switch that produced
    // partial attribution would be worse than shipping none. The code path is ported and intact so
    // that enabling it later is a config key, not a rewrite.
    bool commandAuditEnabled = false;
    uint32 contextRefreshSeconds = 60;

    // NOT PORTED IN PHASE 2, and deliberately absent rather than present-and-ignored:
    //   gmIdentities        - the consent list, meaningless until the identity registry exists
    //   maxWhisperBytes     - the whisper half of the delivery queue
    //   gmChatTag           - the <GM> badge on identity whispers
    // All three arrive in phase 3 with the code that gives them meaning.
};

// Shared so every part reads the same configuration without one owning the other.
Settings& CurrentSettings();

std::string Escape(std::string value);

// Rewrites the bare heimdall_* table names in `sql` as `<Heimdall.Database>`.`heimdall_*`. Every
// statement the module sends that touches one of its own tables goes through this; statements
// against the realm's tables (characters, gm_ticket, account) do not, and are unchanged.
inline std::string Q(std::string_view sql)
{
    return Sql::Qualify(sql, CurrentSettings().database);
}

// DIVERGENCE (core): on AzerothCore the qualified string is handed straight to
// CharacterDatabase.Query/Execute as the format string, because AC's formatted overloads take a
// runtime std::string_view. TrinityCore's PQuery/PExecute/DirectPExecute take
// Trinity::FormatString, an fmt::format_string checked at compile time - which a string built at
// runtime by Q() can never be. So the module formats first, through fmt's runtime entry point,
// and hands the core a finished statement.
//
// Every call site keeps the result in a named local and passes .c_str(), so the buffer plainly
// outlives the call. (It would in any case: TrinityCore's Execute(char const*) strdup()s the
// string inside BasicStatementTask's constructor, on the calling thread, before the task is
// enqueued - AdhocStatement.cpp:26-33. The named local is belt and braces, and it makes the
// lifetime visible at the call site rather than a fact you have to go and look up.)
template<typename... Args>
inline std::string Qf(std::string_view sql, Args&&... args)
{
    std::string const qualified = Q(sql);
    return Trinity::StringVFormat(qualified, Trinity::MakeFormatArgs(args...));
}

// --- Schema (heimdall_schema.cpp) ----------------------------------------------------------
// Creates Heimdall's tables in Heimdall.Database on the characters connection if they are not
// there yet, and records the schema version in heimdall_setting. Returns false, with the reason
// already logged, when the module must not run: the database is unreachable, a table could not be
// created, or the database is stamped with a schema version newer than this module knows.
bool EnsureSchema();

// The DDL the module runs, verbatim from deploy/heimdall-schema.sql (bot/test/schema-drift.test.js
// keeps the .sql, the AzerothCore header and this port's copy of it identical).
std::string_view SchemaDdl();

// --- Realm commands (heimdall.cpp) ---------------------------------------------------------
// Runs one command through the core's own parser and handlers and captures what it printed.
// Returns false when the command was refused, with the core's own reason in `output`.
bool RunRealmCommand(std::string const& command, std::string& output);
}

#endif // HEIMDALL_SHARED_H
