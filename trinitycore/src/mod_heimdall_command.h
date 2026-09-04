#ifndef MOD_HEIMDALL_COMMAND_H
#define MOD_HEIMDALL_COMMAND_H

// Composing the realm commands Heimdall runs on the bot's behalf.
//
// The bot cannot send command text. It writes an intent row - an action and its arguments as
// separate fields - and the module composes the command here, from a fixed switch on an action
// name it recognises, with every argument validated first. A payload carrying ".ban Someone" is
// not a command; it is an unknown action, and it is refused. The boundary is structural.
//
// WHAT the payload may say, and WHO it may not
// -------------------------------------------
// Reported 2026-09-03 by a TrinityCore server operator reading this path, and confirmed: the
// action was constrained but the TARGET was not. `playerName`, `sourceTicketId` and `publicKey`
// came out of the delivery row's JSON, so anything able to write those rows - a compromised bot,
// or its database user - could hang an allowlisted action off a real ticket and aim it at any
// character on the realm. Not arbitrary command execution: the switch below is still fixed. But
// the six allowed actions pointed at the wrong person is a far wider blast radius than "only that
// ticket's player".
//
// So: the module resolves WHO and WHICH TICKET from the ticket row it owns, and the payload may
// say only WHAT to do - action, destination, text, and gmName. TicketTarget below is filled from
// `heimdall_ticket`, never from JSON.
//
// gmName stays payload-supplied on purpose, and is not a hole: the identity registry only ever
// acts for characters named in the operator's Heimdall.GmIdentities config list, so a forged name
// resolves to no held identity and the command does nothing. It is gated by consent, elsewhere.
//
// This header depends on the standard library only, so test/command_test.cpp compiles it outside
// the core's build. That test is the one that would have caught the finding above.

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <string>

namespace Heimdall::Command
{
// Everything about a ticket that can reach a command line. Every field comes from the module's own
// heimdall_ticket row; none of it is ever read from a delivery payload.
struct TicketTarget
{
    std::uint32_t sourceTicketId = 0;  // the realm's own gm_ticket.Id
    std::string publicKey;             // e.g. "Cer-901"
    std::string playerName;            // the character the ticket belongs to
    std::uint64_t playerGuid = 0;      // 0 for a Discord-opened ticket, which has no character
};

// Digits only, and short enough that no composed command can be made unwieldy.
inline bool IsTicketNumber(std::string const& value)
{
    return !value.empty() && value.size() <= 10
        && std::all_of(value.begin(), value.end(), [](unsigned char c) { return std::isdigit(c) != 0; });
}

// A WoW character name: letters only, twelve at most - the client's own limit. This is what stops
// a name argument carrying a space and becoming a second command argument.
//
// Still applied to names that came out of the database. A name is not trusted because of where it
// was read from; it is trusted because it cannot change the shape of the command.
inline bool IsCharacterName(std::string const& value)
{
    return !value.empty() && value.size() <= 12
        && std::all_of(value.begin(), value.end(), [](unsigned char c) { return std::isalpha(c) != 0; });
}

inline bool IsPublicKey(std::string const& value)
{
    return !value.empty() && value.size() <= 32
        && std::all_of(value.begin(), value.end(), [](unsigned char c)
        {
            return std::isalnum(c) != 0 || c == '-' || c == '_';
        });
}

inline bool IsTeleDestination(std::string const& value)
{
    if (value == "$home")
        return true;

    return !value.empty() && value.size() <= 48
        && std::all_of(value.begin(), value.end(), [](unsigned char c)
        {
            return std::isalnum(c) != 0 || c == '_' || c == '-';
        });
}

inline bool Refuse(std::string& refusal, std::string reason)
{
    refusal = std::move(reason);
    return false;
}

// Builds the command text. `kind`, `action`, `destination` and `gmName` come from the payload;
// everything identifying a ticket or a player comes from `ticket`.
inline bool Compose(std::string const& kind, std::string const& action, TicketTarget const& ticket,
    std::string const& gmName, std::string const& destination, std::string& command, std::string& refusal)
{
    std::string const sourceTicketId = std::to_string(ticket.sourceTicketId);
    std::string out;

    if (kind == "assign_ticket")
    {
        if (ticket.sourceTicketId == 0 || !IsTicketNumber(sourceTicketId) || !IsCharacterName(gmName))
            return Refuse(refusal, "assign_ticket needs an in-game ticket number and a character name.");
        out = ".ticket assign " + sourceTicketId + ' ' + gmName;
    }
    else if (kind == "close_ticket")
    {
        if (ticket.sourceTicketId == 0 || !IsTicketNumber(sourceTicketId))
            return Refuse(refusal, "close_ticket needs an in-game ticket number.");
        // ".ticket close", never ".ticket complete": complete sets only `completed` and leaves
        // `type` at TICKET_TYPE_OPEN, which permanently blocks the player from opening another.
        out = ".ticket close " + sourceTicketId;
    }
    else if (kind == "identity_login" || kind == "identity_logout")
    {
        if (!IsCharacterName(gmName))
            return Refuse(refusal, "an identity command needs a character name.");
        out = ".heimdall identity " + std::string(kind == "identity_login" ? "login " : "logout ") + gmName;
    }
    else if (kind == "gm_action")
    {
        // The ticket's player, not the payload's. A Discord-opened ticket has no character, so
        // there is nobody to act on and the row is refused rather than aimed at a guess.
        if (!IsCharacterName(ticket.playerName))
            return Refuse(refusal, "this ticket has no character to act on.");

        if (action == "revive")
            out = ".revive " + ticket.playerName;
        else if (action == "unstuck")
            out = ".unstuck " + ticket.playerName + " inn";
        else if (action == "combatstop")
            out = ".combatstop " + ticket.playerName;
        else if (action == "kick")
        {
            if (!IsPublicKey(ticket.publicKey))
                return Refuse(refusal, "kick needs the ticket's key for its reason.");
            // One token, not two: cs_misc.cpp declares the reason Optional<std::string_view>, and
            // the parser refuses a command with anything left over.
            out = ".kick " + ticket.playerName + " Ticket-" + ticket.publicKey;
        }
        else if (action == "teleport")
        {
            if (!IsTeleDestination(destination))
                return Refuse(refusal, "teleport needs one destination from the realm's teleport list.");
            out = ".tele name " + ticket.playerName + ' ' + destination;
        }
        else
            return Refuse(refusal, "\"" + action + "\" is not a GM action Heimdall performs.");
    }
    else
        return Refuse(refusal, "\"" + kind + "\" is not a command Heimdall performs.");

    command = out;
    return true;
}
}

#endif
