/*
 * Heimdall for TrinityCore - shared declarations.
 *
 * Copyright (C) Calmoran. Licensed under the GNU AGPL v3 (see LICENSE at the repository root).
 *
 * Reference implementation: the AzerothCore module in src/ at the repository root. Every
 * deliberate divergence from it carries a comment naming the core reason.
 */

#ifndef HEIMDALL_SHARED_H
#define HEIMDALL_SHARED_H

// Log output only, exactly as on the AzerothCore side (src/mod_heimdall_shared.h). The two halves
// release together under one version, so this constant, bot/package.json and the AzerothCore
// HEIMDALL_VERSION are bumped in the same commit.
constexpr char const* HEIMDALL_VERSION = "2.0.0";

// Heimdall's own log category. TrinityCore resolves an unconfigured logger against its parents up
// to "root", whose stock level is 5 (error) - an Info line on an unconfigured category would be
// silently dropped. heimdall.conf.dist therefore ships "Logger.heimdall=3,Console Server", and
// worldserver loads the additional config files before it initialises logging, so the setting is
// in place by the time the first line is written.
constexpr char const* HEIMDALL_LOG = "heimdall";

#endif // HEIMDALL_SHARED_H
