#ifndef MOD_HEIMDALL_SHARED_H
#define MOD_HEIMDALL_SHARED_H

#include "Define.h"

#include "mod_heimdall_qualify.h"

#include <string>
#include <string_view>

// The little that more than one translation unit of this module needs: the settings every part
// reads, string escaping for the SQL the module writes, and the entry points of the GM command
// audit log, which lives in its own file so it can become a standalone module later.
namespace Heimdall
{
constexpr char const* SCRIPT_NAME = "mod_heimdall";

// Dot-separated so it inherits the stock `Logger.module` entry in worldserver.conf. A bare
// category with no Logger entry falls back to Logger.root, which is ERROR-only by default and
// silently swallows every LOG_INFO this module emits.
constexpr char const* LOG_FILTER = "module.heimdall";

// Kept in step with the companion bot's package.json version: the two halves release together, so
// one number answers "which Heimdall are you running" for both.
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
    // One second, not five. The bot no longer reaches the realm over SOAP: a staff member pressing
    // Revive or Close queues a row that this poll picks up, so this interval is now the whole of
    // the delay between the button and the effect in game, not a background retry cadence.
    uint32 deliveryPollSeconds = 1;
    // Mirrors the bot's DELIVERY_MAX_ATTEMPTS. Both halves fail a job by the same rule so a job
    // the module gives up on is buried exactly as one the bot gives up on, and the bot's
    // dead-letter still fires.
    uint32 deliveryMaxAttempts = 12;
    uint32 maxWhisperBytes = 240;
    uint32 archiveRetentionDays = 180;
    std::string realmPrefix;
    std::string realmTag;
    std::string gmIdentities;
    // What the very first poll on a realm does with the ticket history already in gm_ticket:
    // "open", "none" or "all". Only ever consulted when no watermark row exists yet.
    std::string firstRunImport = "open";
    bool commandAuditEnabled = false;
    uint32 commandAuditMinSecurity = 1;
    uint32 commandAuditBatchSeconds = 10;
    uint32 commandAuditMaxLines = 25;
    uint32 contextRefreshSeconds = 60;
    // Whether whispers from a GM identity carry the client's <GM> chat badge. On by default: the
    // badge is a protocol flag a player character cannot forge, so it is both how a player knows
    // the reply is really from a Game Master and the one part of the exchange an impersonator
    // cannot reproduce. A server running an in-character support desk can turn it off.
    bool gmChatTag = true;
};

// Shared so the command-audit hook and the poller read the same configuration without one
// owning the other.
Settings& CurrentSettings();

std::string Escape(std::string value);

// Rewrites the bare heimdall_* table names in `sql` as `<Heimdall.Database>`.`heimdall_*`. Every
// statement the module sends that touches one of its own tables goes through this; statements
// against the realm's tables (characters, gm_ticket, account) do not, and are unchanged.
inline std::string Q(std::string_view sql)
{
    return Sql::Qualify(sql, CurrentSettings().database);
}

// --- Schema (mod_heimdall_schema.cpp) ------------------------------------------------------
// Creates Heimdall's tables in Heimdall.Database on the characters connection if they are not
// there yet, and records the schema version in heimdall_setting. Returns false, with the reason
// already logged, when the module must not run: the database is unreachable, a table could not be
// created, or the database is stamped with a schema version newer than this module knows.
bool EnsureSchema();

// The DDL the module runs, verbatim from deploy/heimdall-schema.sql (test/schema_drift.test.js
// in the bot keeps the two identical).
std::string_view SchemaDdl();

// --- GM command audit log (mod_heimdall_audit_log.cpp) -----------------------------------
// An optional extra, off by default, coupled to the rest of the module only through the shared
// delivery queue. Nothing in the ticket path calls into it beyond these four functions, so it can
// be lifted into a module of its own without untangling anything.

// Registers the command hook, but only when the operator has enabled the feature. With it off no
// hook exists at all, so there is nothing to notice and nothing to pay for.
void RegisterCommandAuditScript();

void ConfigureCommandAudit(std::string realmTag, uint32 batchSeconds, uint32 maxLines);
void UpdateCommandAudit(uint32 diff);
void FlushCommandAudit();

// --- Realm commands (mod_heimdall.cpp) ---------------------------------------------------
// Runs one command through the core's own parser and handlers and captures what it printed.
// This is the path SOAP takes minus the network: ACSoap queues a CliCommandHolder, which is a
// CliHandler, which is what this builds. Returns false when the command was refused, with the
// core's own reason in `output`.
bool RunRealmCommand(std::string const& command, std::string& output);
}

#endif
