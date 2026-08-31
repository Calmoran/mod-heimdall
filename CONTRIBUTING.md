# Contributing

Heimdall is built with agentic tooling, held to AzerothCore's
[agentic engineering rules](https://www.azerothcore.org/wiki/agentic-engineering). Those rules
govern pull requests to the core; this project adopts them as its own standard, because the same
environment — GitHub, pull requests, reviewers — applies here, and because they keep the tooling
honest. Contributions are held to the same six:

1. **Own your code.** Every line is reviewed and understood before it lands. Whoever submits it
   answers questions about it — themselves.
2. **Test for real.** Build it, run it, verify it in game. "It compiles" is not testing. This
   project's bar: the manual test plan in `docs/TESTING.md`, a clean install on a stock core, and
   in-game verification of behaviour down to the `<GM>` badge on a whisper.
3. **Be transparent about AI assistance.** Say so plainly, in the PR. This project does: agentic
   tooling wrote most of it, a human directed, reviewed and tested all of it, and every finding —
   including the tooling's own mistakes — is recorded in the reports that shaped it.
4. **Write like a person.** Issues, PR descriptions, and docs read as a human wrote them, because
   one signs them.
5. **Respect reviewers' time.** Unreviewed agent output is not a contribution. Do not submit what
   you have not read.
6. **Self-review before you submit.** Make an adversarial pass over your own diff first: what
   might be wrong, what was not tested, what would a reviewer object to, what did you assume
   rather than verify. This project's two best bug catches came from exactly that pass.

Changing a setting: read [how configuration changes are handled](docs/CONFIGURATION.md#how-configuration-changes-are-handled)
first. An operator's existing configuration is a promise — renamed settings keep working, the old
name is warned about once at startup rather than broken, shims come out only on a major version, and
their file is never rewritten. A pull request that renames or removes a setting is expected to hold
to that.

Bug reports: include the version — both halves print it at startup — and the log lines around the
problem. The startup lines answer most questions before they are asked.

License: AGPL-3.0-or-later. Contributions are accepted under the same license.
