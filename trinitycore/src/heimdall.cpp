/*
 * Heimdall for TrinityCore - the ticket poller and the realm-bound half of the delivery queue.
 *
 * Copyright (C) Calmoran. Licensed under the GNU AGPL v3 (see LICENSE at the repository root).
 *
 * Ported from src/mod_heimdall.cpp, which is the reference implementation. This file is a port,
 * not a redesign: where it differs, a comment says which core behaviour forced it - search for
 * DIVERGENCE.
 *
 * It carries the whole bridge except the GM command audit, which needs a pre-command hook this
 * core does not have (heimdall_shared.h says why, and the places it would be called are marked
 * PHASE 4). One thing here is implemented but NOT proven: real-client takeover of a held identity,
 * in heimdall_login_watch at the bottom of this file.
 */

#include "AsyncCallbackProcessor.h"
#include "CharacterCache.h"
#include "Chat.h"
#include "Common.h"
#include "Config.h"
#include "DatabaseEnv.h"
#include "GameTime.h"
#include "Log.h"
#include "MySQLConnection.h"
#include "ObjectAccessor.h"
#include "ObjectMgr.h"
#include "Optional.h"
#include "Player.h"
#include "QueryResult.h"
#include "Realm.h"
#include "ScriptMgr.h"
#include "SharedDefines.h"
#include "Opcodes.h"
#include "StringConvert.h"
#include "Util.h"
#include "World.h"
#include "WorldPacket.h"
#include "WorldSession.h"

#include "heimdall_shared.h"
#include "mod_heimdall_command.h"

#include <algorithm>
#include <cctype>
#include <map>
#include <sstream>
#include <string>
#include <string_view>
#include <memory>
#include <unordered_map>
#include <unordered_set>
#include <vector>

using namespace Heimdall;

namespace Heimdall
{
// One instance for the whole module.
Settings& CurrentSettings()
{
    static Settings settings;
    return settings;
}

std::string Escape(std::string value)
{
    CharacterDatabase.EscapeString(value);
    return value;
}

namespace
{
// A console handler that keeps what the command printed instead of writing it to a terminal.
// The core replies to a refused command by printing the reason - "Ticket not found.", a syntax
// line - so this text is the only account of what happened, and it is what the delivery row and
// the Discord dead-letter end up quoting.
class CapturingCliHandler final : public CliHandler
{
public:
    CapturingCliHandler() : CliHandler(this, &CapturingCliHandler::Collect) { }

    [[nodiscard]] std::string const& Output() const { return _output; }

private:
    static void Collect(void* self, std::string_view text)
    {
        static_cast<CapturingCliHandler*>(self)->_output.append(text);
    }

    std::string _output;
};
}

// Deliberately the console path and not a private shortcut: the core's own parser resolves the
// command, the core's own handler performs it, and every rule it enforces still applies.
//
// The safety of this rests entirely on the caller: `command` is composed by PollGameCommands from
// a fixed set of actions, never from a string the bot supplied. That property is what makes a
// compromised bot unable to express ".ban" - not this function.
bool RunRealmCommand(std::string const& command, std::string& output)
{
    CapturingCliHandler handler;
    bool parsed = handler.ParseCommands(command);

    output = handler.Output();
    // Trim the trailing newlines CliHandler::SendSysMessage appends after every line.
    while (!output.empty() && (output.back() == '\n' || output.back() == '\r'))
        output.pop_back();

    // ParseCommands answers "was this text a command at all", which stays true for a command that
    // refused its arguments; the handler's error flag is what separates the two.
    return parsed && !handler.HasSentErrorMessage();
}
}

namespace
{

// Matches realm_tag VARCHAR(16). The automatic fallback tag needs four characters at most:
// worldserver refuses a RealmID above 255 (the client reads it as a uint8), so the widest fallback
// is "R255". The rest of the width is headroom for a hand-written prefix.
constexpr std::size_t REALM_TAG_MAX_LENGTH = 16;

// The companion bot mints its own Discord-sourced keys as DIS-000042. An in-game key of
// DIS-42 would not actually collide, but the ambiguity is not worth shipping.
constexpr char const* RESERVED_REALM_TAG = "DIS";

// How long a leased to_game job stays claimed before another pass may recover it.
constexpr uint32 DELIVERY_LEASE_SECONDS = 60;

// Matches ^[A-Za-z0-9]{1,16}$. Written out rather than using std::isalnum, which is locale
// dependent and would accept characters the key format cannot carry.
bool IsValidRealmTag(std::string_view tag)
{
    if (tag.empty() || tag.length() > REALM_TAG_MAX_LENGTH)
        return false;

    return std::all_of(tag.begin(), tag.end(), [](char c)
    {
        return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
    });
}

bool IsReservedRealmTag(std::string_view tag)
{
    return tag.length() == std::string_view(RESERVED_REALM_TAG).length()
        && std::equal(tag.begin(), tag.end(), RESERVED_REALM_TAG, [](char lhs, char rhs)
        {
            return std::tolower(static_cast<unsigned char>(lhs)) == std::tolower(static_cast<unsigned char>(rhs));
        });
}

Settings ReadSettings()
{
    // DIVERGENCE (core): AzerothCore's ConfigMgr has a template GetOption<T>; TrinityCore has
    // typed getters (GetBoolDefault / GetIntDefault / GetStringDefault) and no template. Same
    // keys, same defaults, same clamps - only the accessor differs.
    Settings settings;
    settings.enabled = sConfigMgr->GetBoolDefault("Heimdall.Enabled", false);
    settings.ticketPollSeconds = std::max<uint32>(1, uint32(sConfigMgr->GetIntDefault("Heimdall.TicketPollSeconds", 15)));
    settings.deliveryPollSeconds = std::max<uint32>(1, uint32(sConfigMgr->GetIntDefault("Heimdall.DeliveryPollSeconds", 1)));
    settings.deliveryMaxAttempts = std::clamp<uint32>(uint32(sConfigMgr->GetIntDefault("Heimdall.DeliveryMaxAttempts", 12)), 1, 100);
    settings.archiveRetentionDays = std::max<uint32>(1, uint32(sConfigMgr->GetIntDefault("Heimdall.ArchiveRetentionDays", 180)));
    settings.maxWhisperBytes = std::clamp<uint32>(uint32(sConfigMgr->GetIntDefault("Heimdall.MaxWhisperBytes", 240)), 32, 255);
    settings.realmPrefix = sConfigMgr->GetStringDefault("Heimdall.RealmPrefix", "");
    settings.gmIdentities = sConfigMgr->GetStringDefault("Heimdall.GmIdentities", "");
    settings.firstRunImport = sConfigMgr->GetStringDefault("Heimdall.FirstRunImport", "open");
    std::transform(settings.firstRunImport.begin(), settings.firstRunImport.end(), settings.firstRunImport.begin(),
        [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    if (settings.firstRunImport != "open" && settings.firstRunImport != "none" && settings.firstRunImport != "all")
    {
        TC_LOG_ERROR(HEIMDALL_LOG, "Heimdall.FirstRunImport \"{}\" is not one of open, none or all. Using \"open\".",
            settings.firstRunImport);
        settings.firstRunImport = "open";
    }
    settings.contextRefreshSeconds = std::max<uint32>(10, uint32(sConfigMgr->GetIntDefault("Heimdall.ContextRefreshSeconds", 15)));
    settings.gmChatTag = sConfigMgr->GetBoolDefault("Heimdall.GmChatTag", true);
    settings.database = sConfigMgr->GetStringDefault("Heimdall.Database", "heimdall");

    // Not read: the Heimdall.CommandAudit* family. There is no faithful audit hook on this core -
    // see Settings::commandAuditEnabled in heimdall_shared.h.

    // An operator who never reads the docs still gets working, realm-unique keys.
    settings.realmTag = settings.realmPrefix.empty()
        ? "R" + std::to_string(realm.Id.Realm)
        : settings.realmPrefix;

    return settings;
}

std::string EventKey(std::string const& realmTag, uint32 ticketId, uint32 modifiedTime, std::string_view eventType)
{
    std::ostringstream key;
    key << "ingame:" << realmTag << ':' << ticketId << ':' << modifiedTime << ':' << eventType;
    return key.str();
}

void RecordIngameTicket(std::string const& realmTag, uint32 ticketId, uint64 playerGuid, std::string const& playerName,
    std::string const& description, uint32 modifiedTime, bool completed, uint32 retentionDays)
{
    // The auth account behind the character, so ticket history and player notes follow the player
    // across alts. Read from the in-memory character cache rather than querying `characters`, and
    // never exposed to the bot's database grants.
    uint32 playerAccountId = playerGuid
        ? sCharacterCache->GetCharacterAccountIdByGuid(ObjectGuid::Create<HighGuid::Player>(playerGuid))
        : 0;

    std::string escapedRealmTag = Escape(realmTag);
    std::string escapedName = Escape(playerName);
    std::string escapedDescription = Escape(description);
    std::string escapedPublicKey = Escape(realmTag + "-" + std::to_string(ticketId));
    std::string escapedEventKey = Escape(EventKey(realmTag, ticketId, modifiedTime, completed ? "state" : "observed"));
    CharacterDatabaseTransaction transaction = CharacterDatabase.BeginTransaction();

    // gm_ticket is deliberately absent from every mutation below. Any lifecycle change is made by
    // the core's own .ticket handlers through the command channel, never by SQL.
    std::string const ticketSql = Qf(
        "INSERT INTO heimdall_ticket "
        "(source, realm_tag, source_ticket_id, source_modified_time, public_key, player_guid, player_account_id, player_name, category, status) "
        "VALUES ('ingame', '{}', {}, {}, '{}', {}, {}, '{}', 'support', IF({} = 1, 'closed', 'open')) "
        "ON DUPLICATE KEY UPDATE player_guid = VALUES(player_guid), player_name = VALUES(player_name), "
        "player_account_id = VALUES(player_account_id), "
        "source_modified_time = VALUES(source_modified_time), "
        "status = IF(VALUES(status) = 'closed', 'closed', status), "
        "closed_at = IF(VALUES(status) = 'closed', COALESCE(closed_at, CURRENT_TIMESTAMP), closed_at), "
        "transcript_expires_at = IF(VALUES(status) = 'closed', COALESCE(transcript_expires_at, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL {} DAY)), transcript_expires_at), "
        "version = version + 1",
        escapedRealmTag, ticketId, modifiedTime, escapedPublicKey, playerGuid, playerAccountId, escapedName,
        completed ? 1 : 0, retentionDays);
    transaction->Append(ticketSql.c_str());

    std::string const eventSql = Qf(
        "INSERT IGNORE INTO heimdall_event "
        "(ticket_id, event_key, event_type, actor_kind, actor_ref, payload_json) "
        "SELECT id, SHA2('{}', 256), '{}', 'player', '{}', JSON_OBJECT('description', '{}', 'modifiedTime', {}) "
        "FROM heimdall_ticket WHERE source = 'ingame' AND realm_tag = '{}' AND source_ticket_id = {}",
        escapedEventKey, completed ? "ingame_ticket_closed" : "ingame_ticket_observed",
        escapedName, escapedDescription, modifiedTime, escapedRealmTag, ticketId);
    transaction->Append(eventSql.c_str());

    std::string const deliverySql = Qf(
        "INSERT IGNORE INTO heimdall_delivery "
        "(ticket_id, delivery_key, direction, kind, payload_json) "
        "SELECT id, SHA2(CONCAT('{}', ':discord'), 256), 'to_discord', 'sync_ingame_ticket', "
        "JSON_OBJECT('realmTag', '{}', 'sourceTicketId', {}, 'playerName', '{}', 'description', '{}', 'completed', {}) "
        "FROM heimdall_ticket WHERE source = 'ingame' AND realm_tag = '{}' AND source_ticket_id = {}",
        escapedEventKey, escapedRealmTag, ticketId, escapedName, escapedDescription, completed ? 1 : 0,
        escapedRealmTag, ticketId);
    transaction->Append(deliverySql.c_str());

    CharacterDatabase.CommitTransaction(transaction);
}

// The whisper hook has to answer "does this player have an open ticket?" on the world thread for
// every whisper sent on the realm. The poller already sees every in-game ticket, so it maintains
// the answer here and the chat path never touches the database.
//
// TicketPlayerScript reads Find() and NextWhisperSequence() on the world thread for every whisper
// sent on the realm, which is why the answer is kept here rather than looked up in the database.
class OpenTicketIndex
{
public:
    static OpenTicketIndex* instance()
    {
        static OpenTicketIndex index;
        return &index;
    }

    void Track(uint64 playerGuid, uint32 sourceTicketId, bool completed)
    {
        if (!playerGuid)
            return;

        if (completed)
            _open.erase(playerGuid);
        else
            _open[playerGuid] = sourceTicketId;
    }

    // The core allows a player at most one open ticket, so this is unambiguous.
    [[nodiscard]] uint32 Find(uint64 playerGuid) const
    {
        auto itr = _open.find(playerGuid);
        return itr != _open.end() ? itr->second : 0;
    }

    void SetRealmTag(std::string tag) { _realmTag = std::move(tag); }
    [[nodiscard]] std::string const& GetRealmTag() const { return _realmTag; }

    [[nodiscard]] uint32 NextWhisperSequence() { return ++_whisperSequence; }

private:
    std::unordered_map<uint64, uint32> _open;
    std::string _realmTag;
    uint32 _whisperSequence = 0;
};

// Holds one real character per GM identity in-world with no game client attached, so that a
// whisper addressed to it is an ordinary valid whisper the core will route. The alternative -
// a virtual name - is rejected by the core before any script hook runs.
class IdentityRegistry
{
public:
    struct Identity
    {
        ObjectGuid Guid;
        uint32 AccountId = 0;
        WorldSession* Session = nullptr;     // null while logged out
    };

    static IdentityRegistry* instance()
    {
        static IdentityRegistry registry;
        return &registry;
    }

    // Resolves the configured names once at startup. A name that does not exist is warned about
    // and skipped; it must never stop the module loading.
    void Configure(std::string const& csv, std::string const& realmTag)
    {
        _realmTag = realmTag;

        for (std::string_view rawName : Trinity::Tokenize(csv, ',', false))
        {
            std::string name{ rawName };
            name.erase(name.begin(), std::find_if(name.begin(), name.end(), [](unsigned char c) { return std::isspace(c) == 0; }));
            name.erase(std::find_if(name.rbegin(), name.rend(), [](unsigned char c) { return std::isspace(c) == 0; }).base(), name.end());

            if (name.empty())
                continue;

            if (!normalizePlayerName(name))
            {
                TC_LOG_WARN(HEIMDALL_LOG, "GmIdentities entry \"{}\" is not a usable character name; skipping it.", name);
                continue;
            }

            CharacterCacheEntry const* cache = sCharacterCache->GetCharacterCacheByName(name);
            if (!cache)
            {
                TC_LOG_WARN(HEIMDALL_LOG, "GmIdentities names character \"{}\", which does not exist on this realm; skipping it.", name);
                continue;
            }

            _identities[name] = Identity{ cache->Guid, cache->AccountId, nullptr };

            PublishState(name, false);

            TC_LOG_INFO(HEIMDALL_LOG, "GM identity \"{}\" resolved to account {} ({}).", name, cache->AccountId, cache->Guid.ToString());
        }

        PublishConfigured();

        // An empty list is the shipped default, and it used to say nothing at all - the only trace
        // was "0 GM identity(ies)" at the end of a line that otherwise reads like success. Every
        // new install starts in this state, so it gets its own line.
        if (_identities.empty())
        {
            TC_LOG_WARN(HEIMDALL_LOG, "No GM identities are configured, so nobody can whisper a player from "
                "Discord and no GM identity can be logged in. Set Heimdall.GmIdentities in "
                "heimdall.conf to a character that exists on this realm, then restart the worldserver.");
        }
    }

    // The bot cannot see heimdall.conf, so a GM name typed into /ticket staff-add was only a format
    // check and a typo surfaced much later as a refusal. Publishing the names that survived the
    // resolution above lets the bot refuse the typo at the moment it is made.
    void PublishConfigured() const
    {
        std::string names;
        for (auto const& entry : _identities)
        {
            if (!names.empty())
                names += ",";
            names += entry.first;
        }

        std::string const sql = Qf(
            "INSERT INTO heimdall_setting (setting_key, setting_value) VALUES ('{}', '{}') "
            "ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)",
            Escape("ingame.gm_identities." + _realmTag), Escape(names));
        CharacterDatabase.Execute(sql.c_str());
    }

    [[nodiscard]] bool IsConfigured() const { return !_identities.empty(); }

    // Invoked once per world tick; a completed login runs its continuation here rather than on the
    // database thread.
    void Update()
    {
        _loginCallbacks.ProcessReadyCallbacks();
    }

    // Asking for a state the system is already in is success, not failure: a caller that wanted
    // the identity online gets exactly that.
    bool Login(std::string name, std::string& message)
    {
        if (!normalizePlayerName(name))
        {
            message = "Invalid character name.";
            return false;
        }

        auto itr = _identities.find(name);
        if (itr == _identities.end())
        {
            message = Trinity::StringFormat("{} is not a configured GM identity.", name);
            return false;
        }

        if (itr->second.Session)
        {
            message = Trinity::StringFormat("{} is already held; nothing to do.", name);
            return true;
        }

        if (_pending.count(itr->second.Guid))
        {
            message = Trinity::StringFormat("A login for {} is already in flight; nothing to do.", name);
            return true;
        }

        // Never disturb somebody who is actually playing. A misconfigured identity pointing at a
        // live account must refuse, not kick.
        uint32 accountId = itr->second.AccountId;
        if (sWorld->FindSession(accountId))
        {
            message = Trinity::StringFormat("Account {} is connected right now - refusing to touch it.", accountId);
            return false;
        }

        // DIVERGENCE (core): AzerothCore also asks sWorldSessionMgr->FindOfflineSession(), which
        // names the state of a session that has left the session map while its player is still
        // finishing its exit. This core keeps no offline-session registry at all (World.h declares
        // FindSession and nothing else), so that half of the defence has no equivalent and is NOT
        // silently replaced: the check below is the only thing that sees a character still on its
        // way out, and only once the player object has actually left ObjectAccessor. The residual
        // window is documented in trinitycore/README.md.
        if (ObjectAccessor::FindPlayerByName(name))
        {
            message = Trinity::StringFormat("{} is already in the world - refusing to touch it.", name);
            return false;
        }

        ObjectGuid guid = itr->second.Guid;
        std::shared_ptr<LoginQueryHolder> holder = std::make_shared<LoginQueryHolder>(accountId, guid);
        if (!holder->Initialize())
        {
            message = "Could not build the character login query holder.";
            return false;
        }

        _pending.insert(guid);

        // Our own callback queue, pumped from the poller's OnUpdate.
        //
        // The core's own login path uses the session's queue, but there is no session yet at this
        // point - one is created in FinishLogin once the character data has actually loaded.
        _loginCallbacks.AddCallback(CharacterDatabase.DelayQueryHolder(holder))
            .AfterComplete([name, accountId, guid](SQLQueryHolderBase const& queryHolder)
            {
                IdentityRegistry::instance()->FinishLogin(name, accountId, guid, static_cast<LoginQueryHolder const&>(queryHolder));
            });

        message = Trinity::StringFormat("login for {} queued.", name);
        return true;
    }

    bool Logout(std::string name, std::string& message)
    {
        if (!normalizePlayerName(name))
        {
            message = "Invalid character name.";
            return false;
        }

        auto itr = _identities.find(name);
        if (itr == _identities.end())
        {
            message = Trinity::StringFormat("{} is not a configured GM identity.", name);
            return false;
        }

        // Already released is the state the caller asked for, so this is success.
        if (!itr->second.Session)
        {
            message = Trinity::StringFormat("{} is not currently held; nothing to do.", name);
            return true;
        }

        Release(name, itr->second);
        message = Trinity::StringFormat("{} logged out.", name);
        return true;
    }

    void LogoutAll()
    {
        for (auto& [name, identity] : _identities)
            if (identity.Session)
                Release(name, identity);
    }

    [[nodiscard]] bool IsHeld(ObjectGuid guid) const
    {
        return _heldGuids.count(guid) != 0;
    }

    [[nodiscard]] Player* GetHeldPlayer(std::string name) const
    {
        if (!normalizePlayerName(name))
            return nullptr;

        auto itr = _identities.find(name);
        return itr != _identities.end() && itr->second.Session ? itr->second.Session->GetPlayer() : nullptr;
    }

    [[nodiscard]] std::map<std::string, Identity> const& GetAll() const { return _identities; }

    // A real client logging in on an identity's account is not blocked by the core: a socketless
    // session is not in the session map, so the duplicate-session check never sees it.
    //
    // DIVERGENCE (core): AzerothCore calls this from OnPlayerLoadFromDB, inside Player::LoadFromDB
    // and still ahead of ObjectAccessor::AddObject. This core has no such hook, so the caller is a
    // ServerScript on CMSG_PLAYER_LOGIN instead (heimdall_login_watch, below), which runs EARLIER
    // still - before the core has read the packet at all. The body is unchanged.
    void YieldTo(ObjectGuid incoming, WorldSession* incomingSession)
    {
        if (!IsHeld(incoming))
            return;

        for (auto& [name, identity] : _identities)
        {
            if (identity.Guid != incoming || !identity.Session)
                continue;

            if (identity.Session == incomingSession)
                return;                                     // our own headless login, still loading

            TC_LOG_WARN(HEIMDALL_LOG, "A client is logging in as GM identity \"{}\"; releasing the headless session so the "
                "player keeps the character.", name);
            Release(name, identity);
            return;
        }
    }

private:
    void FinishLogin(std::string const& name, uint32 accountId, ObjectGuid guid, LoginQueryHolder const& holder)
    {
        _pending.erase(guid);

        auto itr = _identities.find(name);
        if (itr == _identities.end())
            return;

        // Re-checked after the async holder completed: the window between Login() and here is
        // exactly where a real client can arrive. (No FindOfflineSession on this core - see the
        // divergence note in Login().)
        if (sWorld->FindSession(accountId))
        {
            TC_LOG_ERROR(HEIMDALL_LOG, "Account {} acquired a session while loading GM identity \"{}\"; aborting.", accountId, name);
            return;
        }

        // Socketless session. SEC_GAMEMASTER because GM invisibility keys off the session's
        // security level, not off the GM-mode flag; nothing is written to the account.
        //
        // DIVERGENCE (core): the constructor differs from AzerothCore's - this core takes an
        // rvalue account name and a Minutes timezone offset, and has no skip-queue or total-time
        // arguments. The shape below is the one the T10 spike proved.
        WorldSession* session = new WorldSession(accountId, "", nullptr, SEC_GAMEMASTER,
            EXPANSION_WRATH_OF_THE_LICH_KING, time_t(0), Minutes(0), sWorld->GetDefaultDbcLocale(), 0, false);

        session->HandlePlayerLogin(holder);

        Player* player = session->GetPlayer();
        if (!player)
        {
            TC_LOG_ERROR(HEIMDALL_LOG, "Could not load GM identity \"{}\" ({}) from the database.", name, guid.ToString());
            session->LogoutPlayer(false);
            delete session;
            return;
        }

        // ORDER MATTERS ON THIS CORE, AND DIFFERENTLY FROM AZEROTHCORE.
        // Player::SetGMVisible(false) here also calls SetAcceptWhispers(false) and
        // SetGameMaster(true) (Player.cpp:2305-2313). That is this core's rule - a GM who hides
        // also stops taking whispers - not a defect, but it means AzerothCore's order
        // (accept-whispers, GM, invisible) leaves the identity refusing whispers, and a player
        // whispering it is told "no player named X is currently playing". An identity that is
        // invisible AND accepts whispers is a combination the core never sets up on its own, so
        // it has to be asked for in this order.
        player->SetGameMaster(true);
        player->SetGMVisible(false);
        player->SetAcceptWhispers(true);            // after SetGMVisible, never before
        // The <GM> chat badge. GM mode and GM chat are separate in the core - `.gm on` drives
        // invisibility and immunities, `.gm chat on` drives the flag GetChatTag() reads - and
        // without the second one an identity's whispers look like any other player's. The badge is
        // rendered by the client from a protocol flag a player character cannot forge, so it is how
        // a player knows the reply is really from a Game Master. Session-only, like the three calls
        // above; nothing reaches the character save.
        player->SetGMChat(CurrentSettings().gmChatTag);

        itr->second.Session = session;
        _heldGuids.insert(guid);
        PublishState(name, true);

        // The four flags are read back off the player rather than assumed, because the order they
        // were set in is the whole point (see above).
        TC_LOG_INFO(HEIMDALL_LOG, "GM identity \"{}\" ({}) is held in-world on account {}: gameMaster={} invisible={} acceptWhispers={} gmChat={}.",
            name, guid.ToString(), accountId, player->IsGameMaster(), !player->isGMVisible(),
            player->isAcceptWhispers(), player->isGMChat());
    }

    // The companion bot shows whether a GM is reachable in game. It reads that from the existing
    // settings table rather than parsing console output, so the state survives a bot restart and
    // needs no schema of its own.
    void PublishState(std::string const& name, bool held) const
    {
        std::string const sql = Qf(
            "INSERT INTO heimdall_setting (setting_key, setting_value) VALUES ('{}', '{}') "
            "ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)",
            Escape("identity.state." + _realmTag + "." + name), held ? "held" : "offline");
        CharacterDatabase.Execute(sql.c_str());
    }

    void Release(std::string const& name, Identity& identity)
    {
        WorldSession* session = identity.Session;
        if (!session)
            return;

        // Clear our tracking first: LogoutPlayer fires the logout hooks, which can re-enter here.
        identity.Session = nullptr;
        _heldGuids.erase(identity.Guid);

        // Nothing is undone before the save, because there is nothing to undo: the GM flags live in
        // m_ExtraFlags, which is never written to the character, and the login path re-establishes
        // all four on every hold. Outbound packets during logout are safe on a socketless session -
        // WorldSession::SendPacket returns early when m_Socket is null (WorldSession.cpp:207-212).
        session->LogoutPlayer(true);
        delete session;
        PublishState(name, false);

        TC_LOG_INFO(HEIMDALL_LOG, "GM identity \"{}\" ({}) released.", name, identity.Guid.ToString());
    }

    std::map<std::string, Identity> _identities;
    std::unordered_set<ObjectGuid> _heldGuids;
    std::unordered_set<ObjectGuid> _pending;
    AsyncCallbackProcessor<SQLQueryHolderCallback> _loginCallbacks;
    std::string _realmTag;
};

void PublishPlayerContext(std::string const& realmTag, uint32 sourceTicketId, uint64 playerGuidLow, bool forced)
{
    if (!playerGuidLow)
        return;

    ObjectGuid guid = ObjectGuid::Create<HighGuid::Player>(playerGuidLow);
    CharacterCacheEntry const* cache = sCharacterCache->GetCharacterCacheByGuid(guid);
    if (!cache)
        return;

    Player* online = ObjectAccessor::FindConnectedPlayer(guid);

    uint32 level = online ? online->GetLevel() : cache->Level;
    uint32 zoneId = online ? online->GetZoneId() : 0;
    uint32 totalPlaytime = 0;
    uint32 lastLogout = 0;

    // Zone and playtime for an offline character only exist in the characters table.
    if (QueryResult row = CharacterDatabase.PQuery(
        "SELECT zone, totaltime, logout_time FROM characters WHERE guid = {}", playerGuidLow))
    {
        Field* fields = row->Fetch();
        if (!online)
            zoneId = fields[0].GetUInt16();
        totalPlaytime = fields[1].GetUInt32();
        lastLogout = fields[2].GetUInt32();
    }

    uint32 accountCreated = 0;
    if (QueryResult row = LoginDatabase.PQuery(
        "SELECT UNIX_TIMESTAMP(joindate) FROM account WHERE id = {}", cache->AccountId))
    {
        accountCreated = row->Fetch()[0].GetUInt32();
    }

    std::string escapedRealmTag = Escape(realmTag);
    std::ostringstream rawKey;
    rawKey << "ingame:" << realmTag << ':' << sourceTicketId << ":context";

    uint32 capturedAt = uint32(GameTime::GetGameTime());

    // Queued BEFORE the snapshot is overwritten, because the comparison is against what Discord
    // was last shown. capturedAt is deliberately not part of it - it changes on every sweep, so
    // comparing it would make every sweep a change - but it IS part of the delivery key, so each
    // real change is its own row and a repeat within the same second collapses onto it.
    std::ostringstream rawDeliveryKey;
    rawDeliveryKey << "ingame:" << realmTag << ':' << sourceTicketId << ":context-updated:" << capturedAt;

    // INSERT IGNORE, like the two other delivery inserts in this file, rather than an upsert: the
    // SELECT joins two tables that both carry a ticket_id, so the no-op assignment an upsert needs
    // is ambiguous and MySQL refuses the whole statement (ERROR 1052). Found by running it.
    std::string const contextDelivery = Qf(
        "INSERT IGNORE INTO heimdall_delivery "
        "(ticket_id, delivery_key, direction, kind, payload_json) "
        "SELECT t.id, SHA2('{}', 256), 'to_discord', 'context_updated', "
        "JSON_OBJECT('realmTag', '{}', 'sourceTicketId', {}) "
        "FROM heimdall_ticket t "
        "LEFT JOIN heimdall_event e ON e.ticket_id = t.id AND e.event_type = 'player_context' "
        "WHERE t.source = 'ingame' AND t.realm_tag = '{}' AND t.source_ticket_id = {} "
        "AND ({} = 1 OR e.id IS NULL "
        "OR JSON_EXTRACT(e.payload_json, '$.online') <> {} "
        "OR JSON_EXTRACT(e.payload_json, '$.zoneId') <> {} "
        "OR JSON_EXTRACT(e.payload_json, '$.level') <> {} "
        "OR JSON_UNQUOTE(JSON_EXTRACT(e.payload_json, '$.name')) <> '{}')",
        Escape(rawDeliveryKey.str()), escapedRealmTag, sourceTicketId, escapedRealmTag, sourceTicketId,
        forced ? 1 : 0, online ? 1 : 0, zoneId, level, Escape(cache->Name));
    CharacterDatabase.Execute(contextDelivery.c_str());

    std::string const contextEvent = Qf(
        "INSERT INTO heimdall_event "
        "(ticket_id, event_key, event_type, actor_kind, actor_ref, payload_json) "
        "SELECT id, SHA2('{}', 256), 'player_context', 'system', '{}', "
        "JSON_OBJECT('name', '{}', 'level', {}, 'class', {}, 'race', {}, 'gender', {}, "
        "'zoneId', {}, 'online', {}, 'accountId', {}, 'accountCreated', {}, "
        "'totalPlaytime', {}, 'lastLogout', {}, 'capturedAt', {}) "
        "FROM heimdall_ticket WHERE source = 'ingame' AND realm_tag = '{}' AND source_ticket_id = {} "
        "ON DUPLICATE KEY UPDATE payload_json = VALUES(payload_json)",
        Escape(rawKey.str()), Escape(cache->Name), Escape(cache->Name), level, uint32(cache->Class), uint32(cache->Race),
        uint32(cache->Sex), zoneId, online ? 1 : 0, cache->AccountId, accountCreated, totalPlaytime, lastLogout,
        capturedAt, escapedRealmTag, sourceTicketId);
    CharacterDatabase.Execute(contextEvent.c_str());
}

class TicketPoller final : public WorldScript
{
public:
    TicketPoller() : WorldScript(SCRIPT_NAME) { }

    void OnStartup() override
    {
        _settings = ReadSettings();
        if (!_settings.enabled)
        {
            TC_LOG_INFO(HEIMDALL_LOG, "Heimdall {} for TrinityCore: the bridge is DISABLED. "
                "Set Heimdall.Enabled = 1 in heimdall.conf to turn it on.", HEIMDALL_VERSION);
            return;
        }

        if (!IsValidRealmTag(_settings.realmTag))
        {
            // Refuse to run rather than write keys that could collide with another realm.
            _settings.enabled = false;

            if (_settings.realmPrefix.empty())
                TC_LOG_ERROR(HEIMDALL_LOG, "Heimdall.RealmPrefix is blank and the fallback tag derived from RealmID {} "
                    "(\"{}\") is longer than {} characters. Set an explicit RealmPrefix of 1-{} letters or digits. Bridge disabled.",
                    realm.Id.Realm, _settings.realmTag, uint32(REALM_TAG_MAX_LENGTH), uint32(REALM_TAG_MAX_LENGTH));
            else
                TC_LOG_ERROR(HEIMDALL_LOG, "Heimdall.RealmPrefix \"{}\" is invalid: it must match ^[A-Za-z0-9]{{1,{}}}$. "
                    "Bridge disabled so it cannot write ticket keys that collide with another realm.",
                    _settings.realmPrefix, uint32(REALM_TAG_MAX_LENGTH));

            return;
        }

        if (IsReservedRealmTag(_settings.realmTag))
        {
            _settings.enabled = false;

            TC_LOG_ERROR(HEIMDALL_LOG, "Heimdall.RealmPrefix \"{}\" is reserved: \"{}\" is how the companion bot labels "
                "Discord-created tickets, so in-game keys must not use it. Choose a different prefix. Bridge disabled.",
                _settings.realmPrefix, RESERVED_REALM_TAG);

            return;
        }

        // The value goes into SQL as a quoted identifier, so it is checked against MySQL's bare
        // identifier alphabet before anything is built from it. It must also differ from the
        // characters database: the point of the separate schema is that the bot's grants can stop
        // at its edge, and a module told to put its tables back in the realm's database would
        // silently undo that boundary.
        if (!Sql::IsValidDatabaseName(_settings.database))
        {
            _settings.enabled = false;

            TC_LOG_ERROR(HEIMDALL_LOG, "Heimdall.Database \"{}\" is not a valid database name: it must be 1-64 characters "
                "of letters, digits, _ or $. Bridge disabled.", _settings.database);

            return;
        }

        if (MySQLConnectionInfo const* info = CharacterDatabase.GetConnectionInfo(); info && info->database == _settings.database)
        {
            _settings.enabled = false;

            TC_LOG_ERROR(HEIMDALL_LOG, "Heimdall.Database \"{}\" is the realm's characters database. Heimdall's tables "
                "belong in a database of their own so the companion bot can be granted access to nothing else. "
                "Bridge disabled.", _settings.database);

            return;
        }

        if (!EnsureSchema())
        {
            _settings.enabled = false;
            return;
        }

        OpenTicketIndex::instance()->SetRealmTag(_settings.realmTag);
        // PHASE 4: ConfigureCommandAudit() goes here on the AzerothCore side. This core has no
        // faithful pre-command hook, so there is no audit to configure (heimdall_shared.h).
        bool const firstRun = !LoadWatermark();
        if (firstRun)
            SeedFirstRun();
        else
            LoadImportFloor();

        SeedSeenTickets();
        IdentityRegistry::instance()->Configure(_settings.gmIdentities, _settings.realmTag);
        PublishCommandChannel();

        if (firstRun)
        {
            TC_LOG_INFO(HEIMDALL_LOG, "Heimdall {} enabled for realm tag \"{}\"; gm_ticket polling is read-only. "
                "First run: seeded a new watermark with import mode \"{}\" and {} GM identity(ies).",
                HEIMDALL_VERSION, _settings.realmTag, _settings.firstRunImport,
                uint32(IdentityRegistry::instance()->GetAll().size()));
        }
        else
        {
            TC_LOG_INFO(HEIMDALL_LOG, "Heimdall {} enabled for realm tag \"{}\"; gm_ticket polling is read-only. "
                "Resuming at watermark {} with {} known ticket(s) and {} GM identity(ies).",
                HEIMDALL_VERSION, _settings.realmTag, _watermark, uint32(_seen.size()),
                uint32(IdentityRegistry::instance()->GetAll().size()));
        }

        // A rebuild regenerates heimdall.conf from the .dist and silently returns every option to
        // its shipped default, so anything the operator switched on deliberately switches itself
        // off. Stating the resolved set here makes a reverted config something an operator can see
        // in the log rather than something they discover when the evidence is missing.
        TC_LOG_INFO(HEIMDALL_LOG, "Resolved configuration: GM chat tag {}, ticket poll {}s, delivery poll {}s, "
            "whisper limit {} bytes, archive retention {} day(s), command audit unavailable on this core. These are "
            "the values in effect; if one is not what you set, check that a rebuild has not restored heimdall.conf "
            "from the .dist.",
            _settings.gmChatTag ? "on" : "off", _settings.ticketPollSeconds, _settings.deliveryPollSeconds,
            _settings.maxWhisperBytes, _settings.archiveRetentionDays);

        WarnAboutForeignRealmTags();
    }

    // The realm tag keys everything - the watermark, the identity state, every ticket - so
    // changing Heimdall.RealmPrefix on a live install makes the next start a "first run" under
    // the new tag: open tickets get re-imported with duplicate Discord channels, and their old
    // records are orphaned where the poller never reads them again.
    //
    // Deliberately a warning rather than a refusal, even for stranded OPEN tickets. Refusing
    // would turn stranded history into a bridge outage - no tickets at all reach Discord until
    // someone does database surgery - which punishes players for an operator's config change.
    void WarnAboutForeignRealmTags()
    {
        std::string const sql = Qf(
            "SELECT realm_tag, SUM(status IN ('open', 'claimed', 'closing')), COUNT(*) "
            "FROM heimdall_ticket WHERE source = 'ingame' AND realm_tag <> '{}' GROUP BY realm_tag",
            Escape(_settings.realmTag));
        QueryResult rows = CharacterDatabase.Query(sql.c_str());
        if (!rows)
            return;

        do
        {
            Field* fields = rows->Fetch();
            std::string tag = fields[0].GetString();
            uint64 openCount = fields[1].GetUInt64();
            uint64 total = fields[2].GetUInt64();

            // The leading newline is not decoration: on the console appender these arrive welded to
            // the end of whatever the core printed last, which buries the loudest warning the
            // module has.
            if (openCount)
            {
                TC_LOG_ERROR(HEIMDALL_LOG, "\n{} OPEN ticket(s) exist under realm tag \"{}\", but this install is "
                    "configured as \"{}\". They are STRANDED: only \"{}\" is polled, so they will never "
                    "update or close from the game again. If the prefix change was unintentional, restore "
                    "Heimdall.RealmPrefix and restart; if it was deliberate, close the stranded tickets from "
                    "Discord. RealmPrefix is chosen once at install and must not change afterwards.",
                    openCount, tag, _settings.realmTag, _settings.realmTag);
            }
            else
            {
                TC_LOG_WARN(HEIMDALL_LOG, "\n{} closed ticket(s) exist under realm tag \"{}\" (this install is "
                    "configured as \"{}\"). History only - nothing is stranded - but it means the realm "
                    "tag changed at some point, which is not supported.",
                    total, tag, _settings.realmTag);
            }
        } while (rows->NextRow());
    }

    void OnShutdownInitiate(ShutdownExitCode /*code*/, ShutdownMask /*mask*/) override
    {
        // PHASE 4: FlushCommandAudit() goes here on the AzerothCore side.
        // Release every held identity while the world is still up, so the characters are saved and
        // logged out properly rather than disappearing with the process.
        IdentityRegistry::instance()->LogoutAll();
    }

    void OnUpdate(uint32 diff) override
    {
        if (!_settings.enabled)
            return;

        IdentityRegistry::instance()->Update();
        PollDeliveries(diff);
        PollGameCommands(diff);
        SweepPlayerContext(diff);

        _ticketElapsed += diff;
        if (_ticketElapsed < _settings.ticketPollSeconds * IN_MILLISECONDS)
            return;
        _ticketElapsed = 0;

        // Three ways a row can be worth reading.
        //
        // 1. At or after the watermark: new tickets, and tickets whose text changed.
        // 2. Still open in gm_ticket: re-read every pass, because neither SetClosedBy nor
        //    SetCompleted touches lastModifiedTime, so a closure never moves a row past the
        //    watermark on its own. Load-bearing; do not simplify it.
        // 3. Still open as far as the BRIDGE is concerned. This closes a gap that clauses 1 and 2
        //    cannot: the moment a ticket is closed in game it stops satisfying clause 2, and its
        //    lastModifiedTime never moved, so unless it happens to be the most recently modified
        //    ticket on the realm it also fails clause 1. The closure is then never observed at all -
        //    silently, and permanently, because nothing ever revisits that row.
        //
        //    Reconciling against heimdall_ticket rather than an in-memory set is deliberate: it is
        //    the bridge's own record of what it believes is unfinished, it survives a restart, and
        //    it is the same table SeedSeenTickets already reads.
        //
        // All three clauses hold on this core for the same reasons: TicketMgr's setters are
        // orthogonal (close sets type, complete sets completed) and only SetMessage moves
        // lastModifiedTime - TicketMgr.cpp:217-235 and 381-403.
        std::string const pollSql = Qf(
            "SELECT Id, playerGuid, name, description, lastModifiedTime, completed, type "
            "FROM gm_ticket WHERE type IN (0, 1, 2) AND (lastModifiedTime >= {} OR (completed = 0 AND type = 0) "
            "  OR Id IN (SELECT source_ticket_id FROM heimdall_ticket "
            "            WHERE source = 'ingame' AND realm_tag = '{}' AND source_ticket_id IS NOT NULL "
            "              AND status IN ('open', 'claimed', 'closing'))) "
            "ORDER BY Id",
            _watermark, Escape(_settings.realmTag));
        QueryResult rows = CharacterDatabase.Query(pollSql.c_str());
        if (!rows)
            return;

        uint32 previousWatermark = _watermark;
        uint32 examined = 0;
        uint32 written = 0;

        do
        {
            Field* fields = rows->Fetch();
            uint32 ticketId = fields[0].GetUInt32();
            uint32 modifiedTime = fields[4].GetUInt32();
            ++examined;

            // Only ever non-zero when this realm started with FirstRunImport = none. Applied here
            // rather than in the query so the poll filter itself stays exactly as it was.
            if (ticketId <= _importFloor)
                continue;

            // Both columns have to be consulted. The core carries two independent closure signals,
            // and each GM command writes only one of them:
            //   .ticket close    -> CloseTicket -> SetClosedBy -> `type` = TICKET_TYPE_CLOSED
            //   .ticket complete -> SetCompleted -> `completed` = 1, leaving `type` open
            // A player abandoning a ticket, and character deletion, also go through SetClosedBy.
            bool completed = fields[5].GetUInt8() != 0 || fields[6].GetUInt8() != 0;

            _watermark = std::max(_watermark, modifiedTime);

            // Suppress the write when nothing observable moved since the last poll. An idle server
            // re-reads the open tickets every interval and writes nothing.
            uint64 playerGuid = fields[1].GetUInt64();
            TrackOpenTicket(playerGuid, ticketId, completed);

            auto [itr, inserted] = _seen.try_emplace(ticketId, TicketState{ modifiedTime, completed });
            if (!inserted)
            {
                if (itr->second.ModifiedTime == modifiedTime && itr->second.Completed == completed)
                    continue;

                itr->second = TicketState{ modifiedTime, completed };
            }

            std::string const playerName = fields[2].GetString();
            TC_LOG_DEBUG(HEIMDALL_LOG, "Poll recorded ticket {} for \"{}\" (modified {}, closed {}).",
                ticketId, playerName, modifiedTime, completed ? 1 : 0);

            RecordIngameTicket(_settings.realmTag, ticketId, playerGuid, playerName,
                fields[3].GetString(), modifiedTime, completed, _settings.archiveRetentionDays);
            ++written;
        } while (rows->NextRow());

        TC_LOG_DEBUG(HEIMDALL_LOG, "Poll finished: {} row(s) examined, {} written, watermark {}.",
            examined, written, _watermark);

        if (_watermark != previousWatermark)
            SaveWatermark();
    }

private:
    struct TicketState
    {
        uint32 ModifiedTime = 0;
        bool Completed = false;
    };

    [[nodiscard]] std::string WatermarkKey() const
    {
        return "ingame.watermark." + _settings.realmTag;
    }

    // Returns false when this realm has never polled. The absence of the row is the signal, not an
    // empty ticket table: an operator who deletes their tickets has not asked to re-import history.
    bool LoadWatermark()
    {
        std::string const sql = Qf(
            "SELECT setting_value FROM heimdall_setting WHERE setting_key = '{}'", Escape(WatermarkKey()));
        QueryResult result = CharacterDatabase.Query(sql.c_str());
        if (!result)
            return false;

        if (Optional<uint32> stored = Trinity::StringTo<uint32>((*result)[0].GetString()))
            _watermark = *stored;

        return true;
    }

    [[nodiscard]] std::string ImportFloorKey() const
    {
        return "ingame.import_floor." + _settings.realmTag;
    }

    void LoadImportFloor()
    {
        std::string const sql = Qf(
            "SELECT setting_value FROM heimdall_setting WHERE setting_key = '{}'", Escape(ImportFloorKey()));
        QueryResult result = CharacterDatabase.Query(sql.c_str());
        if (!result)
            return;

        if (Optional<uint32> stored = Trinity::StringTo<uint32>((*result)[0].GetString()))
            _importFloor = *stored;
    }

    void SaveImportFloor() const
    {
        std::string const sql = Qf(
            "INSERT INTO heimdall_setting (setting_key, setting_value) VALUES ('{}', '{}') "
            "ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)",
            Escape(ImportFloorKey()), _importFloor);
        CharacterDatabase.Execute(sql.c_str());
    }

    // The first poll on a realm decides what to do with the history already sitting in gm_ticket.
    // Left to the ordinary filter it would import all of it, and the bot would open a Discord
    // channel per ticket - thousands of them on an established realm, which is a rate-limit wall
    // and hours of hand-deleting.
    //
    // "open" and "all" need no floor: with the watermark seeded to now, a closed ticket matches
    // neither half of the poll filter. "none" does, because the filter's second clause matches
    // every open ticket on every poll by design - that is what makes a closure visible - so
    // without a floor those tickets would arrive on the next start instead.
    void SeedFirstRun()
    {
        uint32 const now = static_cast<uint32>(GameTime::GetGameTime());

        if (_settings.firstRunImport == "all")
        {
            _watermark = 0;
            SaveWatermark();
            TC_LOG_INFO(HEIMDALL_LOG, "First run for realm tag \"{}\": Heimdall.FirstRunImport is \"all\", so every "
                "ticket in gm_ticket will be imported and given a Discord channel.", _settings.realmTag);
            return;
        }

        _watermark = now;

        if (_settings.firstRunImport == "none")
        {
            QueryResult highest = CharacterDatabase.Query("SELECT COALESCE(MAX(Id), 0) FROM gm_ticket");
            _importFloor = highest ? (*highest)[0].GetUInt32() : 0;
            SaveImportFloor();
        }

        SaveWatermark();

        uint32 open = 0;
        if (QueryResult counted = CharacterDatabase.PQuery(
            "SELECT COUNT(*) FROM gm_ticket WHERE completed = 0 AND type = 0 AND Id > {}", _importFloor))
        {
            open = (*counted)[0].GetUInt32();
        }

        if (_settings.firstRunImport == "none")
        {
            TC_LOG_INFO(HEIMDALL_LOG, "First run for realm tag \"{}\": starting empty at watermark {}. Ticket ids up to "
                "{} are ignored; anything filed after that is picked up normally.",
                _settings.realmTag, _watermark, _importFloor);
        }
        else
        {
            TC_LOG_INFO(HEIMDALL_LOG, "First run for realm tag \"{}\": seeded watermark {} and importing {} open "
                "ticket(s). Closed history stays in gm_ticket and gets no Discord channel.",
                _settings.realmTag, _watermark, open);
        }
    }

    void SaveWatermark() const
    {
        std::string const sql = Qf(
            "INSERT INTO heimdall_setting (setting_key, setting_value) VALUES ('{}', '{}') "
            "ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)",
            Escape(WatermarkKey()), _watermark);
        CharacterDatabase.Execute(sql.c_str());
    }

    // Rebuilds the poll state from what this realm already recorded, so a restart does not rewrite
    // every live ticket just to discover nothing changed.
    void SeedSeenTickets()
    {
        std::string const sql = Qf(
            "SELECT source_ticket_id, source_modified_time, status, player_guid FROM heimdall_ticket "
            "WHERE source = 'ingame' AND realm_tag = '{}'",
            Escape(_settings.realmTag));
        QueryResult result = CharacterDatabase.Query(sql.c_str());
        if (!result)
            return;

        do
        {
            Field* fields = result->Fetch();
            std::string status = fields[2].GetString();
            bool completed = status == "closed" || status == "cancelled";
            uint32 ticketId = fields[0].GetUInt32();

            _seen[ticketId] = TicketState{ fields[1].GetUInt32(), completed };
            TrackOpenTicket(fields[3].GetUInt64(), ticketId, completed);
        } while (result->NextRow());
    }

    void TrackOpenTicket(uint64 playerGuid, uint32 ticketId, bool completed)
    {
        OpenTicketIndex::instance()->Track(playerGuid, ticketId, completed);
    }

    // Leases to_game jobs for this realm and delivers each as a whisper from the assigned identity.
    // A job whose identity is not held, or whose target is offline, is left untouched and simply
    // retried next tick - it is not a failure, just a precondition not met yet.
    void PollDeliveries(uint32 diff)
    {
        _deliveryElapsed += diff;
        if (_deliveryElapsed < _settings.deliveryPollSeconds * IN_MILLISECONDS)
            return;
        _deliveryElapsed = 0;

        if (!IdentityRegistry::instance()->IsConfigured())
            return;

        std::string escapedRealmTag = Escape(_settings.realmTag);

        // Recover anything a previous run leased and never finished.
        std::string const recoverSql = Qf(
            "UPDATE heimdall_delivery d "
            "JOIN heimdall_ticket t ON t.id = d.ticket_id "
            "SET d.state = 'queued', d.lease_owner = NULL, d.leased_until = NULL "
            "WHERE d.direction = 'to_game' AND d.state = 'leased' AND d.leased_until < CURRENT_TIMESTAMP "
            "AND t.realm_tag = '{}'",
            escapedRealmTag);
        CharacterDatabase.Execute(recoverSql.c_str());

        // MySQL does the JSON parsing so the module needs no JSON dependency.
        // t.player_guid is selected here and is what the whisper is aimed at: the payload does not
        // carry a name, and the module would not read one if it did.
        std::string const leaseSql = Qf(
            "SELECT d.id, d.ticket_id, d.kind, t.source_ticket_id, t.player_guid, t.player_name, "
            "JSON_UNQUOTE(JSON_EXTRACT(d.payload_json, '$.gmName')), "
            "JSON_UNQUOTE(JSON_EXTRACT(d.payload_json, '$.text')), d.attempts "
            "FROM heimdall_delivery d "
            "JOIN heimdall_ticket t ON t.id = d.ticket_id "
            "WHERE d.direction = 'to_game' AND d.state = 'queued' AND d.available_at <= CURRENT_TIMESTAMP "
            "AND t.realm_tag = '{}' ORDER BY d.id LIMIT 20",
            escapedRealmTag);
        QueryResult rows = CharacterDatabase.Query(leaseSql.c_str());
        if (!rows)
            return;

        // Ordering matters per ticket: once one job for a ticket cannot go out, every later job
        // for the same ticket has to wait behind it.
        std::unordered_set<uint64> blockedTickets;

        do
        {
            Field* fields = rows->Fetch();
            uint64 deliveryId = fields[0].GetUInt64();
            uint64 ticketId = fields[1].GetUInt64();
            std::string kind = fields[2].GetString();
            uint32 sourceTicketId = fields[3].GetUInt32();
            uint64 rowPlayerGuid = fields[4].GetUInt64();
            std::string ticketPlayerName = fields[5].GetString();
            std::string gmName = fields[6].GetString();
            std::string text = fields[7].GetString();
            uint32 attemptsAfter = fields[8].GetUInt32() + 1;

            if (blockedTickets.count(ticketId))
                continue;

            // A GM asking "are they online right now?" - answer immediately rather than waiting
            // for the next context sweep.
            if (kind == "refresh_player_context")
            {
                PublishPlayerContext(_settings.realmTag, sourceTicketId, rowPlayerGuid, true);
                std::string const doneSql = Qf(
                    "UPDATE heimdall_delivery SET state = 'delivered', delivered_at = CURRENT_TIMESTAMP, "
                    "attempts = attempts + 1, lease_owner = '{}' WHERE id = {} AND state = 'queued'",
                    Escape(LeaseOwner()), deliveryId);
                CharacterDatabase.Execute(doneSql.c_str());
                continue;
            }

            // A ticket opened in Discord has no character behind it, so there is nobody on the
            // realm this could be whispered to. That is a permanent condition, not a player who
            // happens to be offline, so it is refused with a reason rather than left to retry for
            // eighty minutes and die as an unexplained dead letter.
            if (!rowPlayerGuid)
            {
                FailGameCommand(deliveryId, kind, ticketId, attemptsAfter,
                    "This ticket has no character on the realm, so an in-game whisper cannot reach it.");
                continue;
            }

            Player* speaker = IdentityRegistry::instance()->GetHeldPlayer(gmName);
            // By GUID, not by name. The GUID is the module's own record of whose ticket this is;
            // any name in the payload is whatever the row said.
            Player* target = ObjectAccessor::FindConnectedPlayer(ObjectGuid::Create<HighGuid::Player>(rowPlayerGuid));

            if (!speaker || !target || text.empty())
            {
                blockedTickets.insert(ticketId);
                continue;
            }

            // Lease first so a crash mid-delivery leaves a recoverable row rather than a silent loss.
            std::string const claimSql = Qf(
                "UPDATE heimdall_delivery SET state = 'leased', attempts = attempts + 1, "
                "lease_owner = '{}', leased_until = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL {} SECOND) "
                "WHERE id = {} AND state = 'queued'",
                Escape(LeaseOwner()), DELIVERY_LEASE_SECONDS, deliveryId);
            CharacterDatabase.Execute(claimSql.c_str());

            // The core's own API, which sends the whisper to the target AND the sender's inform
            // copy, applies the identity's chat tag, and fires the chat hook. Nothing is hand-built.
            speaker->Whisper(text, LANG_UNIVERSAL, target);

            std::string const doneSql = Qf(
                "UPDATE heimdall_delivery SET state = 'delivered', delivered_at = CURRENT_TIMESTAMP, "
                "leased_until = NULL WHERE id = {}",
                deliveryId);
            CharacterDatabase.Execute(doneSql.c_str());

            TC_LOG_INFO(HEIMDALL_LOG, "Delivered ticket reply from \"{}\" to \"{}\" (delivery {}).",
                gmName, ticketPlayerName, deliveryId);
        } while (rows->NextRow());
    }

    // Leases this realm's queued command rows, composes each from the fixed switch, runs it through
    // the core's own handlers and records what the realm said.
    void PollGameCommands(uint32 diff)
    {
        _gameCommandElapsed += diff;
        if (_gameCommandElapsed < _settings.deliveryPollSeconds * IN_MILLISECONDS)
            return;
        _gameCommandElapsed = 0;

        std::string escapedRealmTag = Escape(_settings.realmTag);

        // Recover rows a previous run of this worldserver left stranded in 'leased'.
        std::string const recoverSql = Qf(
            "UPDATE heimdall_delivery SET state = 'queued', lease_owner = NULL, leased_until = NULL "
            "WHERE direction = 'soap' AND state = 'leased' AND leased_until < CURRENT_TIMESTAMP "
            "AND JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.realmTag')) = '{}'",
            escapedRealmTag);
        CharacterDatabase.Execute(recoverSql.c_str());

        // The JOIN is the gate, not a convenience. Without it a hand-written row needs no real
        // ticket, not even one belonging to this realm, and the target comes out of its own JSON.
        // A row that does not resolve to a ticket of THIS realm returns nothing here, and the
        // sweep below dead-letters it so it cannot sit queued forever unexplained.
        //
        // The payload's realmTag check is kept as well, deliberately. It is redundant against
        // t.realm_tag, and that is the point: the lease-recovery statement above has no ticket to
        // join, so keeping both means the two statements agree about which rows are this realm's.
        std::string const leaseSql = Qf(
            "SELECT d.id, d.kind, d.attempts, d.ticket_id, "
            "t.source_ticket_id, t.public_key, t.player_name, t.player_guid, "
            "JSON_UNQUOTE(JSON_EXTRACT(d.payload_json, '$.action')), "
            "JSON_UNQUOTE(JSON_EXTRACT(d.payload_json, '$.gmName')), "
            "JSON_UNQUOTE(JSON_EXTRACT(d.payload_json, '$.destination')), "
            "JSON_UNQUOTE(JSON_EXTRACT(d.payload_json, '$.causedBy')) "
            "FROM heimdall_delivery d "
            "JOIN heimdall_ticket t ON t.id = d.ticket_id "
            "WHERE d.direction = 'soap' AND d.state = 'queued' AND d.available_at <= CURRENT_TIMESTAMP "
            "AND t.realm_tag = '{}' "
            "AND JSON_UNQUOTE(JSON_EXTRACT(d.payload_json, '$.realmTag')) = '{}' "
            "ORDER BY d.id LIMIT 20",
            escapedRealmTag, escapedRealmTag);
        QueryResult rows = CharacterDatabase.Query(leaseSql.c_str());

        RefuseUnattachedCommands(escapedRealmTag);

        if (!rows)
            return;

        do
        {
            Field* fields = rows->Fetch();
            uint64 deliveryId = fields[0].GetUInt64();
            std::string kind = fields[1].GetString();
            // The lease below adds one. Everything downstream uses that post-lease number, because
            // reading it back would race the lease: CharacterDatabase.Execute is asynchronous, so a
            // Query issued straight after it can still see the row as it was.
            uint32 attemptsAfter = fields[2].GetUInt32() + 1;
            uint64 ticketId = fields[3].GetUInt64();

            // WHO, and WHICH TICKET, from the module's own row. Never from the payload.
            Heimdall::Command::TicketTarget target;
            target.sourceTicketId = fields[4].GetUInt32();
            target.publicKey = fields[5].GetString();
            target.playerName = fields[6].GetString();
            target.playerGuid = fields[7].GetUInt64();

            // WHAT to do, from the payload. gmName is here rather than in the ticket because it is
            // gated by consent elsewhere: the identity registry only acts for characters the
            // operator listed in Heimdall.GmIdentities, so a forged name resolves to no held
            // identity. .ticket assign is additionally refused by the core's own handler for any
            // name without RBAC_PERM_COMMANDS_BE_ASSIGNED_TICKET.
            std::string action = fields[8].GetString();
            std::string gmName = fields[9].GetString();
            std::string destination = fields[10].GetString();
            std::string causedBy = fields[11].GetString();

            // Lease before performing, so a crash mid-command leaves a recoverable row rather than
            // a command whose fate nobody knows.
            std::string const claimSql = Qf(
                "UPDATE heimdall_delivery SET state = 'leased', attempts = attempts + 1, "
                "lease_owner = '{}', leased_until = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL {} SECOND) "
                "WHERE id = {} AND state = 'queued'",
                Escape(LeaseOwner()), DELIVERY_LEASE_SECONDS, deliveryId);
            CharacterDatabase.Execute(claimSql.c_str());

            std::string command;
            std::string refusal;
            if (!Heimdall::Command::Compose(kind, action, target, gmName, destination, command, refusal))
            {
                FailGameCommand(deliveryId, kind, ticketId, attemptsAfter, refusal);
                continue;
            }

            std::string output;
            bool succeeded = RunRealmCommand(command, output);

            // A handler that returns true having done nothing is the trap the bot learned the hard
            // way: ".ticket close" on an unknown id answers "Ticket not found." and reports
            // success. The reply text is screened for the markers below.
            if (succeeded && LooksLikeRefusal(output))
                succeeded = false;

            if (!succeeded)
            {
                FailGameCommand(deliveryId, kind, ticketId, attemptsAfter,
                    output.empty() ? ("The realm refused \"" + command + "\".") : output);
                continue;
            }

            std::string const doneSql = Qf(
                "UPDATE heimdall_delivery SET state = 'delivered', delivered_at = CURRENT_TIMESTAMP, "
                "leased_until = NULL, last_error = NULL WHERE id = {}",
                deliveryId);
            CharacterDatabase.Execute(doneSql.c_str());

            AttributeGameCommand(command, causedBy);
            TC_LOG_INFO(HEIMDALL_LOG, "Ran \"{}\" for delivery {}.", command, deliveryId);
        } while (rows->NextRow());
    }

    // Command composition and its validators live in mod_heimdall_command.h - the AzerothCore
    // module's own header, compiled here unchanged (bot/test/schema-drift.test.js asserts the two
    // copies are byte-identical). That header holds the rule this path follows: the payload says
    // WHAT to do, the module's own ticket row says WHO it is done to.

    // A queued command row claiming this realm that has no ticket of this realm behind it. Without
    // this it would simply never be selected - queued forever, never run, never failed, never
    // explained, which is a worse way to be secure. It is marked dead with a reason a human can
    // act on.
    //
    // Deliberately matched on the payload's realmTag: a row with no ticket has nothing else to say
    // whose realm it belongs to, and a row pointing at another realm's ticket is that realm's
    // business to refuse, not ours to reach across and mark.
    void RefuseUnattachedCommands(std::string const& escapedRealmTag)
    {
        std::string const sql = Qf(
            "UPDATE heimdall_delivery d "
            "LEFT JOIN heimdall_ticket t ON t.id = d.ticket_id AND t.realm_tag = '{}' "
            "SET d.state = 'dead', d.attempts = d.attempts + 1, "
            "d.last_error = 'Refused: this command row has no ticket on this realm behind it. "
            "Heimdall takes the target of every command from its own ticket row, so a row without "
            "one cannot be performed.' "
            "WHERE d.direction = 'soap' AND d.state = 'queued' "
            "AND d.available_at <= CURRENT_TIMESTAMP "
            "AND JSON_UNQUOTE(JSON_EXTRACT(d.payload_json, '$.realmTag')) = '{}' "
            "AND t.id IS NULL",
            escapedRealmTag, escapedRealmTag);
        CharacterDatabase.Execute(sql.c_str());
    }

    // The markers the bot screened SOAP replies with. Identical to the AzerothCore module's set,
    // but checked against THIS core rather than assumed: every id below was read from
    // src/server/game/Miscellaneous/Language.h and every string from the trinity_string rows the
    // installed world database holds for it.
    //
    //   "not found"              2005 LANG_COMMAND_TICKETNOTEXIST     "Ticket not found."
    //   "does not exist"         6    LANG_CMD_INVALID                "Command '%.*s' does not exist"
    //   "incorrect syntax"       10   LANG_CMD_SYNTAX                 "Incorrect syntax."
    //   "invalid name specified" 2012 LANG_COMMAND_TICKETASSIGNERROR_A "Invalid name specified. ..."
    //   "already assigned"       2007 LANG_COMMAND_TICKETALREADYASSIGNED "Ticket %d is already assigned."
    //                            2013 LANG_COMMAND_TICKETASSIGNERROR_B  "This ticket is already assigned to yourself. ..."
    //   "syntax:"                the usage line the command tables print
    //   "no such"                generic coverage; not a ticket phrase on this core
    //   "cannot be assigned"     not a phrase on this core either; kept as defensive coverage
    //
    // Two of this core's ticket refusals match no marker: 2016 "Cannot close ticket %d, it is
    // assigned to another GM." and 2015 "You cannot unassign tickets from staff members with a
    // higher security level than yourself." Both are also unmatched by the AzerothCore module's
    // identical set, and neither is reachable from here: each is guarded by
    // handler->GetSession() being non-null (TC cs_ticket.cpp:120-126, AC cs_ticket.cpp:132-137),
    // and a CliHandler has no session, so the console path Heimdall uses never reaches them.
    // Left alone deliberately - the marker set is the same on both cores, and closing a latent gap
    // on one of them only is how two products start to drift. It is written up in the phase 2
    // report as a change for both halves.
    static bool LooksLikeRefusal(std::string const& output)
    {
        std::string lowered = output;
        std::transform(lowered.begin(), lowered.end(), lowered.begin(),
            [](unsigned char c) { return static_cast<char>(std::tolower(c)); });

        for (char const* marker : { "not found", "does not exist", "invalid name specified",
            "cannot be assigned", "already assigned", "no such", "syntax:", "incorrect syntax" })
        {
            if (lowered.find(marker) != std::string::npos)
                return true;
        }
        return false;
    }

    // Fails a job the way the bot fails one: the same attempt count, the same backoff, the same
    // rule for when it is dead. Then it queues the announcement, because the ticket channel is the
    // bot's to write in.
    //
    // Every value here is computed rather than read back. CharacterDatabase.Execute is asynchronous:
    // a Query issued after it can still see the row as it was.
    void FailGameCommand(uint64 deliveryId, std::string const& kind, uint64 ticketId, uint32 attempts,
        std::string const& reason)
    {
        bool dead = attempts >= _settings.deliveryMaxAttempts;

        std::string const failSql = Qf(
            "UPDATE heimdall_delivery SET state = '{}', "
            "available_at = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL LEAST(900, POW(2, {}) * 5) SECOND), "
            "leased_until = NULL, last_error = LEFT('{}', 512) WHERE id = {}",
            dead ? "dead" : "queued", attempts, Escape(reason), deliveryId);
        CharacterDatabase.Execute(failSql.c_str());

        TC_LOG_WARN(HEIMDALL_LOG, "Delivery {} ({}) failed on attempt {}{}: {}", deliveryId, kind, attempts,
            dead ? " and was given up on" : "", reason);

        std::ostringstream rawKey;
        rawKey << "trouble:" << _settings.realmTag << ':' << deliveryId << ':' << attempts;

        std::string const troubleSql = Qf(
            "INSERT IGNORE INTO heimdall_delivery (ticket_id, delivery_key, direction, kind, payload_json) "
            "VALUES ({}, SHA2('{}', 256), 'to_discord', 'delivery_trouble', "
            "JSON_OBJECT('realmTag', '{}', 'ofKind', '{}', 'state', '{}', 'attempts', {}, 'error', '{}'))",
            ticketId ? std::to_string(ticketId) : std::string("NULL"), Escape(rawKey.str()),
            Escape(_settings.realmTag), Escape(kind), dead ? "dead" : "queued", attempts, Escape(reason));
        CharacterDatabase.Execute(troubleSql.c_str());
    }

    // The realm logs every command this module runs as "Console" - a CliHandler has no session to
    // attribute. This posts the half the realm cannot know: which Discord user asked for it.
    //
    // Structurally unreachable on this core: commandAuditEnabled has no configuration key here
    // (heimdall_shared.h says why). Ported and kept whole so that the day this core grows a
    // faithful pre-command hook, enabling it is a config key rather than a rewrite.
    void AttributeGameCommand(std::string const& command, std::string const& causedBy)
    {
        if (!_settings.commandAuditEnabled)
            return;

        std::ostringstream rawKey;
        rawKey << "attrib:" << _settings.realmTag << ':' << GameTime::GetGameTime() << ':' << command << ':' << causedBy;

        std::string const sql = Qf(
            "INSERT IGNORE INTO heimdall_delivery (ticket_id, delivery_key, direction, kind, payload_json) "
            "VALUES (NULL, SHA2('{}', 256), 'to_discord', 'command_attribution', "
            "JSON_OBJECT('realmTag', '{}', 'command', '{}', 'causedBy', {}))",
            Escape(rawKey.str()), Escape(_settings.realmTag), Escape(command),
            causedBy.empty() ? std::string("NULL") : ("'" + Escape(causedBy) + "'"));
        CharacterDatabase.Execute(sql.c_str());
    }

    // Tells the bot that this realm's commands are performed by the module, so it does not need a
    // SOAP account. The bot reads this at startup: absent means an older worldserver that cannot
    // lease intent rows.
    void PublishCommandChannel() const
    {
        std::string const sql = Qf(
            "INSERT INTO heimdall_setting (setting_key, setting_value) VALUES ('{}', '{}') "
            "ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)",
            Escape("runtime.command_channel." + _settings.realmTag), Escape(std::string(HEIMDALL_VERSION)));
        CharacterDatabase.Execute(sql.c_str());
    }

    [[nodiscard]] std::string LeaseOwner() const
    {
        return "worldserver:" + _settings.realmTag;
    }

    // Keeps context reasonably fresh even if nobody presses Refresh. The online indicator is what
    // needs to be current, and that has the refresh button.
    void SweepPlayerContext(uint32 diff)
    {
        _contextElapsed += diff;
        if (_contextElapsed < _settings.contextRefreshSeconds * IN_MILLISECONDS)
            return;
        _contextElapsed = 0;

        std::string const sql = Qf(
            "SELECT source_ticket_id, player_guid FROM heimdall_ticket "
            "WHERE source = 'ingame' AND realm_tag = '{}' AND status IN ('open', 'claimed', 'closing') "
            "AND player_guid IS NOT NULL LIMIT 50",
            Escape(_settings.realmTag));
        QueryResult rows = CharacterDatabase.Query(sql.c_str());
        if (!rows)
            return;

        do
        {
            Field* fields = rows->Fetch();
            PublishPlayerContext(_settings.realmTag, fields[0].GetUInt32(), fields[1].GetUInt64(), false);
        } while (rows->NextRow());
    }

    Settings& _settings = CurrentSettings();
    uint32 _ticketElapsed = 0;
    uint32 _deliveryElapsed = 0;
    uint32 _gameCommandElapsed = 0;
    uint32 _contextElapsed = 0;
    uint32 _watermark = 0;
    std::unordered_map<uint32, TicketState> _seen;
    uint32 _importFloor = 0;
};
// Records an inbound player whisper against their open ticket and queues it for Discord.
void RecordPlayerWhisper(std::string const& realmTag, uint32 sourceTicketId, std::string const& playerName,
    std::string const& identityName, std::string const& text, uint32 sequence)
{
    std::string escapedRealmTag = Escape(realmTag);
    std::string escapedPlayerName = Escape(playerName);
    std::string escapedIdentityName = Escape(identityName);
    std::string escapedText = Escape(text);

    std::ostringstream rawKey;
    rawKey << "ingame:" << realmTag << ':' << sourceTicketId << ":whisper:"
        << GameTime::GetGameTime() << ':' << sequence;
    std::string escapedEventKey = Escape(rawKey.str());

    CharacterDatabaseTransaction transaction = CharacterDatabase.BeginTransaction();

    std::string const eventSql = Qf(
        "INSERT IGNORE INTO heimdall_event "
        "(ticket_id, event_key, event_type, actor_kind, actor_ref, payload_json) "
        "SELECT id, SHA2('{}', 256), 'player_whisper', 'player', '{}', "
        "JSON_OBJECT('text', '{}', 'identityName', '{}', 'realmTag', '{}') "
        "FROM heimdall_ticket WHERE source = 'ingame' AND realm_tag = '{}' AND source_ticket_id = {}",
        escapedEventKey, escapedPlayerName, escapedText, escapedIdentityName, escapedRealmTag,
        escapedRealmTag, sourceTicketId);
    transaction->Append(eventSql.c_str());

    std::string const deliverySql = Qf(
        "INSERT IGNORE INTO heimdall_delivery "
        "(ticket_id, delivery_key, direction, kind, payload_json) "
        "SELECT id, SHA2(CONCAT('{}', ':discord'), 256), 'to_discord', 'player_whisper', "
        "JSON_OBJECT('realmTag', '{}', 'sourceTicketId', {}, 'playerName', '{}', 'identityName', '{}', 'text', '{}') "
        "FROM heimdall_ticket WHERE source = 'ingame' AND realm_tag = '{}' AND source_ticket_id = {}",
        escapedEventKey, escapedRealmTag, sourceTicketId, escapedPlayerName, escapedIdentityName, escapedText,
        escapedRealmTag, sourceTicketId);
    transaction->Append(deliverySql.c_str());

    CharacterDatabase.CommitTransaction(transaction);
}

class TicketPlayerScript final : public PlayerScript
{
public:
    TicketPlayerScript() : PlayerScript(SCRIPT_NAME) { }

    // DIVERGENCE (core): AzerothCore's hook is OnPlayerCanUseChat, which can veto the whisper, and
    // the module returns false to consume it - then hand-builds the CHAT_MSG_WHISPER_INFORM the
    // sender would otherwise never see. This core's hook is a void OnChat called from inside
    // Player::Whisper: nothing can be vetoed, and Player::Whisper sends both the whisper and the
    // sender's inform copy itself. So this hook only observes, and the manual echo is deleted
    // rather than ported - porting it would give the sender two copies of their own line.
    void OnChat(Player* player, uint32 type, uint32 /*lang*/, std::string& msg, Player* receiver) override
    {
        // Anything that is not a whisper aimed at a held GM identity is none of this module's
        // business, including every ordinary whisper between two players - and including the
        // identity's OWN outgoing whisper, which reaches this same hook with the identity as
        // `player`. Testing the receiver, exactly as AzerothCore does, excludes that direction.
        if (type != CHAT_MSG_WHISPER || !receiver || !IdentityRegistry::instance()->IsHeld(receiver->GetGUID()))
            return;

        uint32 sourceTicketId = OpenTicketIndex::instance()->Find(player->GetGUID().GetCounter());
        if (!sourceTicketId)
            return;                                         // no open ticket: leave the core alone

        RecordPlayerWhisper(OpenTicketIndex::instance()->GetRealmTag(), sourceTicketId, player->GetName(),
            receiver->GetName(), msg, OpenTicketIndex::instance()->NextWhisperSequence());

        TC_LOG_INFO(HEIMDALL_LOG, "Ticket {} whisper from \"{}\" to identity \"{}\" queued for Discord.",
            sourceTicketId, player->GetName(), receiver->GetName());
    }
};

// Real-client takeover of a held identity.
//
// DIVERGENCE (core): AzerothCore yields inside OnPlayerLoadFromDB, which is part-way through
// Player::LoadFromDB but still ahead of ObjectAccessor::AddObject. This core has no equivalent
// hook, so the substitute is the packet itself: CMSG_PLAYER_LOGIN is STATUS_AUTHED
// (Opcodes.cpp:192) and WorldSession::Update calls sScriptMgr->OnPacketReceive on the line
// immediately before opHandle->Call (WorldSession.cpp:394-415), on the world thread. That is
// EARLIER than AzerothCore's hook - before the core has even read the GUID - and the packet handed
// to the hook is a copy (ScriptMgr.cpp:1299-1305), so reading it here cannot disturb the parse.
//
// NOT PROVEN. Nothing in the development environment can send a real CMSG_PLAYER_LOGIN, so the one
// thing that matters - that a real login ends with one Player and not two - has not been observed.
// See report-T14c.md; this is a release gate.
class heimdall_login_watch final : public ServerScript
{
public:
    heimdall_login_watch() : ServerScript("heimdall_login_watch") { }

    void OnPacketReceive(WorldSession* session, WorldPacket& packet) override
    {
        if (packet.GetOpcode() != CMSG_PLAYER_LOGIN)
            return;

        // The 3.3.5 payload is the character's GUID, read here exactly as the core's own handler
        // reads it (CharacterHandler.cpp:682-684) - streamed, because ObjectGuid's uint64
        // constructor is private and rebuilding one by hand would be guessing at the encoding.
        // Streamed out of a copy of our own, because the buffer this hook is handed is shared by
        // every ServerScript in the dispatch loop (ScriptMgr.cpp:1299-1305), so moving its read
        // cursor would be moving somebody else's. The size guard keeps a malformed packet from
        // throwing a ByteBufferException in here.
        if (packet.size() < sizeof(uint64))
            return;

        WorldPacket copy(packet);
        copy.rpos(0);
        ObjectGuid guid;
        copy >> guid;

        if (!IdentityRegistry::instance()->IsHeld(guid))
            return;

        TC_LOG_WARN(HEIMDALL_LOG, "CMSG_PLAYER_LOGIN for {}, which is currently held as a GM identity; "
            "standing down before the core reads the packet.", guid.ToString());

        IdentityRegistry::instance()->YieldTo(guid, session);
    }
};

class TicketCommandScript final : public CommandScript
{
public:
    TicketCommandScript() : CommandScript("heimdall_commandscript") { }

    Trinity::ChatCommands::ChatCommandTable GetCommands() const override
    {
        using namespace Trinity::ChatCommands;

        // The same identity controls the Discord buttons drive, reachable from the worldserver
        // console. Kept because an operator has to be able to see and fix identity state when
        // Discord is the thing that is broken.
        static ChatCommandTable identityTable =
        {
            { "login",  HandleIdentityLoginCommand,  rbac::RBAC_PERM_COMMAND_GM, Console::Yes },
            { "logout", HandleIdentityLogoutCommand, rbac::RBAC_PERM_COMMAND_GM, Console::Yes },
            { "status", HandleIdentityStatusCommand, rbac::RBAC_PERM_COMMAND_GM, Console::Yes }
        };

        static ChatCommandTable ticketsTable =
        {
            { "identity", identityTable }
        };

        static ChatCommandTable commandTable =
        {
            { "heimdall", ticketsTable }
        };

        return commandTable;
    }

    // DIVERGENCE (core): every message below is pre-formatted with Trinity::StringFormat and sent
    // through SendSysMessage, rather than passed to PSendSysMessage with {} placeholders as on
    // AzerothCore. This core's PSendSysMessage is printf-style, so a braced placeholder compiles
    // and then silently fails to interpolate - the worst kind of difference, because nothing tells
    // you. Pre-formatting keeps the AzerothCore wording exactly and removes the trap entirely.
    static bool HandleIdentityLoginCommand(ChatHandler* handler, std::string characterName)
    {
        std::string message = Trinity::StringFormat("login for {} queued.", characterName);
        bool succeeded = IdentityRegistry::instance()->Login(characterName, message);

        handler->SendSysMessage(Trinity::StringFormat("heimdall: {}", message).c_str());
        if (!succeeded)
            handler->SetSentErrorMessage(true);

        return succeeded;
    }

    static bool HandleIdentityLogoutCommand(ChatHandler* handler, std::string characterName)
    {
        std::string message;
        bool succeeded = IdentityRegistry::instance()->Logout(characterName, message);

        handler->SendSysMessage(Trinity::StringFormat("heimdall: {}", message).c_str());
        if (!succeeded)
            handler->SetSentErrorMessage(true);

        return succeeded;
    }

    static bool HandleIdentityStatusCommand(ChatHandler* handler)
    {
        auto const& identities = IdentityRegistry::instance()->GetAll();
        if (identities.empty())
        {
            handler->SendSysMessage("heimdall: no GM identities are configured.");
            return true;
        }

        handler->SendSysMessage(Trinity::StringFormat("heimdall: {} configured identity(ies):",
            uint32(identities.size())).c_str());
        for (auto const& [name, identity] : identities)
        {
            Player* player = identity.Session ? identity.Session->GetPlayer() : nullptr;
            if (!player)
            {
                handler->SendSysMessage(Trinity::StringFormat("  {} ({}) acct {} - offline",
                    name, identity.Guid.ToString(), identity.AccountId).c_str());
                continue;
            }

            handler->SendSysMessage(Trinity::StringFormat("  {} ({}) acct {} - held, map {} zone {} gmVisible {} acceptWhispers {}",
                name, identity.Guid.ToString(), identity.AccountId, player->GetMapId(), player->GetZoneId(),
                player->isGMVisible(), player->isAcceptWhispers()).c_str());
        }

        return true;
    }
};
}

// Called from AddCustomScripts() in src/server/scripts/Custom/custom_script_loader.cpp - the one
// file in their own core an adopter edits. See trinitycore/README.md, step 4.
void AddSC_heimdall()
{
    new TicketPoller();
    new TicketPlayerScript();
    new heimdall_login_watch();
    new TicketCommandScript();

    // PHASE 4: RegisterCommandAuditScript() goes here on the AzerothCore side. There is no
    // faithful pre-command hook on this core, so there is no script to register.
}
