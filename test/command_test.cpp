// Standalone test for Heimdall::Command::Compose. Builds with nothing but a C++17 compiler:
//
//   g++ -std=c++17 -Wall -Wextra -Werror -I src test/command_test.cpp -o command_test && ./command_test
//   cl /std:c++17 /EHsc /W4 /WX /I src test\command_test.cpp && command_test.exe
//
// The cases that matter are the ones named "hostile": a delivery row whose payload disagrees with
// the ticket it is attached to. Before 2026-09-03 the composed command took its target, its ticket
// number and its public key from that payload, so a row written directly into heimdall_delivery
// could aim an allowlisted action at any character on the realm. Compose() no longer has a
// parameter such a row could reach - the target is a TicketTarget the module fills from its own
// heimdall_ticket row - which is why these read as "there is no way to express the attack" rather
// than as "the attack is rejected".

#include "mod_heimdall_command.h"

#include <cstdio>
#include <string>

namespace
{
int failures = 0;

void Expect(char const* name, std::string const& actual, std::string const& expected)
{
    if (actual == expected)
        return;

    ++failures;
    std::printf("FAIL %s\n  expected: %s\n  actual:   %s\n", name, expected.c_str(), actual.c_str());
}

void ExpectTrue(char const* name, bool condition)
{
    if (condition)
        return;

    ++failures;
    std::printf("FAIL %s\n", name);
}

void ExpectContains(char const* name, std::string const& haystack, std::string const& needle)
{
    if (haystack.find(needle) != std::string::npos)
        return;

    ++failures;
    std::printf("FAIL %s\n  %s does not contain %s\n", name, haystack.c_str(), needle.c_str());
}

void ExpectMissing(char const* name, std::string const& haystack, std::string const& needle)
{
    if (haystack.find(needle) == std::string::npos)
        return;

    ++failures;
    std::printf("FAIL %s\n  %s must not contain %s\n", name, haystack.c_str(), needle.c_str());
}

Heimdall::Command::TicketTarget Victim()
{
    Heimdall::Command::TicketTarget ticket;
    ticket.sourceTicketId = 42;
    ticket.publicKey = "Cer-42";
    ticket.playerName = "Alice";
    ticket.playerGuid = 7;
    return ticket;
}

// A Discord-opened ticket: real, but with no character behind it.
Heimdall::Command::TicketTarget Discordless()
{
    Heimdall::Command::TicketTarget ticket;
    ticket.sourceTicketId = 0;
    ticket.publicKey = "DIS-000009";
    return ticket;
}

std::string Compose(std::string const& kind, std::string const& action,
    Heimdall::Command::TicketTarget const& ticket, std::string const& gmName = "Helpbot",
    std::string const& destination = "")
{
    std::string command;
    std::string refusal;
    if (!Heimdall::Command::Compose(kind, action, ticket, gmName, destination, command, refusal))
        return "REFUSED: " + refusal;
    return command;
}
}

int main()
{
    using namespace Heimdall::Command;

    // ---------------------------------------------------------------- the allowed six, composed
    Expect("revive names the ticket's player", Compose("gm_action", "revive", Victim()), ".revive Alice");
    Expect("unstuck sends them to an inn", Compose("gm_action", "unstuck", Victim()), ".unstuck Alice inn");
    Expect("combatstop", Compose("gm_action", "combatstop", Victim()), ".combatstop Alice");
    Expect("kick reasons with the ticket's own key", Compose("gm_action", "kick", Victim()),
        ".kick Alice Ticket-Cer-42");
    Expect("teleport", Compose("gm_action", "teleport", Victim(), "Helpbot", "stormwind"),
        ".tele name Alice stormwind");
    Expect("assign uses the realm's ticket number", Compose("assign_ticket", "", Victim()),
        ".ticket assign 42 Helpbot");
    Expect("close uses the realm's ticket number", Compose("close_ticket", "", Victim()),
        ".ticket close 42");
    Expect("identity login", Compose("identity_login", "", Victim()), ".heimdall identity login Helpbot");
    Expect("identity logout", Compose("identity_logout", "", Victim()), ".heimdall identity logout Helpbot");

    // ------------------------------------------------------------------------------- hostile rows
    //
    // These are the finding. A row written straight into heimdall_delivery, attached to a REAL
    // ticket belonging to Alice, carrying "Mallory" as the target. There is no parameter for that
    // name to arrive through any more: whatever the payload says, the command names Alice.
    {
        // The old signature was Compose(kind, action, sourceTicketId, gmName, playerName,
        // destination, publicKey, ...). Every one of the three fields an attacker controlled is
        // now taken from the ticket instead, so the assertions below are about what CANNOT be
        // expressed, not about what is rejected.
        for (char const* action : { "revive", "unstuck", "combatstop", "kick" })
        {
            std::string const command = Compose("gm_action", action, Victim());
            ExpectContains("a hostile row still names the ticket's player", command, "Alice");
            ExpectMissing("a hostile row cannot name anyone else", command, "Mallory");
        }

        std::string const teleport = Compose("gm_action", "teleport", Victim(), "Helpbot", "stormwind");
        ExpectContains("teleport moves the ticket's player", teleport, "Alice");
        ExpectMissing("teleport cannot move anyone else", teleport, "Mallory");

        // kick's reason came from the payload too, so a forged row could label the kick with
        // another ticket's key.
        ExpectContains("kick is labelled with this ticket's key", Compose("gm_action", "kick", Victim()),
            "Ticket-Cer-42");

        // assign/close took the in-game ticket number from the payload, so a forged row could
        // close somebody else's ticket through a ticket it was entitled to.
        ExpectContains("assign acts on this ticket", Compose("assign_ticket", "", Victim()), " 42 ");
        Expect("close acts on this ticket", Compose("close_ticket", "", Victim()), ".ticket close 42");
    }

    // ------------------------------------------------------- a ticket with no character behind it
    ExpectContains("a Discord ticket has nobody to revive", Compose("gm_action", "revive", Discordless()),
        "REFUSED");
    ExpectContains("a Discord ticket has nobody to kick", Compose("gm_action", "kick", Discordless()),
        "REFUSED");
    ExpectContains("a Discord ticket has no realm ticket to close",
        Compose("close_ticket", "", Discordless()), "REFUSED");
    ExpectContains("a Discord ticket has no realm ticket to assign",
        Compose("assign_ticket", "", Discordless()), "REFUSED");

    // An identity command is about the GM, not the ticket, so it still composes for one.
    Expect("identity still works on a Discord ticket", Compose("identity_login", "", Discordless()),
        ".heimdall identity login Helpbot");

    // ------------------------------------------------------------------- the switch stays closed
    ExpectContains("an unknown action is refused", Compose("gm_action", "ban", Victim()), "REFUSED");
    ExpectContains("an unknown kind is refused", Compose("ban_account", "", Victim()), "REFUSED");
    ExpectContains("a command string in the action is not a command",
        Compose("gm_action", ".ban Someone", Victim()), "REFUSED");
    ExpectContains("a command string in the kind is not a command",
        Compose(".ban Someone", "", Victim()), "REFUSED");

    // --------------------------------------------------- names out of the database are validated
    //
    // The database is not a trusted source of command text. A stored name with a space in it would
    // become a second argument, which is exactly what IsCharacterName exists to stop - and it must
    // keep applying now that the name comes from a ticket row rather than from JSON.
    {
        TicketTarget smuggled = Victim();
        smuggled.playerName = "Alice inn";
        ExpectContains("a stored name that could split a command is refused",
            Compose("gm_action", "revive", smuggled), "REFUSED");

        TicketTarget dotted = Victim();
        dotted.playerName = "Alice.ban";
        ExpectContains("a stored name carrying a dot is refused",
            Compose("gm_action", "revive", dotted), "REFUSED");

        TicketTarget longName = Victim();
        longName.playerName = std::string(13, 'A');
        ExpectContains("a stored name longer than the client allows is refused",
            Compose("gm_action", "revive", longName), "REFUSED");

        TicketTarget key = Victim();
        key.publicKey = "Cer 42; .ban";
        ExpectContains("a stored public key that could split a command is refused",
            Compose("gm_action", "kick", key), "REFUSED");
    }

    // gmName is still payload-supplied, and still validated for shape here. It is gated for
    // AUTHORITY elsewhere: the identity registry only acts for characters in the operator's
    // Heimdall.GmIdentities list, so a forged name resolves to no held identity.
    ExpectContains("a GM name that could split a command is refused",
        Compose("identity_login", "", Victim(), "Helpbot logout"), "REFUSED");
    ExpectContains("an empty GM name is refused", Compose("assign_ticket", "", Victim(), ""), "REFUSED");

    // ------------------------------------------------------------------- destination validation
    ExpectContains("a destination that could split a command is refused",
        Compose("gm_action", "teleport", Victim(), "Helpbot", "stormwind; .ban"), "REFUSED");
    Expect("$home is a legal destination", Compose("gm_action", "teleport", Victim(), "Helpbot", "$home"),
        ".tele name Alice $home");

    // --------------------------------------------------------------------------- the validators
    ExpectTrue("a plain name is a character name", IsCharacterName("Alice"));
    ExpectTrue("a name with a digit is not", !IsCharacterName("Alice1"));
    ExpectTrue("an empty name is not", !IsCharacterName(""));
    ExpectTrue("twelve letters is the limit", IsCharacterName(std::string(12, 'A')));
    ExpectTrue("thirteen is too many", !IsCharacterName(std::string(13, 'A')));
    ExpectTrue("a public key may hyphenate", IsPublicKey("Cer-901"));
    ExpectTrue("a public key may not contain a space", !IsPublicKey("Cer 901"));
    ExpectTrue("a ticket number is digits", IsTicketNumber("42"));
    ExpectTrue("a ticket number is not a word", !IsTicketNumber("42a"));

    if (failures == 0)
        std::printf("command_test: all checks passed\n");
    return failures == 0 ? 0 : 1;
}
