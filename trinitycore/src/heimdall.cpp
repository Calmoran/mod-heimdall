/*
 * Heimdall for TrinityCore - phase 1 skeleton.
 *
 * Copyright (C) Calmoran. Licensed under the GNU AGPL v3 (see LICENSE at the repository root).
 *
 * This file does exactly one thing: read Heimdall.Enabled and say so at startup. There is no
 * polling, no database, no delivery queue, no GM identity and no contact with Discord - those
 * arrive in later phases. It exists to prove the packaging works: that a script pack in
 * src/server/scripts/Custom compiles into a stock ElunaTrinityWotlk worldserver, that its
 * settings are read from an additional config file, and that its output reaches the log.
 *
 * Reference implementation: the AzerothCore module in src/ at the repository root.
 * Divergences from it so far, each forced by this core:
 *   - No module loader of its own. AzerothCore discovers modules; TrinityCore builds custom
 *     scripts into the worldserver and calls one function from custom_script_loader.cpp, which
 *     is why AddSC_heimdall() below is what an adopter wires up by hand.
 *   - Settings live in an additional config file loaded from worldserver.conf.d rather than in
 *     a modules config directory (see trinitycore/conf/heimdall.conf.dist).
 */

#include "heimdall_shared.h"

#include "Config.h"
#include "Log.h"
#include "ScriptMgr.h"

namespace
{
    bool _enabled = false;
}

class heimdall_world : public WorldScript
{
public:
    heimdall_world() : WorldScript("heimdall_world") { }

    // Runs during World::LoadConfigSettings, before OnStartup, and again on a config reload.
    void OnConfigLoad(bool /*reload*/) override
    {
        _enabled = sConfigMgr->GetBoolDefault("Heimdall.Enabled", false);
    }

    void OnStartup() override
    {
        if (!_enabled)
        {
            // 2.0.0 shipped a guide that never told the operator to enable the module, and the
            // startup line did not say it was off. This one says which setting is off and where.
            TC_LOG_INFO(HEIMDALL_LOG, "Heimdall {} for TrinityCore: the bridge is DISABLED. "
                "Set Heimdall.Enabled = 1 in heimdall.conf to turn it on.", HEIMDALL_VERSION);
            return;
        }

        TC_LOG_INFO(HEIMDALL_LOG, "Heimdall {} for TrinityCore: enabled, but this build is the "
            "phase 1 skeleton - no tickets are polled, no commands are executed and nothing is "
            "sent to Discord.", HEIMDALL_VERSION);
    }
};

// Called from AddCustomScripts() in src/server/scripts/Custom/custom_script_loader.cpp - the one
// file in their own core an adopter edits. See trinitycore/README.md, step 3.
void AddSC_heimdall()
{
    new heimdall_world();
}
