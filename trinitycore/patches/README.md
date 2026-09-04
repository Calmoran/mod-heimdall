# Core patches (TrinityCore)

Two patches, both required before building Heimdall into your worldserver. They are small,
reviewable and change no behaviour for ordinary sessions. Read them before you apply them — they
are 15 and 6 lines.

Both were verified against **`ElunaLuaEngine/ElunaTrinityWotlk` at commit
`bb74941e685a1e84425668b72afc3cc477fde854`** (2026-08-31, "Merge TrinityCore 3.3.5 to
ElunaTrinityWotlk"). Every claim Heimdall's TrinityCore port makes is made against that commit.
On a newer tip they may need rebasing; `git apply --check` tells you before you commit to
anything.

## `0001-expose-loginqueryholder-to-modules.patch`

### What it does

Moves the `LoginQueryHolder` class declaration out of `CharacterHandler.cpp` and into
`WorldSession.h`, and adds the `QueryHolder.h` include the header then needs. Fifteen lines. The
same class, the same members in the same order, declared where other code can see it.

### Why it is needed

Heimdall's GM identities are real characters held in the world with no game client attached. That
is what lets a player whisper a GM identity like any other character, and it is why two-way chat
works without patching the core's chat handling.

Bringing a character in that way means doing what the core's own login path does: build a
`LoginQueryHolder`, run it, and hand the result to `WorldSession::HandlePlayerLogin`.

`WorldSession.h` already declares that function publicly. But it only *forward-declares*
`LoginQueryHolder`; the class itself lives inside `CharacterHandler.cpp`, which nothing can
include. So the header offers a public function whose argument no other code can construct. This
patch closes that gap and does nothing else.

Without it, code outside `CharacterHandler.cpp` that tries to build one fails to compile:

```
error C2079: 'holder' uses undefined class 'LoginQueryHolder'
```

## `0002-guard-socketless-session-in-worldsession-update.patch`

### What it does

Adds one null check — `m_Socket &&` — to the idle-connection test at the top of
`WorldSession::Update`, plus the comment explaining why. Six lines, five of them comment.

### Why it is needed

A headless GM identity is a `WorldSession` with no client and therefore no socket. The core never
creates such a session on its own, so this line has never had to consider one:

```cpp
if (IsConnectionIdle() && !HasPermission(rbac::RBAC_PERM_IGNORE_IDLE_CONNECTION))
    m_Socket->CloseSocket();
```

`Map::Update` updates the session of every in-world player, so a headless identity reaches this
line. `m_timeOutTime` starts at `0` and `IsConnectionIdle()` is `m_timeOutTime < GameTime::GetGameTime()
&& !m_inQueue`, so it is true from the first tick — and the dereference of a null `m_Socket` then
crashes the worldserver, taking the realm down with it.

This is a configuration the core does not otherwise create, not a case it handles wrongly. The
guard is written so that nothing changes for a session that has a socket.

## Applying them

From the root of your TrinityCore checkout:

```
git apply --check /path/to/mod-heimdall/trinitycore/patches/0001-expose-loginqueryholder-to-modules.patch
git apply --check /path/to/mod-heimdall/trinitycore/patches/0002-guard-socketless-session-in-worldsession-update.patch
```

If both print nothing, they apply cleanly. Then drop `--check` from each to apply them, and
confirm:

```
git diff --stat
```

You should see three files changed: `CharacterHandler.cpp`, `WorldSession.cpp` and
`WorldSession.h`.

Both patches touch `WorldSession.h`, which most of the core includes, so the build that follows is
close to a full rebuild.
