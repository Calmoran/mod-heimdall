# Core patches

One patch, required before building the module.

## `0001-expose-loginqueryholder-to-modules.patch`

### What it does

Moves the `LoginQueryHolder` class declaration out of `CharacterHandler.cpp` and into
`WorldSession.h`, and adds the `QueryHolder.h` include the header then needs. Fifteen lines. No
logic changes, no new functions, no behaviour change — the same class, with the same members in the
same order, declared where other code can see it.

### Why it is needed

Heimdall's GM identities are real characters held in the world with no game client attached. That is
what lets a player whisper a GM identity like any other character, and it is why two-way chat works
without patching the core's chat handling.

Bringing a character in that way means doing what the core's own login path does: build a
`LoginQueryHolder`, run it, and hand the result to `WorldSession::HandlePlayerLoginFromDB`.

`WorldSession.h` already declares that function publicly. But it only *forward-declares*
`LoginQueryHolder`; the class itself lives inside `CharacterHandler.cpp`, which nothing can include.
So the header offers a public function whose argument no other code can construct. This patch
closes that gap and does nothing else.

### Applying it

From the root of your AzerothCore checkout:

```
git apply /path/to/mod-heimdall/patches/0001-expose-loginqueryholder-to-modules.patch
```

Check it applied before building:

```
git diff --stat
```

should show `CharacterHandler.cpp` and `WorldSession.h` changed, 15 insertions and 14 deletions.
If the patch refuses to apply, your core already contains the change; skip it - do not force it.
Or look for the class directly:

```
grep -n "class LoginQueryHolder" src/server/game/Server/WorldSession.h
```

If that prints a line, you are ready to build. If the module still fails to compile with
`use of undefined type 'LoginQueryHolder'`, the patch is not applied to the tree you are building.

### After a core update

A core update can revert this. If your build starts failing with `use of undefined type
'LoginQueryHolder'` after pulling, reapply the patch and rebuild. The failure is a compile error, so
it cannot go unnoticed — the module will not silently half-work.

### The plan

A pull request carrying this change has been submitted to AzerothCore and is awaiting review. If
it is accepted, the patch becomes unnecessary on any core built after that release and this
directory goes away.
