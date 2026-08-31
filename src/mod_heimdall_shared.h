#ifndef MOD_HEIMDALL_SHARED_H
#define MOD_HEIMDALL_SHARED_H

#include "Define.h"

#include <string>

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
constexpr char const* HEIMDALL_VERSION = "0.9.1";

struct Settings
{
    bool enabled = false;
    uint32 ticketPollSeconds = 15;
    uint32 deliveryPollSeconds = 5;
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
}

#endif
