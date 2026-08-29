// GM command audit log.
//
// Every command attempt on the realm - typed in game, run from the console, or issued by the
// companion bot over SOAP - batched and shipped to an admin-only Discord channel through the
// module's existing delivery queue.
//
// This has nothing to do with tickets. It is off by default, and an install that never enables it
// registers no hook, provisions no channel and writes no rows. It is kept in its own translation
// unit, touching the rest of the module only through `mod_heimdall_shared.h`, so that a
// server wanting command auditing and no ticket system can be given one later.

#include "mod_heimdall_shared.h"

#include "AllCommandScript.h"
#include "Chat.h"
#include "Config.h"
#include "DatabaseEnv.h"
#include "GameTime.h"
#include "Player.h"
#include "SharedDefines.h"
#include "WorldSession.h"

#include <sstream>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace
{
using namespace Heimdall;

// Buffering matters: a busy realm runs a lot of commands, and one delivery row plus one Discord
// message per command would be unusable as a log and unkind to the rate limiter.
class CommandAuditLog
{
public:
    static CommandAuditLog* instance()
    {
        static CommandAuditLog log;
        return &log;
    }

    void Configure(std::string realmTag, uint32 batchSeconds, uint32 maxLines)
    {
        _realmTag = std::move(realmTag);
        _batchSeconds = batchSeconds;
        _maxLines = maxLines;
    }

    struct Entry
    {
        uint32 At = 0;
        std::string Actor;
        uint32 AccountId = 0;
        uint32 Security = 0;
        std::string Command;
    };

    void Record(Entry entry)
    {
        _pending.push_back(std::move(entry));
        if (_pending.size() >= _maxLines)
            Flush();
    }

    void Update(uint32 diff)
    {
        if (_pending.empty())
            return;

        _elapsed += diff;
        if (_elapsed < _batchSeconds * IN_MILLISECONDS)
            return;

        Flush();
    }

    void Flush()
    {
        _elapsed = 0;
        if (_pending.empty())
            return;

        // MySQL builds the JSON, so a command containing quotes or backslashes cannot produce a
        // malformed document however strange the operator's typing was.
        std::ostringstream entries;
        for (std::size_t i = 0; i < _pending.size(); ++i)
        {
            Entry const& entry = _pending[i];
            if (i)
                entries << ", ";

            entries << "JSON_OBJECT('at', " << entry.At
                << ", 'actor', '" << Escape(entry.Actor) << "'"
                << ", 'accountId', " << entry.AccountId
                << ", 'security', " << entry.Security
                << ", 'command', '" << Escape(entry.Command) << "')";
        }

        std::ostringstream rawKey;
        rawKey << "cmdaudit:" << _realmTag << ':' << GameTime::GetGameTime().count() << ':' << ++_sequence;

        // ticket_id is left NULL: this delivery is not about a ticket.
        CharacterDatabase.Execute(
            "INSERT IGNORE INTO heimdall_delivery "
            "(ticket_id, delivery_key, direction, kind, payload_json) "
            "VALUES (NULL, SHA2('{}', 256), 'to_discord', 'gm_command_audit', "
            "JSON_OBJECT('realmTag', '{}', 'entries', JSON_ARRAY({})))",
            Escape(rawKey.str()), Escape(_realmTag), entries.str());

        _pending.clear();
    }

private:
    std::vector<Entry> _pending;
    std::string _realmTag;
    uint32 _batchSeconds = 10;
    uint32 _maxLines = 25;
    uint32 _elapsed = 0;
    uint32 _sequence = 0;
};

class TicketCommandAuditScript final : public AllCommandScript
{
public:
    TicketCommandAuditScript() : AllCommandScript(SCRIPT_NAME, { ALLCOMMANDHOOK_ON_TRY_EXECUTE_COMMAND }) { }

    bool OnTryExecuteCommand(ChatHandler& handler, std::string_view cmdStr) override
    {
        Settings const& settings = CurrentSettings();
        if (!settings.enabled || !settings.commandAuditEnabled)
            return true;

        CommandAuditLog::Entry entry;
        entry.At = static_cast<uint32>(GameTime::GetGameTime().count());
        entry.Command.assign(cmdStr);

        if (WorldSession* session = handler.GetSession())
        {
            entry.AccountId = session->GetAccountId();
            entry.Security = session->GetSecurity();
            Player* player = session->GetPlayer();
            entry.Actor = player ? player->GetName() : "(no character)";
        }
        else
        {
            // Console and SOAP are indistinguishable here: SOAP queues its command through the
            // same CliCommandHolder path, with no session to attribute it to.
            entry.Actor = "Console";
            entry.Security = SEC_CONSOLE;
        }

        if (entry.Security < settings.commandAuditMinSecurity)
            return true;

        CommandAuditLog::instance()->Record(std::move(entry));
        return true;
    }
};
}

namespace Heimdall
{
void RegisterCommandAuditScript()
{
    // Config is loaded before scripts, so the operator's choice is readable here and an install
    // that leaves this off never constructs the hook.
    if (sConfigMgr->GetOption<bool>("Heimdall.CommandAuditEnabled", false))
        new TicketCommandAuditScript();
}

void ConfigureCommandAudit(std::string realmTag, uint32 batchSeconds, uint32 maxLines)
{
    CommandAuditLog::instance()->Configure(std::move(realmTag), batchSeconds, maxLines);
}

void UpdateCommandAudit(uint32 diff)
{
    CommandAuditLog::instance()->Update(diff);
}

void FlushCommandAudit()
{
    CommandAuditLog::instance()->Flush();
}
}
