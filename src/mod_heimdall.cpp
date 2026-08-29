#include "AsyncCallbackProcessor.h"
#include "CharacterCache.h"
#include "Chat.h"
#include "CommandScript.h"
#include "Config.h"
#include "DatabaseEnv.h"
#include "GameTime.h"
#include "Log.h"
#include "ObjectAccessor.h"
#include "ObjectMgr.h"
#include "Player.h"
#include "RBAC.h"
#include "Realm.h"
#include "ScriptMgr.h"
#include "SharedDefines.h"
#include "StringConvert.h"
#include "Tokenize.h"
#include "World.h"
#include "WorldSession.h"
#include "WorldSessionMgr.h"

#include "mod_heimdall_shared.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <map>
#include <sstream>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <vector>

using namespace Heimdall;

namespace Heimdall
{
// One instance for the whole module. The poller writes it at startup; the command-audit hook in
// the other translation unit only reads it.
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
}

namespace
{

// Matches realm_tag VARCHAR(16). The automatic fallback tag needs four characters at most:
// worldserver refuses a RealmID above 255 (Main.cpp:456, because the client reads it as a uint8),
// so the widest fallback is "R255". The rest of the width is headroom for a hand-written prefix.
constexpr std::size_t REALM_TAG_MAX_LENGTH = 16;

// The companion bot mints its own Discord-sourced keys as DIS-000042. An in-game key of
// DIS-42 would not actually collide, but the ambiguity is not worth shipping.
constexpr char const* RESERVED_REALM_TAG = "DIS";

// How long a leased to_game job stays claimed before another pass may recover it. Only ever
// held across a single whisper, so this is a crash-recovery bound rather than a tuning knob.
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
    Settings settings;
    settings.enabled = sConfigMgr->GetOption<bool>("Heimdall.Enabled", false);
    settings.ticketPollSeconds = std::max<uint32>(1, sConfigMgr->GetOption<uint32>("Heimdall.TicketPollSeconds", 15));
    settings.deliveryPollSeconds = std::max<uint32>(1, sConfigMgr->GetOption<uint32>("Heimdall.DeliveryPollSeconds", 5));
    settings.maxWhisperBytes = std::clamp<uint32>(sConfigMgr->GetOption<uint32>("Heimdall.MaxWhisperBytes", 240), 32, 255);
    settings.archiveRetentionDays = std::max<uint32>(1, sConfigMgr->GetOption<uint32>("Heimdall.ArchiveRetentionDays", 180));
    settings.realmPrefix = sConfigMgr->GetOption<std::string>("Heimdall.RealmPrefix", "");
    settings.gmIdentities = sConfigMgr->GetOption<std::string>("Heimdall.GmIdentities", "");
    settings.firstRunImport = sConfigMgr->GetOption<std::string>("Heimdall.FirstRunImport", "open");
    std::transform(settings.firstRunImport.begin(), settings.firstRunImport.end(), settings.firstRunImport.begin(),
        [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    if (settings.firstRunImport != "open" && settings.firstRunImport != "none" && settings.firstRunImport != "all")
    {
        LOG_ERROR(LOG_FILTER, "Heimdall.FirstRunImport \"{}\" is not one of open, none or all. Using \"open\".",
            settings.firstRunImport);
        settings.firstRunImport = "open";
    }
    settings.commandAuditEnabled = sConfigMgr->GetOption<bool>("Heimdall.CommandAuditEnabled", false);
    settings.commandAuditMinSecurity = sConfigMgr->GetOption<uint32>("Heimdall.CommandAuditMinSecurity", 1);
    settings.commandAuditBatchSeconds = std::max<uint32>(1, sConfigMgr->GetOption<uint32>("Heimdall.CommandAuditBatchSeconds", 10));
    settings.commandAuditMaxLines = std::clamp<uint32>(sConfigMgr->GetOption<uint32>("Heimdall.CommandAuditMaxLines", 25), 1, 100);
    settings.contextRefreshSeconds = std::max<uint32>(10, sConfigMgr->GetOption<uint32>("Heimdall.ContextRefreshSeconds", 60));

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

    // gm_ticket is deliberately absent from every mutation below. The companion bot performs any
    // lifecycle change through AzerothCore SOAP commands, never through SQL.
    transaction->Append(
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
        escapedRealmTag, ticketId, modifiedTime, escapedPublicKey, playerGuid, playerAccountId, escapedName, completed ? 1 : 0, retentionDays);

    transaction->Append(
        "INSERT IGNORE INTO heimdall_event "
        "(ticket_id, event_key, event_type, actor_kind, actor_ref, payload_json) "
        "SELECT id, SHA2('{}', 256), '{}', 'player', '{}', JSON_OBJECT('description', '{}', 'modifiedTime', {}) "
        "FROM heimdall_ticket WHERE source = 'ingame' AND realm_tag = '{}' AND source_ticket_id = {}",
        escapedEventKey, completed ? "ingame_ticket_closed" : "ingame_ticket_observed",
        escapedName, escapedDescription, modifiedTime, escapedRealmTag, ticketId);

    transaction->Append(
        "INSERT IGNORE INTO heimdall_delivery "
        "(ticket_id, delivery_key, direction, kind, payload_json) "
        "SELECT id, SHA2(CONCAT('{}', ':discord'), 256), 'to_discord', 'sync_ingame_ticket', "
        "JSON_OBJECT('realmTag', '{}', 'sourceTicketId', {}, 'playerName', '{}', 'description', '{}', 'completed', {}) "
        "FROM heimdall_ticket WHERE source = 'ingame' AND realm_tag = '{}' AND source_ticket_id = {}",
        escapedEventKey, escapedRealmTag, ticketId, escapedName, escapedDescription, completed ? 1 : 0,
        escapedRealmTag, ticketId);

    CharacterDatabase.CommitTransaction(transaction);
}

// The whisper hook has to answer "does this player have an open ticket?" on the world thread for
// every whisper sent on the realm. The poller already sees every in-game ticket, so it maintains
// the answer here and the chat path never touches the database.
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

        for (std::string_view rawName : Acore::Tokenize(csv, ',', false))
        {
            std::string name{ rawName };
            name.erase(name.begin(), std::find_if(name.begin(), name.end(), [](unsigned char c) { return std::isspace(c) == 0; }));
            name.erase(std::find_if(name.rbegin(), name.rend(), [](unsigned char c) { return std::isspace(c) == 0; }).base(), name.end());

            if (name.empty())
                continue;

            if (!normalizePlayerName(name))
            {
                LOG_WARN(LOG_FILTER, "GmIdentities entry \"{}\" is not a usable character name; skipping it.", name);
                continue;
            }

            CharacterCacheEntry const* cache = sCharacterCache->GetCharacterCacheByName(name);
            if (!cache)
            {
                LOG_WARN(LOG_FILTER, "GmIdentities names character \"{}\", which does not exist on this realm; skipping it.", name);
                continue;
            }

            _identities[name] = Identity{ cache->Guid, cache->AccountId, nullptr };

                PublishState(name, false);

            LOG_INFO(LOG_FILTER, "GM identity \"{}\" resolved to account {} ({}).", name, cache->AccountId, cache->Guid.ToString());
        }
    }

    [[nodiscard]] bool IsConfigured() const { return !_identities.empty(); }

    // Asking for a state the system is already in is success, not failure: a caller that wanted
    // the identity online gets exactly that.
    // Invoked once per world tick; a completed login runs its continuation here rather than on the
    // database thread.
    void Update()
    {
        _loginCallbacks.ProcessReadyCallbacks();
    }

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
            message = Acore::StringFormat("{} is not a configured GM identity.", name);
            return false;
        }

        if (itr->second.Session)
        {
            message = Acore::StringFormat("{} is already held; nothing to do.", name);
            return true;
        }

        if (_pending.count(itr->second.Guid))
        {
            message = Acore::StringFormat("A login for {} is already in flight; nothing to do.", name);
            return true;
        }

        // Never disturb somebody who is actually playing. A misconfigured identity pointing at a
        // live account must refuse, not kick.
        uint32 accountId = itr->second.AccountId;
        if (sWorldSessionMgr->FindSession(accountId))
        {
            message = Acore::StringFormat("Account {} is connected right now - refusing to touch it.", accountId);
            return false;
        }

        if (sWorldSessionMgr->FindOfflineSession(accountId))
        {
            message = Acore::StringFormat("Account {} has a lingering session - refusing to touch it.", accountId);
            return false;
        }

        if (ObjectAccessor::FindPlayerByName(name, false))
        {
            message = Acore::StringFormat("{} is already in the world - refusing to touch it.", name);
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

        // Our own callback queue, pumped from the poller's OnUpdate below.
        //
        // The core's own login path uses the session's queue, but there is no session yet at this
        // point - one is created in FinishLogin once the character data has actually loaded. Some
        // downstream cores expose a World-level queue for exactly this case; upstream does not, and
        // depending on it would mean the module built on one core and not the other.
        // AsyncCallbackProcessor is a header-only template both cores carry unchanged, so owning
        // one here needs nothing from either.
        _loginCallbacks.AddCallback(CharacterDatabase.DelayQueryHolder(holder))
            .AfterComplete([name, accountId, guid](SQLQueryHolderBase const& queryHolder)
            {
                IdentityRegistry::instance()->FinishLogin(name, accountId, guid, static_cast<LoginQueryHolder const&>(queryHolder));
            });

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
            message = Acore::StringFormat("{} is not a configured GM identity.", name);
            return false;
        }

        // Already released is the state the caller asked for, so this is success.
        if (!itr->second.Session)
        {
            message = Acore::StringFormat("{} is not currently held; nothing to do.", name);
            return true;
        }

        Release(name, itr->second);
        message = Acore::StringFormat("{} logged out.", name);
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

    // A real client logging in on an identity's account is not blocked by the core: a socket-less
    // session cannot live in WorldSessionMgr, so the duplicate-session check never sees it. This
    // runs from OnPlayerLoadFromDB, which is inside Player::LoadFromDB and therefore still ahead
    // of ObjectAccessor::AddObject - the last moment we can stand down without the two Player
    // objects colliding on the same GUID.
    void YieldTo(Player* incoming)
    {
        if (!IsHeld(incoming->GetGUID()))
            return;

        for (auto& [name, identity] : _identities)
        {
            if (identity.Guid != incoming->GetGUID() || !identity.Session)
                continue;

            if (identity.Session == incoming->GetSession())
                return;                                     // our own headless login, still loading

            LOG_WARN(LOG_FILTER, "A client is logging in as GM identity \"{}\"; releasing the headless session so the "
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

        if (sWorldSessionMgr->FindSession(accountId) || sWorldSessionMgr->FindOfflineSession(accountId))
        {
            LOG_ERROR(LOG_FILTER, "Account {} acquired a session while loading GM identity \"{}\"; aborting.", accountId, name);
            return;
        }

        // Socket-less session. SEC_GAMEMASTER because GM invisibility keys off the session's
        // security level, not off the GM-mode flag; nothing is written to the account.
        WorldSession* session = new WorldSession(accountId, "", 0, nullptr, SEC_GAMEMASTER,
            EXPANSION_WRATH_OF_THE_LICH_KING, time_t(0), sWorld->GetDefaultDbcLocale(), 0, false, true, 0);

        session->HandlePlayerLoginFromDB(holder);

        Player* player = session->GetPlayer();
        if (!player)
        {
            LOG_ERROR(LOG_FILTER, "Could not load GM identity \"{}\" ({}) from the database.", name, guid.ToString());
            session->LogoutPlayer(false);
            delete session;
            return;
        }

        // Without this the core answers whispers to a GM-security character with
        // "no player named X is currently online".
        player->SetAcceptWhispers(true);
        player->SetGameMaster(true);
        player->SetGMVisible(false);

        itr->second.Session = session;
        _heldGuids.insert(guid);
        PublishState(name, true);

        LOG_INFO(LOG_FILTER, "GM identity \"{}\" ({}) is held in-world on account {}.", name, guid.ToString(), accountId);
    }

    // The companion bot shows whether a GM is reachable in game. It reads that from the existing
    // settings table rather than parsing console output, so the state survives a bot restart and
    // needs no schema of its own.
    void PublishState(std::string const& name, bool held) const
    {
        CharacterDatabase.Execute(
            "INSERT INTO heimdall_setting (setting_key, setting_value) VALUES ('{}', '{}') "
            "ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)",
            Escape("identity.state." + _realmTag + "." + name), held ? "held" : "offline");
    }

    void Release(std::string const& name, Identity& identity)
    {
        WorldSession* session = identity.Session;
        if (!session)
            return;

        // Clear our tracking first: LogoutPlayer fires OnPlayerLogout, which re-enters here.
        identity.Session = nullptr;
        _heldGuids.erase(identity.Guid);

        if (Player* player = session->GetPlayer())
        {
            // Undo the GM state so none of it reaches the character save.
            player->SetGMVisible(true);
            player->SetGameMaster(false);
        }

        session->LogoutPlayer(true);
        delete session;
        PublishState(name, false);

        LOG_INFO(LOG_FILTER, "GM identity \"{}\" ({}) released.", name, identity.Guid.ToString());
    }

    std::map<std::string, Identity> _identities;
    std::unordered_set<ObjectGuid> _heldGuids;
    std::unordered_set<ObjectGuid> _pending;
    AsyncCallbackProcessor<SQLQueryHolderCallback> _loginCallbacks;
    std::string _realmTag;
};

// Publishes what a GM needs to know about the player behind a ticket. The bot never reads player
// data itself - its database grants deliberately stop at this module's own tables - so the module
// reads and publishes, and the bot only renders.
//
// One row per ticket with a stable event key, updated in place: a refresh must not append history
// every minute. That does mean this event row is mutable, unlike the append-only lifecycle events
// beside it, which is a deliberate trade for bounded growth.
void PublishPlayerContext(std::string const& realmTag, uint32 sourceTicketId, uint64 playerGuidLow)
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
    if (QueryResult row = CharacterDatabase.Query(
        "SELECT zone, totaltime, logout_time FROM characters WHERE guid = {}", playerGuidLow))
    {
        Field* fields = row->Fetch();
        if (!online)
            zoneId = fields[0].Get<uint16>();
        totalPlaytime = fields[1].Get<uint32>();
        lastLogout = fields[2].Get<uint32>();
    }

    uint32 accountCreated = 0;
    if (QueryResult row = LoginDatabase.Query(
        "SELECT UNIX_TIMESTAMP(joindate) FROM account WHERE id = {}", cache->AccountId))
    {
        accountCreated = row->Fetch()[0].Get<uint32>();
    }

    std::string escapedRealmTag = Escape(realmTag);
    std::ostringstream rawKey;
    rawKey << "ingame:" << realmTag << ':' << sourceTicketId << ":context";

    CharacterDatabase.Execute(
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
        uint32(GameTime::GetGameTime().count()), escapedRealmTag, sourceTicketId);
}

class TicketPoller final : public WorldScript
{
public:
    TicketPoller() : WorldScript(SCRIPT_NAME) { }

    void OnStartup() override
    {
        _settings = ReadSettings();
        if (!_settings.enabled)
            return;

        if (!IsValidRealmTag(_settings.realmTag))
        {
            // Refuse to run rather than write keys that could collide with another realm.
            _settings.enabled = false;

            if (_settings.realmPrefix.empty())
                LOG_ERROR(LOG_FILTER, "Heimdall.RealmPrefix is blank and the fallback tag derived from RealmID {} "
                    "(\"{}\") is longer than {} characters. Set an explicit RealmPrefix of 1-{} letters or digits. Bridge disabled.",
                    realm.Id.Realm, _settings.realmTag, uint32(REALM_TAG_MAX_LENGTH), uint32(REALM_TAG_MAX_LENGTH));
            else
                LOG_ERROR(LOG_FILTER, "Heimdall.RealmPrefix \"{}\" is invalid: it must match ^[A-Za-z0-9]{{1,{}}}$. "
                    "Bridge disabled so it cannot write ticket keys that collide with another realm.",
                    _settings.realmPrefix, uint32(REALM_TAG_MAX_LENGTH));

            return;
        }

        if (IsReservedRealmTag(_settings.realmTag))
        {
            _settings.enabled = false;

            LOG_ERROR(LOG_FILTER, "Heimdall.RealmPrefix \"{}\" is reserved: \"{}\" is how the companion bot labels "
                "Discord-created tickets, so in-game keys must not use it. Choose a different prefix. Bridge disabled.",
                _settings.realmPrefix, RESERVED_REALM_TAG);

            return;
        }

        OpenTicketIndex::instance()->SetRealmTag(_settings.realmTag);
        ConfigureCommandAudit(_settings.realmTag, _settings.commandAuditBatchSeconds, _settings.commandAuditMaxLines);
        bool const firstRun = !LoadWatermark();
        if (firstRun)
            SeedFirstRun();
        else
            LoadImportFloor();

        SeedSeenTickets();
        IdentityRegistry::instance()->Configure(_settings.gmIdentities, _settings.realmTag);

        if (firstRun)
        {
            LOG_INFO(LOG_FILTER, "Enabled for realm tag \"{}\"; gm_ticket polling is read-only. "
                "First run: seeded a new watermark with import mode \"{}\" and {} GM identity(ies).",
                _settings.realmTag, _settings.firstRunImport, uint32(IdentityRegistry::instance()->GetAll().size()));
        }
        else
        {
            LOG_INFO(LOG_FILTER, "Enabled for realm tag \"{}\"; gm_ticket polling is read-only. "
                "Resuming at watermark {} with {} known ticket(s) and {} GM identity(ies).",
                _settings.realmTag, _watermark, uint32(_seen.size()), uint32(IdentityRegistry::instance()->GetAll().size()));
        }
    }

    void OnShutdownInitiate(ShutdownExitCode /*code*/, ShutdownMask /*mask*/) override
    {
        // Do not lose the tail of the audit log to a restart.
        FlushCommandAudit();
        IdentityRegistry::instance()->LogoutAll();
    }

    void OnUpdate(uint32 diff) override
    {
        if (!_settings.enabled)
            return;

        IdentityRegistry::instance()->Update();
        PollDeliveries(diff);
        UpdateCommandAudit(diff);
        SweepPlayerContext(diff);

        _ticketElapsed += diff;
        if (_ticketElapsed < _settings.ticketPollSeconds * IN_MILLISECONDS)
            return;
        _ticketElapsed = 0;

        // Rows at or after the watermark cover tickets that are new or whose text changed. Tickets we
        // still consider live have to be re-read regardless: neither SetClosedBy nor SetCompleted
        // touches lastModifiedTime, so a closure never moves a row past the watermark on its own.
        QueryResult rows = CharacterDatabase.Query(
            "SELECT Id, playerGuid, name, description, lastModifiedTime, completed, type "
            "FROM gm_ticket WHERE type IN (0, 1, 2) AND (lastModifiedTime >= {} OR (completed = 0 AND type = 0)) "
            "ORDER BY Id",
            _watermark);
        if (!rows)
            return;

        uint32 previousWatermark = _watermark;
        uint32 examined = 0;
        uint32 written = 0;

        do
        {
            Field* fields = rows->Fetch();
            uint32 ticketId = fields[0].Get<uint32>();
            uint32 modifiedTime = fields[4].Get<uint32>();
            ++examined;

            // Only ever non-zero when this realm started with FirstRunImport = none. Applied here
            // rather than in the query so the poll filter itself stays exactly as it was.
            if (ticketId <= _importFloor)
                continue;

            // Both columns have to be consulted. The core carries two independent closure signals,
            // and each GM command writes only one of them:
            //   .ticket close    -> ResolveAndCloseTicket -> SetClosedBy -> `type` = TICKET_TYPE_CLOSED
            //   .ticket complete -> SetCompleted -> `completed` = 1, leaving `type` at TICKET_TYPE_OPEN
            // A player abandoning a ticket, and character deletion, also go through SetClosedBy
            // (TicketMgr.cpp:377). TicketMgr's own liveness test is !IsClosed() && !IsCompleted() -
            // see TicketMgr.h:218.
            bool completed = fields[5].Get<uint8>() != 0 || fields[6].Get<uint8>() != 0;

            _watermark = std::max(_watermark, modifiedTime);

            // Suppress the write when nothing observable moved since the last poll. An idle server
            // re-reads the open tickets every interval and writes nothing.
            uint64 playerGuid = fields[1].Get<uint64>();
            TrackOpenTicket(playerGuid, ticketId, completed);

            auto [itr, inserted] = _seen.try_emplace(ticketId, TicketState{ modifiedTime, completed });
            if (!inserted)
            {
                if (itr->second.ModifiedTime == modifiedTime && itr->second.Completed == completed)
                    continue;

                itr->second = TicketState{ modifiedTime, completed };
            }

            LOG_DEBUG(LOG_FILTER, "Poll recorded ticket {} for \"{}\" (modified {}, closed {}).",
                ticketId, fields[2].Get<std::string>(), modifiedTime, completed ? 1 : 0);

            RecordIngameTicket(_settings.realmTag, ticketId, playerGuid, fields[2].Get<std::string>(),
                fields[3].Get<std::string>(), modifiedTime, completed, _settings.archiveRetentionDays);
            ++written;
        } while (rows->NextRow());

        LOG_DEBUG(LOG_FILTER, "Poll finished: {} row(s) examined, {} written, watermark {}.",
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
        QueryResult result = CharacterDatabase.Query(
            "SELECT setting_value FROM heimdall_setting WHERE setting_key = '{}'",
            Escape(WatermarkKey()));
        if (!result)
            return false;

        if (Optional<uint32> stored = Acore::StringTo<uint32>((*result)[0].Get<std::string>()))
            _watermark = *stored;

        return true;
    }

    [[nodiscard]] std::string ImportFloorKey() const
    {
        return "ingame.import_floor." + _settings.realmTag;
    }

    void LoadImportFloor()
    {
        QueryResult result = CharacterDatabase.Query(
            "SELECT setting_value FROM heimdall_setting WHERE setting_key = '{}'",
            Escape(ImportFloorKey()));
        if (!result)
            return;

        if (Optional<uint32> stored = Acore::StringTo<uint32>((*result)[0].Get<std::string>()))
            _importFloor = *stored;
    }

    void SaveImportFloor() const
    {
        CharacterDatabase.Execute(
            "INSERT INTO heimdall_setting (setting_key, setting_value) VALUES ('{}', '{}') "
            "ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)",
            Escape(ImportFloorKey()), _importFloor);
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
        uint32 const now = static_cast<uint32>(GameTime::GetGameTime().count());

        if (_settings.firstRunImport == "all")
        {
            _watermark = 0;
            SaveWatermark();
            LOG_INFO(LOG_FILTER, "First run for realm tag \"{}\": Heimdall.FirstRunImport is \"all\", so every "
                "ticket in gm_ticket will be imported and given a Discord channel.", _settings.realmTag);
            return;
        }

        _watermark = now;

        if (_settings.firstRunImport == "none")
        {
            QueryResult highest = CharacterDatabase.Query("SELECT COALESCE(MAX(Id), 0) FROM gm_ticket");
            _importFloor = highest ? (*highest)[0].Get<uint32>() : 0;
            SaveImportFloor();
        }

        SaveWatermark();

        uint32 open = 0;
        if (QueryResult counted = CharacterDatabase.Query(
            "SELECT COUNT(*) FROM gm_ticket WHERE completed = 0 AND type = 0 AND Id > {}", _importFloor))
        {
            open = (*counted)[0].Get<uint32>();
        }

        if (_settings.firstRunImport == "none")
        {
            LOG_INFO(LOG_FILTER, "First run for realm tag \"{}\": starting empty at watermark {}. Ticket ids up to "
                "{} are ignored; anything filed after that is picked up normally.",
                _settings.realmTag, _watermark, _importFloor);
        }
        else
        {
            LOG_INFO(LOG_FILTER, "First run for realm tag \"{}\": seeded watermark {} and importing {} open "
                "ticket(s). Closed history stays in gm_ticket and gets no Discord channel.",
                _settings.realmTag, _watermark, open);
        }
    }

    void SaveWatermark() const
    {
        CharacterDatabase.Execute(
            "INSERT INTO heimdall_setting (setting_key, setting_value) VALUES ('{}', '{}') "
            "ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)",
            Escape(WatermarkKey()), _watermark);
    }

    // Rebuilds the poll state from what this realm already recorded, so a restart does not rewrite
    // every live ticket just to discover nothing changed.
    void SeedSeenTickets()
    {
        QueryResult result = CharacterDatabase.Query(
            "SELECT source_ticket_id, source_modified_time, status, player_guid FROM heimdall_ticket "
            "WHERE source = 'ingame' AND realm_tag = '{}'",
            Escape(_settings.realmTag));
        if (!result)
            return;

        do
        {
            Field* fields = result->Fetch();
            std::string status = fields[2].Get<std::string>();
            bool completed = status == "closed" || status == "cancelled";
            uint32 ticketId = fields[0].Get<uint32>();

            _seen[ticketId] = TicketState{ fields[1].Get<uint32>(), completed };
            TrackOpenTicket(fields[3].Get<uint64>(), ticketId, completed);
        } while (result->NextRow());
    }

    void TrackOpenTicket(uint64 playerGuid, uint32 ticketId, bool completed)
    {
        OpenTicketIndex::instance()->Track(playerGuid, ticketId, completed);
    }

    // Leases to_game jobs for this realm and delivers each as a whisper from the assigned
    // identity. A job whose identity is not held, or whose target is offline, is left untouched
    // and simply retried next tick - it is not a failure, just a precondition not met yet.
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
        CharacterDatabase.Execute(
            "UPDATE heimdall_delivery d "
            "JOIN heimdall_ticket t ON t.id = d.ticket_id "
            "SET d.state = 'queued', d.lease_owner = NULL, d.leased_until = NULL "
            "WHERE d.direction = 'to_game' AND d.state = 'leased' AND d.leased_until < CURRENT_TIMESTAMP "
            "AND t.realm_tag = '{}'",
            escapedRealmTag);

        // MySQL does the JSON parsing so the module needs no JSON dependency.
        QueryResult rows = CharacterDatabase.Query(
            "SELECT d.id, d.ticket_id, d.kind, t.source_ticket_id, t.player_guid, "
            "JSON_UNQUOTE(JSON_EXTRACT(d.payload_json, '$.gmName')), "
            "JSON_UNQUOTE(JSON_EXTRACT(d.payload_json, '$.playerName')), "
            "JSON_UNQUOTE(JSON_EXTRACT(d.payload_json, '$.text')) "
            "FROM heimdall_delivery d "
            "JOIN heimdall_ticket t ON t.id = d.ticket_id "
            "WHERE d.direction = 'to_game' AND d.state = 'queued' AND d.available_at <= CURRENT_TIMESTAMP "
            "AND t.realm_tag = '{}' ORDER BY d.id LIMIT 20",
            escapedRealmTag);
        if (!rows)
            return;

        // Ordering matters per ticket: once one job for a ticket cannot go out, every later job
        // for the same ticket has to wait behind it.
        std::unordered_set<uint64> blockedTickets;

        do
        {
            Field* fields = rows->Fetch();
            uint64 deliveryId = fields[0].Get<uint64>();
            uint64 ticketId = fields[1].Get<uint64>();
            std::string kind = fields[2].Get<std::string>();
            uint32 sourceTicketId = fields[3].Get<uint32>();
            uint64 rowPlayerGuid = fields[4].Get<uint64>();
            std::string gmName = fields[5].Get<std::string>();
            std::string targetName = fields[6].Get<std::string>();
            std::string text = fields[7].Get<std::string>();

            if (blockedTickets.count(ticketId))
                continue;

            // A GM asking "are they online right now?" - answer immediately rather than waiting
            // for the next context sweep.
            if (kind == "refresh_player_context")
            {
                PublishPlayerContext(_settings.realmTag, sourceTicketId, rowPlayerGuid);
                CharacterDatabase.Execute(
                    "UPDATE heimdall_delivery SET state = 'delivered', delivered_at = CURRENT_TIMESTAMP, "
                    "attempts = attempts + 1, lease_owner = '{}' WHERE id = {} AND state = 'queued'",
                    Escape(LeaseOwner()), deliveryId);
                continue;
            }

            Player* speaker = IdentityRegistry::instance()->GetHeldPlayer(gmName);
            Player* target = normalizePlayerName(targetName) ? ObjectAccessor::FindPlayerByName(targetName, true) : nullptr;

            if (!speaker || !target || text.empty())
            {
                blockedTickets.insert(ticketId);
                continue;
            }

            // Lease first so a crash mid-delivery leaves a recoverable row rather than a silent loss.
            CharacterDatabase.Execute(
                "UPDATE heimdall_delivery SET state = 'leased', attempts = attempts + 1, "
                "lease_owner = '{}', leased_until = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL {} SECOND) "
                "WHERE id = {} AND state = 'queued'",
                Escape(LeaseOwner()), DELIVERY_LEASE_SECONDS, deliveryId);

            speaker->Whisper(text, LANG_UNIVERSAL, target);

            CharacterDatabase.Execute(
                "UPDATE heimdall_delivery SET state = 'delivered', delivered_at = CURRENT_TIMESTAMP, "
                "leased_until = NULL WHERE id = {}",
                deliveryId);

            LOG_INFO(LOG_FILTER, "Delivered ticket reply from \"{}\" to \"{}\" (delivery {}).", gmName, targetName, deliveryId);
        } while (rows->NextRow());
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

        QueryResult rows = CharacterDatabase.Query(
            "SELECT source_ticket_id, player_guid FROM heimdall_ticket "
            "WHERE source = 'ingame' AND realm_tag = '{}' AND status IN ('open', 'claimed', 'closing') "
            "AND player_guid IS NOT NULL LIMIT 50",
            Escape(_settings.realmTag));
        if (!rows)
            return;

        do
        {
            Field* fields = rows->Fetch();
            PublishPlayerContext(_settings.realmTag, fields[0].Get<uint32>(), fields[1].Get<uint64>());
        } while (rows->NextRow());
    }

    Settings& _settings = CurrentSettings();
    uint32 _ticketElapsed = 0;
    uint32 _deliveryElapsed = 0;
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
        << GameTime::GetGameTime().count() << ':' << sequence;
    std::string escapedEventKey = Escape(rawKey.str());

    CharacterDatabaseTransaction transaction = CharacterDatabase.BeginTransaction();

    transaction->Append(
        "INSERT IGNORE INTO heimdall_event "
        "(ticket_id, event_key, event_type, actor_kind, actor_ref, payload_json) "
        "SELECT id, SHA2('{}', 256), 'player_whisper', 'player', '{}', "
        "JSON_OBJECT('text', '{}', 'identityName', '{}', 'realmTag', '{}') "
        "FROM heimdall_ticket WHERE source = 'ingame' AND realm_tag = '{}' AND source_ticket_id = {}",
        escapedEventKey, escapedPlayerName, escapedText, escapedIdentityName, escapedRealmTag,
        escapedRealmTag, sourceTicketId);

    transaction->Append(
        "INSERT IGNORE INTO heimdall_delivery "
        "(ticket_id, delivery_key, direction, kind, payload_json) "
        "SELECT id, SHA2(CONCAT('{}', ':discord'), 256), 'to_discord', 'player_whisper', "
        "JSON_OBJECT('realmTag', '{}', 'sourceTicketId', {}, 'playerName', '{}', 'identityName', '{}', 'text', '{}') "
        "FROM heimdall_ticket WHERE source = 'ingame' AND realm_tag = '{}' AND source_ticket_id = {}",
        escapedEventKey, escapedRealmTag, sourceTicketId, escapedPlayerName, escapedIdentityName, escapedText,
        escapedRealmTag, sourceTicketId);

    CharacterDatabase.CommitTransaction(transaction);
}

class TicketPlayerScript final : public PlayerScript
{
public:
    TicketPlayerScript() : PlayerScript(SCRIPT_NAME) { }

    bool OnPlayerCanUseChat(Player* player, uint32 type, uint32 /*lang*/, std::string& msg, Player* receiver) override
    {
        // Anything that is not a whisper aimed at a held GM identity is none of this module's
        // business, including every ordinary whisper between two players.
        if (type != CHAT_MSG_WHISPER || !receiver || !IdentityRegistry::instance()->IsHeld(receiver->GetGUID()))
            return true;

        uint32 sourceTicketId = OpenTicketIndex::instance()->Find(player->GetGUID().GetCounter());
        if (!sourceTicketId)
            return true;                                    // no open ticket: leave the core alone

        RecordPlayerWhisper(OpenTicketIndex::instance()->GetRealmTag(), sourceTicketId, player->GetName(),
            receiver->GetName(), msg, OpenTicketIndex::instance()->NextWhisperSequence());

        // Consuming the whisper skips the CHAT_MSG_WHISPER_INFORM that Player::Whisper would
        // normally send back, which leaves the sender staring at nothing. Send it ourselves so
        // their client shows the outgoing line exactly as it would for any other whisper. No
        // auto-reply: silence after the echo is what whispering a real person looks like.
        WorldPacket echo;
        ChatHandler::BuildChatPacket(echo, CHAT_MSG_WHISPER_INFORM, LANG_UNIVERSAL, receiver, receiver, msg);
        player->SendDirectMessage(&echo);

        LOG_INFO(LOG_FILTER, "Ticket {} whisper from \"{}\" to identity \"{}\" queued for Discord.",
            sourceTicketId, player->GetName(), receiver->GetName());

        return false;
    }

    // Runs from inside Player::LoadFromDB, which is still ahead of ObjectAccessor::AddObject.
    // If a client is logging in as one of our identities, stand down here or two Player objects
    // end up sharing one GUID.
    void OnPlayerLoadFromDB(Player* player) override
    {
        IdentityRegistry::instance()->YieldTo(player);
    }
};

class TicketCommandScript final : public CommandScript
{
public:
    TicketCommandScript() : CommandScript("mod_heimdall_commandscript") { }

    Acore::ChatCommands::ChatCommandTable GetCommands() const override
    {
        using namespace Acore::ChatCommands;

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

    static bool HandleIdentityLoginCommand(ChatHandler* handler, std::string characterName)
    {
        std::string message = Acore::StringFormat("login for {} queued.", characterName);
        bool succeeded = IdentityRegistry::instance()->Login(characterName, message);

        handler->PSendSysMessage("heimdall: {}", message);
        if (!succeeded)
        {
            handler->SetSentErrorMessage(true);
        }

        return succeeded;
    }

    static bool HandleIdentityLogoutCommand(ChatHandler* handler, std::string characterName)
    {
        std::string message;
        bool succeeded = IdentityRegistry::instance()->Logout(characterName, message);

        handler->PSendSysMessage("heimdall: {}", message);
        if (!succeeded)
        {
            handler->SetSentErrorMessage(true);
        }

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

        handler->PSendSysMessage("heimdall: {} configured identity(ies):", uint32(identities.size()));
        for (auto const& [name, identity] : identities)
        {
            Player* player = identity.Session ? identity.Session->GetPlayer() : nullptr;
            if (!player)
            {
                handler->PSendSysMessage("  {} ({}) acct {} - offline", name, identity.Guid.ToString(), identity.AccountId);
                continue;
            }

            handler->PSendSysMessage("  {} ({}) acct {} - held, map {} zone {} gmVisible {}",
                name, identity.Guid.ToString(), identity.AccountId, player->GetMapId(), player->GetZoneId(),
                player->isGMVisible());
        }

        return true;
    }
};
}

// Fires for every command attempt, before execution, for in-game GMs and for anything coming
// through the console - which includes the bot's own SOAP commands, since SOAP queues a
// CliCommandHolder down the same path. Must never block a command: always returns true.
void Addmod_heimdall()
{
    new TicketPoller();
    new TicketPlayerScript();
    new TicketCommandScript();

    // Opt-in and self-contained: the audit log decides for itself whether to register, and with
    // the setting off no hook is constructed at all.
    Heimdall::RegisterCommandAuditScript();
}
