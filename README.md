# mod-heimdall

A Discord ticket system for AzerothCore. `mod-heimdall` is an AGPL-3.0-or-later
module providing a durable Discord and in-game support-ticket bridge. It owns only tables beginning with
`heimdall_` in the Characters database. The companion application is
in the sibling `heimdall-bot` project.

## What it does

- Reads AzerothCore ticket state from `gm_ticket`; it never writes that table.
- Creates idempotent local ticket, event, audit, and delivery-queue records.
- Lets the bot use official SOAP ticket commands for assignment and closure.
- Keeps player-facing replies durable for ordered delivery when the player is online.

## Two-way whisper chat

Each GM identity is a real character the module holds in-world with no game client
attached, so a whisper addressed to it is an ordinary whisper that the stock script
hooks already see. Nothing bypasses normal whisper validation, and the chat path
itself is untouched.

Holding a character that way needs one small patch to stock AzerothCore, shipped in
[patches/](patches/): it moves a class declaration into a header so a module can build
the login query the core's own login path builds. Fifteen lines, no behaviour change.
Cores based on mod-playerbots already carry the equivalent and need nothing. A pull
request to upstream it is planned, after which the patch step disappears.

See [docs/INSTALL.md](docs/INSTALL.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
The companion bot ships the operator documentation, including its limits reference.

License: AGPL-3.0-or-later. The full license text is available from the
[GNU AGPL page](https://www.gnu.org/licenses/agpl-3.0.html).
