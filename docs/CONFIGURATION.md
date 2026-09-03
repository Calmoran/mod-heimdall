# Configuration reference

`DISCORD_TOKEN`, the guild ID, `DISCORD_STAFF_ROLE_IDS`, MySQL values, archive
path, and `BOT_INSTANCE_ID` are required. The exact variables and safe sample
values are in `.env.example`. `MYSQL_DATABASE` is Heimdall's own database - the
value of `Heimdall.Database` in `heimdall.conf`, `heimdall` unless you changed
it - and never a realm database.

Roles are configured as two comma-separated ID lists — names never matter:

- `DISCORD_STAFF_ROLE_IDS` (required, one or many): can answer tickets — see
  unclaimed ones, claim, reply, and close their own.
- `DISCORD_ADMIN_ROLE_IDS` (optional): everything staff can do, plus manage the
  roster, reassign, reopen, and act on tickets claimed by someone else. Empty
  means Discord's Manage Server permission is the admin tier; note that admin-only
  channels are then visible only to members with the Administrator permission,
  since a permission cannot be named in a channel overwrite.

A role in both lists counts once, as admin. The startup log reports how many of
each resolved ("Roles resolved: 1 admin role(s), 3 staff role(s)"), so a typo in
a list shows up as a short count rather than as half your staff quietly locked
out. The legacy `DISCORD_ADMIN_ROLE_ID`, `DISCORD_MODERATOR_ROLE_ID` and
`DISCORD_GM_ROLE_ID` are still read and merged in, so an existing install
upgrades untouched.

Pings follow the tiers: queue nudges mention the staff roles; the empty-roster
fallback mentions the admin roles, or the staff roles when no admin role is
configured — a mention has to land on someone, and a permission cannot be
mentioned.

`DISCORD_BOT_ROLE_ID` is **not** required and is best left unset. The bot's role
is the managed one Discord creates for the application, which is the only role a
bot can be in; Heimdall looks it up. If you do set it, it must be that role's id —
the bot verifies it is actually a member and refuses to start otherwise, before
provisioning anything, because provisioning against a role it is not in produces
channels it can neither read nor repair.

- `DISCORD_SUPPORT_CATEGORY_NAME`: the category Heimdall creates for its own panel
  and queue board; default `Heimdall Support`. Useful if you already have a support
  structure you want these to sit in.

- `ARCHIVE_MAX_ATTACHMENT_BYTES`: maximum downloaded attachment size; default 10 MiB.
- `TRANSCRIPT_RETENTION_DAYS`: detailed transcript/attachment retention; default 180.
- `CLOSED_CHANNEL_DELETE_DAYS`: how long a closed ticket's Discord channel is kept in the
  Closed Tickets category before deletion; `0` deletes immediately; default 7.
  Supersedes `CLOSED_CHANNEL_DELETE_HOURS`, which is still read if present so an existing
  install keeps its current retention. Setting both is refused at startup.
- `DELIVERY_LEASE_SECONDS`: exclusive job lease duration; default 60.
- `DELIVERY_MAX_ATTEMPTS`: retry limit before a job is marked dead; default 12.
- `AUTO_CLOSE_INACTIVE_DAYS`: close tickets nobody has touched for this many days; `0`
  disables it; default 0.
- `COMMAND_AUDIT_CHANNEL`: whether the `gm-command-audit` channel exists at all; default on.
  It governs both writers — the module's command log, and its record of which Discord user
  asked for each command it ran — because they share one channel and
  splitting the decision is what made the bot's half impossible to enable. Off means the
  channel is never created, never recreated if you delete it, and entries already queued are
  discarded rather than retried. Leaving it on is recommended: the realm logs every command
  the bot sends as "Console", and this is the only record of who actually asked for it.
- `QUEUE_NUDGE_MINUTES`: how long a ticket may sit unclaimed before the queue board mentions
  the staff roles, once per ticket; `0` disables it; default 0.

The bot provisions its own Open, Claimed and Closed ticket categories, its panel
channel and its staff-only ticket queue channel on first run, storing their IDs in
`heimdall_setting`. The GM command audit channel is created by whichever
producer first has something to record, unless `COMMAND_AUDIT_CHANNEL` is
switched off (see below).
`DISCORD_PANEL_CHANNEL_ID`, `DISCORD_OPEN_CATEGORY_ID`,
`DISCORD_CLAIMED_CATEGORY_ID` and `DISCORD_CLOSED_CATEGORY_ID` are therefore
optional; set one only to pin the bot to a channel you made yourself, and it
will never be overwritten.

Recommended, not required: after the first run, copy the ids the bot reports
into `.env`.

```
Created open tickets category (1408...) and stored it for future runs.
```

A zero-configuration first run is worth keeping, so nothing forces you to. What
pinning buys you is that the layout is written down somewhere you can read,
rather than living only in `heimdall_setting` where you have to query for it.

An id you set here must exist. Heimdall checks each one at startup and refuses
to start if one does not resolve, naming the variable and the id. It cannot
recover the way it does from a stored id that stopped resolving: creating a
replacement would leave your `.env` still naming the dead channel, and a new
category would appear on every restart.

## Module settings worth knowing about

Every `Heimdall.*` setting is documented beside itself in
[`conf/heimdall.conf.dist`](../conf/heimdall.conf.dist). Three are called out here: one because
2.0.0 introduced it, two because 1.1.0 changed what they do.

- `Heimdall.Database` — **new in 2.0.0**, default `heimdall`. The database, on the same MySQL
  server as the realm, that holds Heimdall's seven tables. The module creates the tables there on
  startup; the database itself, and the core's rights on it, are yours to create first
  (`deploy/create-heimdall-database.sql`). The name must be a plain identifier - letters, digits,
  `_` and `$`, at most 64 characters - and must not be the realm's characters database: the module
  refuses both at startup and disables itself, saying which. Whatever you choose here is what the
  bot's `MYSQL_DATABASE` must name, and what its MySQL account is granted. Upgrading an install
  that has its tables in the characters database is covered under "Upgrading from 1.x" in
  [INSTALL.md](INSTALL.md#upgrading-from-1x).
- `Heimdall.DeliveryPollSeconds` — **default changed from 5 to 1 in 1.1.0.** It used to be a
  background retry cadence for queued whispers. It is now also the delay between a staff member
  pressing Revive, Claim or Close and the realm acting on it, because the bot no longer sends those
  commands itself - it queues them and this poll performs them. Raising it makes every ticket
  control slower by the amount you raise it. Your own `heimdall.conf` is not rewritten by the
  upgrade, so an install that has the old value keeps it: to get the new responsiveness, change
  the line yourself.
- `Heimdall.DeliveryMaxAttempts` — new in 1.1.0, default 12. How many times a queued realm command
  is attempted before it is given up on and reported as a dead letter. Keep it equal to the bot's
  `DELIVERY_MAX_ATTEMPTS`: both halves fail a job by the same rule, and matching values are what
  make the bot's warning and dead letter describe the same job.

  **Nothing enforces the match** — the bot cannot read `heimdall.conf` and the module cannot read
  `.env`, so two different numbers are accepted in silence. The two halves never fight over a row:
  the module gives up on the jobs it runs against the realm, the bot on the ones it delivers to
  Discord. What drift costs is one system that answers *how long before a stuck job is reported*
  two different ways depending on which direction the job was going, and a retry window — roughly
  81 minutes at the default 12, on the shared backoff — that then holds for only one half of it.
  Change one, change the other, and restart both.

## How configuration changes are handled

A setting an operator has already set is a promise. Heimdall keeps it, and these
are the rules it keeps it by. They bind `heimdall.conf` and `.env` equally.

**An existing configuration is never broken silently.** When a setting is
renamed or replaced, the old name keeps working and is folded into the new one.
An install upgrades without an edit, and without a surprise.

**It says so, once, at startup.** A superseded setting that is still in use is
named in a warning that also names its replacement and says it is still
honoured. A warning that reads like a breakage sends somebody to fix it during
an outage, which is the opposite of the point. Being told means the migration
happens when it suits you, and it means a maintainer reading a pasted log can
tell how many installs still carry the old shape.

**Compatibility shims are removed only on a major version**, and the removal is
in the changelog for that version. Between major versions, an old name that
worked keeps working.

**Your file is never rewritten.** Heimdall reads configuration and does not edit
it. Nothing appears in `.env` or `heimdall.conf` that you did not put there, and
nothing is reformatted. Where the bot could save you typing - the provisioned
channel ids - it prints them for you to paste instead, because that file holds
your token and two passwords and a half-finished write would cost you all three.

**A stated range is an enforced range.** Where this reference gives bounds for a
setting, the code applies them. A value outside them is clamped or refused, not
accepted and quietly ignored. Settings whose bounds are not enforced do not
claim any.
