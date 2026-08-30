import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js'

import {
  GM_ACTIONS,
  MODAL_TEXT_LIMITS,
  TICKET_CATEGORIES,
  intakeDescription,
  intakeFields,
  intakeHeadline,
  memberCanWorkTicket,
  safeChannelName,
  sanitizeText,
  splitWowMessage,
  validateGmName,
  validateTeleDestination,
} from './domain.js'

const ALLOWED_MENTIONS = { parse: [], repliedUser: false }
// Discord rejects webhook and username values containing "discord" or "clyde"
// (USERNAME_INVALID_CONTAINS), so this deliberately contains neither.
const WEBHOOK_NAME = 'Ticket Relay'
// Named here rather than in the module, which stays free of presentation.
const CLASS_NAMES = { 1: 'Warrior', 2: 'Paladin', 3: 'Hunter', 4: 'Rogue', 5: 'Priest', 6: 'Death Knight', 7: 'Shaman', 8: 'Mage', 9: 'Warlock', 11: 'Druid' }
const RACE_NAMES = { 1: 'Human', 2: 'Orc', 3: 'Dwarf', 4: 'Night Elf', 5: 'Undead', 6: 'Tauren', 7: 'Gnome', 8: 'Troll', 10: 'Blood Elf', 11: 'Draenei' }
// Only the zones a ticket is likely to come from; anything else falls back to its id.
const ZONE_NAMES = { 1: 'Dun Morogh', 12: 'Elwynn Forest', 14: 'Durotar', 85: 'Tirisfal Glades', 141: 'Teldrassil', 215: 'Mulgore', 1519: 'Stormwind', 1537: 'Ironforge', 1637: 'Orgrimmar', 3487: 'Silvermoon', 4395: 'Dalaran' }
const RESERVED_USERNAME_WORDS = /discord|clyde/i
// Discord sets this on a message that could not add every mentioned role member to the thread.
const FAILED_TO_MENTION_SOME_ROLES_IN_THREAD = 1 << 8

// Every permission the bot actually uses, derived from the calls that need it rather than from the
// install guide - the guide is one of the things this checks. `fatal` marks the ones without which
// tickets do not work at all, as opposed to the ones that degrade.
export const REQUIRED_PERMISSIONS = [
  { flag: PermissionFlagsBits.ViewChannel, name: 'View Channels', fatal: true,
    breaks: 'the bot cannot see ticket channels at all' },
  { flag: PermissionFlagsBits.SendMessages, name: 'Send Messages', fatal: true,
    breaks: 'no ticket header, no replies, no queue board' },
  { flag: PermissionFlagsBits.ReadMessageHistory, name: 'Read Message History', fatal: true,
    breaks: 'headers and the panel cannot be found again, so they are reposted or lost' },
  { flag: PermissionFlagsBits.EmbedLinks, name: 'Embed Links', fatal: true,
    breaks: 'every header and the queue board are embeds and will not post' },
  { flag: PermissionFlagsBits.ManageChannels, name: 'Manage Channels', fatal: true,
    breaks: 'ticket channels and categories cannot be created, moved or deleted' },
  { flag: PermissionFlagsBits.ManageRoles, name: 'Manage Permissions', fatal: true,
    breaks: 'per-ticket visibility cannot be applied, so tickets may be readable by the wrong people' },
  { flag: PermissionFlagsBits.CreatePrivateThreads, name: 'Create Private Threads', fatal: true,
    breaks: 'no ticket gets a staff thread, so no ticket has any controls' },
  { flag: PermissionFlagsBits.SendMessagesInThreads, name: 'Send Messages in Threads', fatal: true,
    breaks: 'staff threads are created empty and stay empty' },
  { flag: PermissionFlagsBits.ManageThreads, name: 'Manage Threads', fatal: false,
    breaks: 'archived staff threads cannot be reopened, so older tickets become unusable' },
  { flag: PermissionFlagsBits.ManageWebhooks, name: 'Manage Webhooks', fatal: false,
    breaks: "in-game messages post as the bot instead of under the player's character name" },
  { flag: PermissionFlagsBits.ManageMessages, name: 'Manage Messages', fatal: false,
    breaks: 'the queue board cannot be pinned' },
  // Needed only when the administrator role is not itself marked mentionable, which is the default.
  // Without it the empty-roster fallback renders its mention as plain text and adds nobody - the
  // silent no-op the fallback exists to prevent.
  { flag: PermissionFlagsBits.MentionEveryone, name: 'Mention @everyone, @here and All Roles', fatal: false,
    breaks: 'with an empty staff roster, the fallback cannot add administrators to a ticket thread' },
]
// Bumped whenever the panel's own components change, so an existing panel is rewritten in place
// rather than left showing buttons that no longer route anywhere.
const PANEL_VERSION = '2'
const STAFF_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
export const ADMIN_PERMISSIONS = [...STAFF_PERMISSIONS, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages]

function ticketIdFrom(customId) {
  const value = Number.parseInt(customId.split(':').at(-1), 10)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid ticket control.')
  return value
}

// Collection#keys() is an Iterator, not an Array. Callers that only build a Set from this were
// fine, but anything calling Array methods on it (isAdmin uses .includes) threw at runtime.
// Spread it once here so every caller gets a real array.
// Discord reports a parent that no longer exists as a form-body error on parent_id, not as a
// missing-channel error, so the numeric code alone does not identify it.
function isMissingCategoryError(error) {
  if (Number(error?.code) !== 50035) return false
  const detail = `${error?.message ?? ''}${JSON.stringify(error?.rawError ?? '')}`
  return detail.includes('CHANNEL_PARENT_INVALID') || detail.includes('parent_id')
}

function actorRoles(interaction) {
  return [...(interaction.member?.roles?.cache?.keys?.() ?? [])]
}

export class HeimdallService {
  constructor({ client, repository, archive, config, soap, logger = console }) {
    this.client = client
    this.repository = repository
    this.archive = archive
    this.config = config
    this.soap = soap
    this.logger = logger
  }

  // Order matters here and was wrong. The queue board used to be created lazily, after
  // verifyPermissions had already run, so on a first install - the run where the configuration is
  // most likely to be wrong - it was the one place never checked. The layout is now complete before
  // anything inspects it, and verifyBotRole comes before all of it because provisioning with the
  // wrong bot role is unrecoverable.
  async initialize() {
    this.guild = await this.client.guilds.fetch(this.config.guildId)
    await this.verifyConfiguredRoles()
    await this.verifyBotRole()
    await this.provisionGuildLayout()
    await this.secureCategories()
    this.client.on('interactionCreate', (interaction) => this.handleInteraction(interaction).catch((error) => this.failInteraction(interaction, error)))
    this.client.on('messageCreate', (message) => this.archiveDiscordMessage(message).catch((error) => this.logger.error('Ticket message archive failed', error)))
    await this.verifyPermissions()
    await this.publishPanel()
    await this.warnIfRosterEmpty()
    this.reportProvisionedIds()
  }

  // A bot cannot be added to a role. Discord creates exactly one managed role per application and
  // that is the only role the bot is ever in. DISCORD_BOT_ROLE_ID sat in .env beside the admin,
  // moderator and GM ids, which an operator genuinely does create by hand, and nothing said this
  // one was different - so the natural thing to do was create a role called "BOT" and paste its id.
  //
  // What that costs is not a warning. Provisioning denies ViewChannel to @everyone and allows it to
  // the configured roles, so the allow lands on a role the bot is not in and it locks itself out of
  // channels it has just created. A server-level permission does not override a channel-level deny,
  // and Discord does not let you manage a channel you cannot view - so secureCategories, whose
  // entire job is repairing overwrites, is locked out as well. Correcting .env afterwards changes
  // nothing, because the overwrites already exist. One wrong id on a first run leaves an install
  // that only manual surgery in Discord can fix.
  //
  // Hence a refusal rather than a warning, and hence the id being optional: the bot can find its own
  // managed role, so the safest configuration is not to set this at all.
  async verifyBotRole() {
    // botRoleFor reads the role cache rather than fetching, so this must not depend on an earlier
    // caller having filled it. Fetching again is cheap and idempotent, and it means reordering
    // initialize() cannot quietly turn this check into "no managed role found".
    await this.guild.roles.fetch()
    const me = await this.guild.members.fetchMe()
    const managed = this.guild.roles.botRoleFor(this.client.user)
      ?? me.roles.cache.find((role) => role.managed)
      ?? null

    if (!this.config.botRoleId) {
      if (!managed) {
        throw new Error('Could not find this application\'s managed role in '
          + `${this.guild.name}. Set DISCORD_BOT_ROLE_ID to the role Discord created for the bot.`)
      }
      this.botRoleId = managed.id
      this.logger.info(`Using this application's managed role ${managed.name} (${managed.id}).`)
      return
    }

    if (me.roles.cache.has(this.config.botRoleId)) {
      this.botRoleId = this.config.botRoleId
      return
    }

    throw new Error(`DISCORD_BOT_ROLE_ID is ${JSON.stringify(this.config.botRoleId)}, which this bot is `
      + 'not a member of. A bot cannot be added to a role you create; it only ever holds the managed '
      + `role Discord made for the application${managed ? `, which is ${managed.name} (${managed.id})` : ''}. `
      + 'Set it to that id, or remove the line entirely and Heimdall will find it itself. '
      + 'Nothing has been provisioned: starting with the wrong role here creates channels this bot '
      + 'cannot read and cannot repair.')
  }

  // Five ids, previously five log lines scattered among everything else, which is what prompted an
  // operator to ask whether the bot could write them into .env for them. It cannot - that file holds
  // the token and two passwords, and a half-finished write would cost them all three - so it prints
  // them together instead, in the form they would have to type.
  reportProvisionedIds() {
    this.logger.info('Provisioned Discord layout. To pin it, add these to your .env:\n'
      + `  DISCORD_PANEL_CHANNEL_ID=${this.ids.panelChannelId}\n`
      + `  DISCORD_QUEUE_CHANNEL_ID=${this.ids.queueChannelId}\n`
      + `  DISCORD_OPEN_CATEGORY_ID=${this.ids.openCategoryId}\n`
      + `  DISCORD_CLAIMED_CATEGORY_ID=${this.ids.claimedCategoryId}\n`
      + `  DISCORD_CLOSED_CATEGORY_ID=${this.ids.closedCategoryId}\n`
      + '  DISCORD_SUPPORT_CATEGORY_ID=' + this.ids.supportCategoryId + '\n'
      + 'Optional: these are already stored in heimdall_setting and survive restarts without it. '
      + 'Pinning buys explicit control and a config you can read, not durability - and it switches '
      + 'off the self-heal that recreates one of these if it is ever deleted.')
  }

  // verifyConfiguredRoles does this for role ids; a missing permission is the same kind of problem
  // and used to surface only as a delivery job retrying to death in a log nobody was reading.
  // Checked in the ticket categories rather than guild-wide, because that is where the work happens
  // and a category overwrite can remove a permission the bot has everywhere else.
  async verifyPermissions() {
    const me = await this.guild.members.fetchMe()
    const places = [['the server', null]]
    const expected = [
      ['Open Tickets', this.ids.openCategoryId],
      ['Claimed Tickets', this.ids.claimedCategoryId],
      ['Closed Tickets', this.ids.closedCategoryId],
      ['Heimdall Support', this.ids.supportCategoryId],
      ['ticket panel', this.ids.panelChannelId],
      ['queue board', this.ids.queueChannelId],
    ]
    for (const [label, id] of expected) {
      if (!id) continue
      const channel = await this.client.channels.fetch(id).catch(() => null)
      if (channel) places.push([`the ${label} category`, channel])
    }

    const problems = []
    for (const [where, channel] of places) {
      const held = channel ? channel.permissionsFor(me) : me.permissions
      for (const permission of REQUIRED_PERMISSIONS) {
        if (held?.has(permission.flag)) continue
        problems.push({ ...permission, where })
      }
    }

    // The count used to be printed on its own, and "places=2" reads exactly like success to an
    // operator who has no idea what the number should be. Both numbers, always, so a short count is
    // visible as a short count.
    const coverage = { checked: REQUIRED_PERMISSIONS.length, places: places.length, expected: expected.length + 1 }
    if (places.length < coverage.expected) {
      this.logger.warn(`Permissions preflight could only check ${places.length} of ${coverage.expected} places: `
        + `${expected.filter(([, id]) => !id).map(([label]) => label).join(', ') || 'some channels could not be fetched'}. `
        + 'A place that cannot be checked is not a place that passed.')
    }

    if (!problems.length) {
      this.logger.info('Permissions preflight passed', coverage)
      return
    }

    for (const problem of problems) {
      const line = `${problem.fatal ? 'MISSING' : 'Missing'} permission "${problem.name}" in ${problem.where}: ${problem.breaks}.`
      if (problem.fatal) this.logger.error(line)
      else this.logger.warn(line)
    }

    // "Cannot work without" used to be printed and then ignored: the bot carried on, provisioned
    // more channels it could not reach, and buried the one line that said what was wrong under the
    // stack traces that followed. Either the wording was wrong or the behaviour was; the wording is
    // right, so it stops here.
    const fatal = problems.filter((problem) => problem.fatal)
    if (fatal.length) {
      throw new Error(`Heimdall is missing ${fatal.length} permission(s) it cannot work without: `
        + `${fatal.map((problem) => `"${problem.name}" in ${problem.where}`).join('; ')}. `
        + 'Fix the bot role, or the overwrites on the ticket categories, and restart. Stopping here '
        + 'rather than continuing to build channels this bot cannot use.')
    }
  }

  // A brand-new install has an empty roster by definition, and the symptom - a thread with nobody
  // in it - looks like a Discord problem rather than a configuration one. Wording matches
  // `npm run diagnose` so an operator sees the same sentence twice rather than two descriptions.
  async warnIfRosterEmpty() {
    const staffIds = await this.repository.activeStaffIds()
    if (staffIds.length) return
    this.logger.warn('No enabled staff. Nobody can claim a ticket, and new staff threads will have no members. '
      + 'Add staff with /ticket staff-add.')
  }

  // A role ID that does not resolve otherwise surfaces much later, as an opaque
  // "Supplied parameter is not a cached User or Role" the first time a ticket channel is created.
  // Fetching roles also populates the cache that PermissionOverwrites.resolve reads.
  async verifyConfiguredRoles() {
    const roles = await this.guild.roles.fetch()
    // DISCORD_BOT_ROLE_ID is deliberately absent: it is optional now, and verifyBotRole checks it
    // properly - that the bot is actually IN it, which resolving the id alone never proved.
    const configured = [
      ...this.config.staffRoleIds.map((id) => ['DISCORD_STAFF_ROLE_IDS', id]),
      ...this.config.adminRoleIds.map((id) => ['DISCORD_ADMIN_ROLE_IDS', id]),
    ]
    const bad = configured
      .filter(([, id]) => !roles.get(id))
      .map(([name, id]) => `${name} entry ${JSON.stringify(id)}`)
    if (bad.length) {
      throw new Error(`These role IDs do not match any role in guild ${this.guild.name}: ${bad.join(', ')}. `
        + 'Check for stray characters and confirm each is a role ID, not a channel or user ID.')
    }

    // Both counts, always: a typo in a comma-separated list drops entries silently at the parse,
    // and "the bot works but half my staff cannot see tickets" is this line's job to prevent.
    this.logger.info(`Roles resolved: ${this.config.adminRoleIds.length} admin role(s), `
      + `${this.config.staffRoleIds.length} staff role(s).`
      + (this.config.adminRoleIds.length ? '' : ' No admin role is configured, so ticket administration '
        + 'falls back to Discord\'s Manage Server permission, and admin-only channels are visible only '
        + 'to members with the Administrator permission.'))
  }

  // Reduces a new install's Discord configuration to a token and a guild ID. Anything not
  // explicitly configured is created here and its ID stored, so later runs reuse it. If an object
  // was deleted in Discord, the stored ID stops resolving and it is recreated.
  async provisionGuildLayout() {
    // Populates the channel cache so new categories can be appended to the end of the list. A bot
    // being installed should add itself at the bottom, not reorder an established server's sidebar
    // and push the operator's own channels down.
    await this.guild.channels.fetch()
    const position = this.guild.channels.cache.size + 1

    // Everything the bot creates for itself lives in one category, so an operator evaluating
    // Heimdall - or removing it - has one place to look. The panel channel and the queue board used
    // to be created loose at the top of the guild, which was both untidy and inconsistent with the
    // three ticket categories beside them.
    //
    // The two have opposite audiences and that is fine: the category carries no overwrites, so the
    // panel channel stays visible to players, while the queue board keeps its own deny on @everyone.
    const supportCategoryId = await this.resolveGuildChannel({
      configured: this.config.supportCategoryId,
      envVar: 'DISCORD_SUPPORT_CATEGORY_ID',
      settingKey: 'discord.support_category_id',
      describe: 'Heimdall support category',
      create: () => this.guild.channels.create({ name: this.config.supportCategoryName, type: ChannelType.GuildCategory, position, reason: 'mod-heimdall first run' }),
    })

    this.ids = {
      supportCategoryId,
      openCategoryId: await this.resolveGuildChannel({
        configured: this.config.openCategoryId,
        envVar: 'DISCORD_OPEN_CATEGORY_ID',
        settingKey: 'discord.open_category_id',
        describe: 'open tickets category',
        create: () => this.guild.channels.create({ name: 'Open Tickets', type: ChannelType.GuildCategory, position, reason: 'mod-heimdall first run' }),
      }),
      claimedCategoryId: await this.resolveGuildChannel({
        configured: this.config.claimedCategoryId,
        envVar: 'DISCORD_CLAIMED_CATEGORY_ID',
        settingKey: 'discord.claimed_category_id',
        describe: 'claimed tickets category',
        create: () => this.guild.channels.create({ name: 'Claimed Tickets', type: ChannelType.GuildCategory, position, reason: 'mod-heimdall first run' }),
      }),
      closedCategoryId: await this.resolveGuildChannel({
        configured: this.config.closedCategoryId,
        envVar: 'DISCORD_CLOSED_CATEGORY_ID',
        settingKey: 'discord.closed_category_id',
        describe: 'closed tickets category',
        create: () => this.guild.channels.create({ name: 'Closed Tickets', type: ChannelType.GuildCategory, position, reason: 'mod-heimdall first run' }),
      }),
      panelChannelId: await this.resolveGuildChannel({
        configured: this.config.panelChannelId,
        envVar: 'DISCORD_PANEL_CHANNEL_ID',
        settingKey: 'discord.panel_channel_id',
        describe: 'ticket panel channel',
        create: () => this.guild.channels.create({ name: 'open-a-ticket', type: ChannelType.GuildText, parent: supportCategoryId, reason: 'mod-heimdall first run' }),
      }),
      // Provisioned here rather than lazily on the first board refresh. Created late, it was the one
      // place the permissions preflight could never check on a first run - the run where the
      // configuration is most likely to be wrong.
      queueChannelId: await this.resolveGuildChannel({
        configured: this.config.queueChannelId,
        envVar: 'DISCORD_QUEUE_CHANNEL_ID',
        settingKey: 'discord.queue_channel_id',
        describe: 'ticket queue channel',
        create: () => this.guild.channels.create({
          name: 'ticket-queue',
          type: ChannelType.GuildText,
          parent: supportCategoryId,
          topic: 'Open tickets, oldest first. Updated automatically.',
          // Staff only, denied to everyone else from the moment it exists. A player must never see
          // which tickets are unclaimed and how long they have been ignored.
          permissionOverwrites: [
            { id: this.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: this.botRoleId, allow: ADMIN_PERMISSIONS },
            ...this.staffOverwriteEntries(),
          ],
          reason: 'mod-heimdall queue board',
        }),
      }),
    }
  }

  // Category-level overwrites, so a player never sees a ticket category in their sidebar.
  // Channel-level overwrites still govern each ticket channel, so an author keeps seeing their
  // own open ticket inside a category that is otherwise invisible to them.
  categoryOverwrites() {
    return [
      { id: this.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: this.botRoleId, allow: ADMIN_PERMISSIONS },
      ...this.staffOverwriteEntries(),
    ]
  }

  // Applied every start, not just at creation, so categories made by an earlier version are
  // corrected too.
  async secureCategories() {
    for (const id of [this.ids.openCategoryId, this.ids.claimedCategoryId, this.ids.closedCategoryId]) {
      const category = await this.client.channels.fetch(id).catch(() => null)
      if (!category) continue
      await category.permissionOverwrites.set(this.categoryOverwrites(), 'Ticket categories are staff-only')
        .catch((error) => this.logger.warn(`Could not secure category ${id}: ${error.message}`))
    }
  }

  // Operators reorganise their Discord while the bot is running, so a category disappearing under
  // it is ordinary behaviour rather than abuse. resolveGuildChannel already recreates a vanished
  // category, but it only ran at startup: the ids cached in this.ids stayed stale, and every
  // delivery failed with a raw API stack trace until somebody restarted the bot. Nothing was lost -
  // the jobs retried with backoff - but the log said only "Category does not exist", naming neither
  // the cause nor the remedy.
  //
  // The action is re-run rather than resumed, so it has to read this.ids inside the callback for
  // the retry to pick up the replacement id.
  async withFreshCategories(describe, action) {
    try {
      return await action()
    } catch (error) {
      if (!isMissingCategoryError(error)) throw error
      this.logger.warn(`${describe} failed because a ticket category no longer exists in Discord. `
        + 'Recreating the ticket categories and retrying once. Nothing is lost either way: deliveries '
        + 'retry with backoff.')
      await this.provisionGuildLayout()
      await this.secureCategories()
      return action()
    }
  }

  async resolveGuildChannel({ configured, settingKey, describe, create, envVar }) {
    // An explicitly configured real ID always wins and is never overwritten. It is checked rather
    // than trusted: an id pointing at something deleted cannot be recovered from automatically the
    // way a stored one can, because .env would still name the dead channel and a replacement would
    // be created on every restart. Refusing at startup is the only honest option, and it matches
    // how verifyConfiguredRoles already treats a role id that resolves to nothing.
    if (configured) {
      const existing = await this.client.channels.fetch(configured).catch(() => null)
      if (existing) return configured
      throw new Error(`${envVar} is set to ${JSON.stringify(configured)}, which is not a channel in `
        + `${this.guild.name}. Correct it, or remove it from .env and Heimdall will create the `
        + `${describe} itself and remember it.`)
    }

    const stored = await this.repository.getSetting(settingKey)
    if (stored) {
      const existing = await this.client.channels.fetch(stored).catch(() => null)
      if (existing) return stored
      this.logger.warn(`Stored ${describe} ${stored} no longer exists in Discord; creating a replacement.`)
    }

    const created = await create()
    await this.repository.setSetting(settingKey, created.id)
    this.logger.info(`Created ${describe} (${created.id}) and stored it for future runs.`)
    return created.id
  }

  isAdmin(interaction) {
    if (this.config.adminRoleIds.length) {
      const roles = actorRoles(interaction)
      return this.config.adminRoleIds.some((id) => roles.includes(id))
    }
    // No admin role configured: Discord's own Manage Server permission is the admin tier. Anyone
    // who can administer the guild can administer the roster - no configuration, and it matches
    // how most bots behave.
    return Boolean(interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild))
  }

  // One overwrite entry per role, whatever the lists say. A role in both lists gets admin
  // permissions and appears ONCE - Discord rejects an overwrite array with duplicate targets, which
  // is exactly what the old "set all three variables to the same id" workaround would have built.
  staffOverwriteEntries() {
    const admin = new Set(this.config.adminRoleIds)
    return [
      ...this.config.adminRoleIds.map((id) => ({ id, allow: ADMIN_PERMISSIONS })),
      ...this.config.staffRoleIds.filter((id) => !admin.has(id)).map((id) => ({ id, allow: STAFF_PERMISSIONS })),
    ]
  }

  // Who to address when something needs a human with authority: the admin roles when any are
  // configured, otherwise the staff roles - a mention must land on someone, and a Discord
  // permission cannot be mentioned.
  escalationRoleIds() {
    return this.config.adminRoleIds.length ? this.config.adminRoleIds : this.config.staffRoleIds
  }

  roleMentions(ids) {
    return ids.map((id) => `<@&${id}>`).join(' ')
  }

  canWork(interaction) {
    return memberCanWorkTicket(actorRoles(interaction), this.config)
  }

  async requireRosteredStaff(interaction) {
    if (!this.canWork(interaction)) throw new Error('You need the Admin, Moderator, or Game Master role.')
    const staff = await this.repository.staff(interaction.user.id)
    if (!staff) throw new Error('You are not in the staff roster. Ask an administrator to add your GM name first.')
    validateGmName(staff.gm_name)
    return staff
  }

  // One button, not one per ticket type. The types live in TICKET_CATEGORIES and reach the user
  // through the select menu below, so adding one changes no code here.
  panelComponents() {
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket:create-menu').setLabel('Open a ticket').setStyle(ButtonStyle.Primary),
    )]
  }

  panelEmbed() {
    return new EmbedBuilder()
      .setTitle('Open a private ticket')
      .setDescription('Press the button and choose what you need. Only you and the staff team can see the ticket you open. One open Discord ticket per person is allowed.')
  }

  categoryMenuRow() {
    return new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('ticket:create-pick')
        .setPlaceholder('What do you need?')
        // Discord takes 25 options at most, and the registry is built to be added to.
        .addOptions(Object.entries(TICKET_CATEGORIES)
          .filter(([, category]) => category.action === 'ticket')
          .slice(0, 25)
          .map(([key, category]) => ({ value: key, label: category.label, description: category.description }))),
    )
  }

  async publishPanel() {
    // An unguarded fetch here killed the bot after login with a bare "Unknown Channel" - no variable
    // named, no remedy - when a pinned panel channel had been deleted. resolveGuildChannel now
    // refuses earlier with a proper message, so this should be unreachable; it says the same thing
    // rather than trusting that.
    const panel = await this.client.channels.fetch(this.ids.panelChannelId).catch(() => null)
    if (!panel) throw new Error(`The ticket panel channel ${this.ids.panelChannelId} does not exist in `
      + `${this.guild.name}. If DISCORD_PANEL_CHANNEL_ID is set in .env, correct it or remove it and `
      + 'Heimdall will provision one.')
    if (!panel?.isTextBased()) throw new Error(`Panel channel ${this.ids.panelChannelId} is not a text channel. Clear DISCORD_PANEL_CHANNEL_ID to let the bot provision one.`)
    const existingId = await this.repository.getSetting('discord.panel_message_id')
    if (existingId) {
      const existing = await panel.messages.fetch(existingId).catch(() => null)
      // Editing rather than reposting keeps the message id, so pins and links to the panel survive
      // and no one is left with an older panel whose buttons no longer route anywhere.
      if (existing) {
        if (await this.repository.getSetting('discord.panel_version') !== PANEL_VERSION) {
          await existing.edit({ embeds: [this.panelEmbed()], components: this.panelComponents(), allowedMentions: ALLOWED_MENTIONS })
          await this.repository.setSetting('discord.panel_version', PANEL_VERSION)
          this.logger.log(`Ticket panel migrated to version ${PANEL_VERSION}.`)
        }
        await this.warnAboutStalePanels(panel, existing.id)
        return existing
      }
    }
    const message = await panel.send({
      embeds: [this.panelEmbed()],
      components: this.panelComponents(),
      allowedMentions: ALLOWED_MENTIONS,
    })
    await this.repository.setSetting('discord.panel_message_id', message.id)
    await this.repository.setSetting('discord.panel_version', PANEL_VERSION)
    return message
  }

  // A panel the bot lost track of keeps working buttons that route to a form nobody is
  // maintaining. Naming it is as far as this goes: deleting a message in the operator's guild is
  // their call, not ours.
  async warnAboutStalePanels(panel, currentId) {
    const recent = await panel.messages.fetch({ limit: 50 }).catch(() => null)
    if (!recent) return
    const stale = recent.filter((message) => message.id !== currentId
      && message.author?.id === this.client.user.id
      && message.components?.some((row) => row.components?.some((component) => component.customId?.startsWith('ticket:create'))))
    for (const message of stale.values()) {
      this.logger.warn(`A second ticket panel is still posted in #${panel.name}: ${message.url}. Delete it - only the tracked panel is kept up to date.`)
    }
  }

  // A ticket's creator or claimant is not necessarily cached - after a restart, typically neither
  // is. Same failure verifyConfiguredRoles exists to prevent, from the same cause.
  async cacheOverwriteTargets(ticket) {
    for (const id of [ticket.discord_creator_id, ticket.claimant_discord_user_id]) {
      if (!id || this.guild.members.cache.has(id)) continue
      await this.guild.members.fetch(id).catch(() => this.logger.warn(`Ticket ${ticket.public_key} references user ${id}, who is not in the guild.`))
    }
  }

  overwrites(ticket) {
    const entries = [
      { id: this.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: this.botRoleId, allow: ADMIN_PERMISSIONS },
      ...this.config.adminRoleIds.map((id) => ({ id, allow: ADMIN_PERMISSIONS })),
    ]
    // The author keeps access only while the ticket is live. Once it is closed the channel
    // disappears for them: a closed ticket is not a place to keep talking, and the transcript is
    // retained for staff, not for continued conversation.
    const stillLive = ticket.status !== 'closed' && ticket.status !== 'cancelled'
    if (ticket.source === 'discord' && ticket.discord_creator_id && stillLive) {
      entries.push({ id: ticket.discord_creator_id, allow: STAFF_PERMISSIONS })
    }
    if (ticket.status !== 'open' && ticket.claimant_discord_user_id) {
      entries.push({ id: ticket.claimant_discord_user_id, allow: STAFF_PERMISSIONS })
    } else {
      const admin = new Set(this.config.adminRoleIds)
      for (const id of this.config.staffRoleIds.filter((roleId) => !admin.has(roleId))) {
        entries.push({ id, allow: STAFF_PERMISSIONS })
      }
    }
    return entries
  }

  async createTicketChannel(ticket, label) {
    await this.cacheOverwriteTargets(ticket)
    const channel = await this.withFreshCategories(`Creating a channel for ${ticket.public_key}`, () => this.guild.channels.create({
      name: safeChannelName(ticket.public_key, label),
      type: ChannelType.GuildText,
      parent: this.ids.openCategoryId,
      topic: `mod-heimdall:${ticket.public_key}`,
      permissionOverwrites: this.overwrites(ticket),
      reason: `Ticket ${ticket.public_key} created`,
    }))
    await this.repository.setChannel(ticket.id, channel.id)
    return channel
  }

  controls(ticket) {
    const first = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ticket:claim:${ticket.id}`).setLabel('Claim').setStyle(ButtonStyle.Success),
      // Disabled while unclaimed: replying requires an assigned GM, and finding that out only
      // after typing a whole message is a poor way to learn it.
      new ButtonBuilder().setCustomId(`ticket:reply:${ticket.id}`).setLabel('Reply to Player').setStyle(ButtonStyle.Primary)
        .setDisabled(ticket.source !== 'ingame' || !ticket.claimant_discord_user_id),
      new ButtonBuilder().setCustomId(`ticket:note:${ticket.id}`).setLabel('Add Note').setStyle(ButtonStyle.Secondary),
    )
    const second = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ticket:request-close:${ticket.id}`).setLabel('Request Closure').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`ticket:close:${ticket.id}`).setLabel('Close').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`ticket:reopen:${ticket.id}`).setLabel('Reopen').setStyle(ButtonStyle.Secondary),
    )
    const third = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ticket:identity-login:${ticket.id}`).setLabel('Log In To Game').setStyle(ButtonStyle.Success).setDisabled(ticket.source !== 'ingame'),
      new ButtonBuilder().setCustomId(`ticket:identity-logout:${ticket.id}`).setLabel('Log Out Of Game').setStyle(ButtonStyle.Secondary).setDisabled(ticket.source !== 'ingame'),
    )
    // Player-card controls. In-game only: a Discord-native ticket has no character behind it,
    // so there is nothing to refresh and no account to hang a note on.
    const fourth = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ticket:refresh-context:${ticket.id}`).setLabel('Refresh Player Info').setStyle(ButtonStyle.Secondary).setDisabled(ticket.source !== 'ingame'),
      new ButtonBuilder().setCustomId(`ticket:remove-note:${ticket.id}`).setLabel('Remove Note').setStyle(ButtonStyle.Secondary).setDisabled(ticket.source !== 'ingame'),
    )
    // Acting on the player, from the thread rather than an alt-tab. In-game only, and every one of
    // these needs a character to act on.
    const fifth = new ActionRowBuilder().addComponents(
      ...Object.entries(GM_ACTIONS).map(([key, action]) => new ButtonBuilder()
        .setCustomId(`ticket:gm-${key}:${ticket.id}`)
        .setLabel(action.label)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(ticket.source !== 'ingame' || !ticket.player_name)),
    )
    // Five rows is Discord's ceiling for one message. There is no room for a sixth without moving
    // something into a menu.
    return [first, second, third, fourth, fifth]
  }

  // One pinned message that answers "what is waiting, and for how long" without opening anything.

  // Resolution only. The channel is provisioned in provisionGuildLayout so the preflight can see it;
  // creating it here meant it did not exist yet on the run that most needed checking.
  async queueBoardChannel() {
    const id = this.ids?.queueChannelId ?? await this.repository.getSetting('discord.queue_channel_id')
    if (!id) return null
    const channel = await this.client.channels.fetch(id).catch(() => null)
    if (!channel) this.logger.warn(`The ticket queue channel (${id}) could not be fetched. `
      + 'The queue board cannot be drawn until it is back; restart to have it recreated.')
    return channel
  }

  queueBoardEmbed(rows) {
    const embed = new EmbedBuilder().setTitle('Open tickets')
    if (!rows.length) {
      return embed.setDescription('Nothing open. The queue is empty.')
    }

    const lines = []
    let shown = 0
    for (const row of rows) {
      const held = row.claimant_discord_user_id
        ? `held by <@${row.claimant_discord_user_id}>${row.claimant_gm_name ? ` (${row.claimant_gm_name})` : ''}`
        : `**unclaimed for ${this.formatDuration(row.unclaimed_seconds)}**`
      const line = `\`${row.public_key}\` · ${TICKET_CATEGORIES[row.category]?.label ?? row.category} · open ${this.formatDuration(row.open_seconds)} · ${held}`
      // An embed description holds 4096 characters. Rather than spill onto a second message that
      // cannot be pinned as "the board" and would drift out of order, the oldest tickets are kept
      // and the remainder is counted.
      if (lines.join('\n').length + line.length > 3800) break
      lines.push(line)
      shown += 1
    }
    if (shown < rows.length) lines.push(`*…and ${rows.length - shown} more. Oldest are listed first.*`)
    return embed
      .setDescription(lines.join('\n'))
      .setFooter({ text: `${rows.length} open · updated` })
      .setTimestamp(new Date())
  }

  async refreshQueueBoard() {
    const channel = await this.queueBoardChannel()
    if (!channel) return null
    const rows = await this.repository.queueSnapshot()
    const embed = this.queueBoardEmbed(rows)

    const storedId = await this.repository.getSetting('discord.queue_message_id')
    let message = storedId ? await channel.messages.fetch(storedId).catch(() => null) : null
    if (message) {
      await message.edit({ embeds: [embed], allowedMentions: ALLOWED_MENTIONS })
    } else {
      message = await channel.send({ embeds: [embed], allowedMentions: ALLOWED_MENTIONS })
      await this.repository.setSetting('discord.queue_message_id', message.id)
      await this.pinWithRetry(message, 'Ticket queue board')
    }
    await this.nudgeUnclaimed(channel, rows)
    return message
  }

  // On the run that creates the queue channel, the pin is attempted before Discord has finished
  // applying the channel's new overwrites, and fails with "Missing Permissions" - which is not true
  // and reads alarmingly on a first install. It succeeds on the next start with nothing changed, so
  // it is a propagation race rather than a permission fault. One retry is enough.
  async pinWithRetry(message, reason) {
    try {
      await message.pin(reason)
      return true
    } catch (firstError) {
      await new Promise((resolve) => { setTimeout(resolve, 2_000) })
      try {
        await message.pin(reason)
        return true
      } catch (error) {
        this.logger.warn(`Could not pin the queue board: ${error.message} (first attempt: ${firstError.message})`)
        return false
      }
    }
  }

  // Off unless an operator asks for it: an existing install should not start being pinged by a
  // feature it never turned on. Each ticket is nudged once, recorded in the audit trail.
  async nudgeUnclaimed(channel, rows) {
    const minutes = this.config.queueNudgeMinutes
    if (!minutes) return
    for (const row of rows) {
      if (!row.never_claimed || row.unclaimed_seconds < minutes * 60) continue
      if (await this.repository.hasAudit(row.id, 'queue_nudge')) continue
      await channel.send({
        content: `${this.roleMentions(this.config.staffRoleIds)} \`${row.public_key}\` has been unclaimed for ${this.formatDuration(row.unclaimed_seconds)}.`,
        allowedMentions: { parse: [], roles: this.config.staffRoleIds, repliedUser: false },
      })
      // Recorded only once the mention is out. Recorded first, a failed send would mark the ticket
      // nudged and nobody would ever be told.
      await this.repository.audit(row.id, 'queue_nudge', 'system', { unclaimedSeconds: row.unclaimed_seconds })
    }
  }

  // Discord cannot hide a message's components from some viewers of a channel, and a
  // Discord-created ticket grants its author view access. So everything staff-facing lives in a
  // private thread the author is not a member of.

  staffThreadName(ticket) {
    return `staff-${ticket.public_key}`.slice(0, 90)
  }

  async ensureStaffThread(channel, ticket) {
    const storedId = await this.repository.getThreadId(ticket.id)
    if (storedId) {
      const existing = await this.client.channels.fetch(storedId).catch(() => null)
      // Discord archives threads after inactivity; an archived thread rejects new messages.
      if (existing) {
        if (existing.archived) await existing.setArchived(false, 'Ticket still needs staff attention')
        return existing
      }
      this.logger.warn(`Stored staff thread ${storedId} for ${ticket.public_key} is gone; creating a replacement.`)
    }

    const thread = await channel.threads.create({
      name: this.staffThreadName(ticket),
      type: ChannelType.PrivateThread,
      invitable: false,
      autoArchiveDuration: 10080,
      reason: `Staff workspace for ${ticket.public_key}`,
    })
    await this.repository.setThreadId(ticket.id, thread.id)

    const staffIds = await this.repository.activeStaffIds()
    if (staffIds.length) {
      await this.addStaffToThread(thread, staffIds)
      this.logger.info('Staff thread created', { ticket: ticket.public_key, members: staffIds.length })
      return thread
    }

    // Nobody is rostered, so adding members one at a time has nobody to add and the thread would
    // contain only the bot - a ticket no one can see or work, with nothing saying why.
    //
    // Mentioning a role inside a thread makes Discord add that role's members to it. This is not
    // in the threads documentation but it is what the FAILED_TO_MENTION_SOME_ROLES_IN_THREAD
    // message flag exists to report, and it was confirmed against a live private thread: a member
    // removed from the thread was re-added by the mention alone. It needs no privileged intent,
    // which is why the administrator fallback does not read the member list.
    //
    // The message is staff-side by construction - a private thread the ticket's author is not in.
    // The mention is also the join mechanism, so it must land on real roles. With no admin role
    // configured there is no way to mention "whoever has Manage Server" - a permission cannot be
    // mentioned - so the staff roles are addressed instead: their members get added to the thread
    // and the message says who has to act.
    const fallbackRoles = this.escalationRoleIds()
    const instruction = this.config.adminRoleIds.length
      ? 'You have been added as administrators. Run `/ticket staff-add` to roster the staff who should be handling tickets.'
      : 'No admin role is configured, so someone with the Manage Server permission must run `/ticket staff-add` to roster the staff who should be handling tickets.'
    const notice = await thread.send({
      content: `${this.roleMentions(fallbackRoles)} Nobody is on the Heimdall staff roster, so this ticket had `
        + `no one to add. ${instruction}`,
      allowedMentions: { parse: [], roles: fallbackRoles, repliedUser: false },
    })

    // Discord sets this flag when it could not add some of the mentioned role's members.
    const incomplete = Boolean((notice.flags?.bitfield ?? 0) & FAILED_TO_MENTION_SOME_ROLES_IN_THREAD)
    this.logger.warn('Staff thread created with no roster; mentioned the administrator role to add members',
      { ticket: ticket.public_key, incomplete })

    return thread
  }

  // Private threads have no role-based visibility: members are added individually. Everyone on
  // the staff roster is added up front, because an unclaimed ticket has no claimant yet and the
  // controls have to be reachable by whoever picks it up.
  async addStaffToThread(thread, ids = null) {
    const staffIds = ids ?? await this.repository.activeStaffIds()
    let added = 0
    for (const id of staffIds) {
      const ok = await thread.members.add(id).then(() => true).catch((error) => {
        this.logger.warn(`Could not add ${id} to ${thread.name}: ${error.message}`)
        return false
      })
      if (ok) added += 1
    }
    return added
  }

  // Staff rostered after a ticket opened are not in that ticket's thread, and a private thread has
  // no role-based visibility to fall back on - so without this they are invisible in every ticket
  // already running until somebody opens a new one.
  //
  // Thread ids live in the settings table rather than a column (the schema is frozen), so there is
  // no query that returns "open tickets with threads". Walking the open tickets and asking for each
  // one's thread is the shape the data actually has.
  async addStaffToOpenThreads(discordUserId) {
    let joined = 0
    for (const ticket of await this.repository.ticketsWithOpenWork()) {
      const threadId = await this.repository.getThreadId(ticket.id)
      if (!threadId) continue
      const thread = await this.client.channels.fetch(threadId).catch(() => null)
      if (!thread) continue
      // Discord archives a thread after a week of quiet, and an archived thread takes no members.
      if (thread.archived) await thread.setArchived(false, 'Adding newly rostered staff').catch(() => null)
      if (await this.addStaffToThread(thread, [discordUserId])) joined += 1
    }
    return joined
  }


  formatDuration(seconds) {
    // Zero is a real answer - a ticket opened a moment ago - and only a missing value is unknown.
    if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds)) || seconds < 0) return 'unknown'
    const days = Math.floor(seconds / 86400)
    const hours = Math.floor((seconds % 86400) / 3600)
    if (days) return `${days}d ${hours}h`
    const minutes = Math.floor((seconds % 3600) / 60)
    return hours ? `${hours}h ${minutes}m` : `${minutes}m`
  }

  playerContextLines(context) {
    if (!context) return ['No character context yet — it appears within a minute of the ticket opening.']
    const now = Math.floor(Date.now() / 1000)
    const cls = CLASS_NAMES[context.class] ?? `class ${context.class}`
    const race = RACE_NAMES[context.race] ?? `race ${context.race}`
    const zone = ZONE_NAMES[context.zoneId] ?? (context.zoneId ? `zone ${context.zoneId}` : 'unknown')
    return [
      `**${context.name}** — level ${context.level} ${race} ${cls}`,
      `Zone: ${zone}`,
      `Played: ${this.formatDuration(context.totalPlaytime)} · Account age: ${this.formatDuration(now - (context.accountCreated ?? now))}`,
      `Last seen: ${context.lastLogout ? `<t:${context.lastLogout}:R>` : 'unknown'}`,
    ]
  }

  // Deliberately its own field, not a line in the card: whether a whisper lands now or waits until
  // login is what decides how a GM writes the reply.
  onlineLine(context) {
    if (!context) return 'Player: unknown'
    const captured = context.capturedAt ? `<t:${context.capturedAt}:R>` : 'just now'
    return context.online
      ? `Player is **online** — a whisper reaches them now. Checked ${captured}.`
      : `Player is **offline** — a reply queues until they log in. Checked ${captured}.`
  }

  historyLines(history) {
    if (!history || !history.total) return ['First ticket from this account in the last 180 days.']
    const lines = [`**${history.total}** ticket(s) from this account in the last ${history.days} days.`]
    for (const row of history.recent) {
      const when = new Date(row.opened_at).toISOString().slice(0, 10)
      lines.push(`• ${row.public_key} (${when}, ${row.status}${row.claimant_gm_name ? `, ${row.claimant_gm_name}` : ''})`)
    }
    return lines
  }

  // The auth account behind a ticket. Tickets written before the account column existed carry
  // NULL, so the context snapshot is the fallback.
  async ticketAccountId(ticket) {
    if (ticket.player_account_id) return ticket.player_account_id
    const context = await this.repository.playerContext(ticket.id).catch(() => null)
    return context?.accountId ?? null
  }

  noteLines(notes) {
    if (!notes.length) return ['No notes on this account.']
    return notes.slice(0, 5).map((note) => {
      const when = new Date(note.createdAt).toISOString().slice(0, 10)
      // A note may run to 1800 characters. Five of those do not fit in an embed field, and an
      // oversized field rejects the whole header rather than just the note.
      const body = note.body.length > 180 ? `${note.body.slice(0, 179)}…` : note.body
      return `• \`#${note.id}\` ${when} <@${note.actorRef}>: ${body}`
    })
  }

  // An embed field value is capped at 1024 characters and Discord rejects the whole message
  // when one is over, so every field is fitted here rather than trusted to be short.
  fieldValue(lines) {
    const kept = []
    let length = 0
    for (const line of lines) {
      const cost = line.length + (kept.length ? 1 : 0)
      if (length + cost > 990) {
        kept.push(`…and ${lines.length - kept.length} more`)
        break
      }
      kept.push(line)
      length += cost
    }
    return kept.join('\n') || '—'
  }

  async headerEmbed(ticket, description = '') {
    const source = ticket.source === 'ingame' ? `In-game ticket from **${ticket.player_name ?? 'Unknown'}**` : 'Discord-native ticket'
    const embed = new EmbedBuilder()
      .setTitle(ticket.public_key)
      .setDescription(`${source}\n\n${description || 'No description supplied.'}`)
      .setFooter({ text: 'Staff messages are internal. Use Reply to Player for in-game messages.' })
    // What the player told the intake form, so staff can see where the problem is without reading
    // the description first.
    if (ticket.source === 'discord') {
      const intake = await this.repository.ticketIntake(ticket.id).catch(() => null)
      const headline = intakeHeadline(ticket.category, intake)
      if (headline.length) embed.addFields({ name: 'Reported', value: this.fieldValue(headline) })
    }
    if (ticket.source === 'ingame') {
      const context = await this.repository.playerContext(ticket.id).catch(() => null)
      const accountId = ticket.player_account_id ?? context?.accountId ?? null
      const [history, notes] = await Promise.all([
        this.repository.accountTicketHistory(accountId).catch(() => null),
        this.repository.playerNotes(accountId).catch(() => []),
      ])

      embed.addFields(
        { name: 'Player', value: this.fieldValue(this.playerContextLines(context)) },
        // Both directions of reachability together: can I reach them, and can they reach me.
        {
          name: 'Reachable',
          value: this.fieldValue([
            this.onlineLine(context),
            await this.identityStatusLine(ticket),
          ]),
        },
        { name: 'History', value: this.fieldValue(this.historyLines(history)) },
        { name: 'Notes on this account', value: this.fieldValue(this.noteLines(notes)) },
      )
    }
    return embed
  }

  // What the player sees: what the ticket is and where it stands. No controls, no identity
  // status, nothing about how staff are working it.
  playerHeaderEmbed(ticket, description = '') {
    const status = ticket.status === 'open' ? 'Open, waiting for a staff member'
      : ticket.status === 'claimed' ? 'A staff member is looking at this'
        : ticket.status === 'closing' ? 'Being wrapped up'
          : 'Closed'
    return new EmbedBuilder()
      .setTitle(ticket.public_key)
      .setDescription(description || 'No description supplied.')
      .addFields({ name: 'Status', value: status })
      .setFooter({ text: 'Reply here and a staff member will see it.' })
  }

  async findHeaderMessage(channel, ticket) {
    if (!channel) return null
    const messages = await channel.messages.fetch({ limit: 100 })
    return messages.find((message) => message.author.id === this.client.user.id
      && message.embeds.some((embed) => embed.title === ticket.public_key)) ?? null
  }

  async postTicketHeader(channel, ticket, description = '') {
    if (!await this.findHeaderMessage(channel, ticket)) {
      await channel.send({ embeds: [this.playerHeaderEmbed(ticket, description)], allowedMentions: ALLOWED_MENTIONS })
    }

    const thread = await this.ensureStaffThread(channel, ticket)
    if (!await this.findHeaderMessage(thread, ticket)) {
      await thread.send({
        embeds: [await this.headerEmbed(ticket, description)],
        components: this.controls(ticket),
        allowedMentions: ALLOWED_MENTIONS,
      })
    }
    return thread
  }

  // Keeps both headers honest after any state change. The staff panel carries the controls and
  // the in-game identity status; the player header carries only status.
  async refreshTicketHeader(channel, ticket) {
    const playerHeader = await this.findHeaderMessage(channel, ticket)
    if (playerHeader) {
      const description = playerHeader.embeds[0]?.description ?? ''
      await playerHeader.edit({ embeds: [this.playerHeaderEmbed(ticket, description)], components: [] })
    }

    // Tickets created before staff threads existed have their controls in the channel. Creating
    // the thread here migrates them on their next state change, instead of stripping the controls
    // from the channel and leaving staff with nowhere to click. Closed tickets are not migrated -
    // their channel is scheduled for deletion anyway.
    const closedOff = ticket.status === 'closed' || ticket.status === 'cancelled'
    const thread = closedOff ? await this.staffThread(channel, ticket) : await this.ensureStaffThread(channel, ticket)
    if (!thread) return
    const staffHeader = await this.findHeaderMessage(thread, ticket)
    if (!staffHeader) return
    const description = staffHeader.embeds[0]?.description ?? ''
    const body = description.split('\n\n').slice(1).join('\n\n')
    await staffHeader.edit({ embeds: [await this.headerEmbed(ticket, body)], components: this.controls(ticket) })
  }

  // The controls live in the thread, so an interaction usually arrives from inside it. Falling
  // back to the parent covers a control used from the channel and older tickets predating threads.
  async staffThreadFor(interaction, ticket) {
    if (interaction.channel?.isThread?.()) {
      if (interaction.channel.archived) await interaction.channel.setArchived(false, 'Ticket activity').catch(() => null)
      return interaction.channel
    }
    const parent = interaction.channel ?? await this.client.channels.fetch(ticket.discord_channel_id)
    return this.ensureStaffThread(parent, ticket)
  }

  ticketChannelFrom(interaction) {
    return interaction.channel?.isThread?.() ? interaction.channel.parent : interaction.channel
  }

  // Resolves the staff thread without creating one, for paths that must not conjure a thread
  // for a ticket that never had one.
  async staffThread(channel, ticket) {
    const storedId = await this.repository.getThreadId(ticket.id)
    if (!storedId) return null
    const thread = await this.client.channels.fetch(storedId).catch(() => null)
    if (thread?.archived) await thread.setArchived(false, 'Ticket activity').catch(() => null)
    return thread
  }

  async ensureTicketChannel(ticket, label, description = '') {
    let channel = ticket.discord_channel_id ? await this.client.channels.fetch(ticket.discord_channel_id).catch(() => null) : null
    if (!channel) {
      const channels = await this.guild.channels.fetch()
      channel = channels.find((candidate) => candidate?.type === ChannelType.GuildText && candidate.topic === `mod-heimdall:${ticket.public_key}`) ?? null
      if (channel) await this.repository.setChannel(ticket.id, channel.id)
    }
    const created = !channel
    if (!channel) channel = await this.createTicketChannel(ticket, label)
    await this.postTicketHeader(channel, ticket, description)
    return { channel, created }
  }

  // Discord caps a modal title and a field label at 45 characters, a description or placeholder
  // at 100. Overrunning one reaches the user as a bare "Invalid string length" on the button they
  // pressed, naming neither the field nor the limit, so the check happens here instead.
  assertModalText(name, value, limit) {
    if ((value ?? '').length > limit) {
      throw new Error(`Modal ${name} is ${value.length} characters, over Discord's limit of ${limit}: ${JSON.stringify(value)}`)
    }
    return value
  }

  modal(customId, title, label, placeholder = '') {
    this.assertModalText('title', title, MODAL_TEXT_LIMITS.title)
    this.assertModalText('label', label, MODAL_TEXT_LIMITS.label)
    this.assertModalText('placeholder', placeholder, MODAL_TEXT_LIMITS.placeholder)
    const input = new TextInputBuilder().setCustomId('body').setLabel(label).setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1800).setPlaceholder(placeholder)
    return new ModalBuilder().setCustomId(customId).setTitle(title).addComponents(new ActionRowBuilder().addComponents(input))
  }

  // The intake form for one ticket type, built from its declared fields. Uses Label components,
  // which is what lets a select menu sit in a modal beside the text inputs - so "where do you need
  // help" is one click rather than a line of prose a GM has to interpret.
  intakeModal(categoryKey) {
    const category = TICKET_CATEGORIES[categoryKey]
    const title = this.assertModalText('title', `New ${category.label}`, MODAL_TEXT_LIMITS.title)
    const modal = new ModalBuilder().setCustomId(`ticket:create-submit:${categoryKey}`).setTitle(title)
    for (const field of intakeFields(categoryKey)) {
      const label = new LabelBuilder().setLabel(this.assertModalText(`label for ${field.id}`, field.label, MODAL_TEXT_LIMITS.label))
      if (field.kind === 'select') {
        label.setStringSelectMenuComponent(new StringSelectMenuBuilder()
          .setCustomId(field.id)
          .setRequired(field.required)
          .setMinValues(field.required ? 1 : 0)
          .setMaxValues(1)
          .addOptions(Object.values(field.options).map((option) => ({
            value: option,
            label: this.assertModalText(`option for ${field.id}`, option, MODAL_TEXT_LIMITS.option),
          }))))
      } else {
        if (field.placeholder) {
          label.setDescription(this.assertModalText(`description for ${field.id}`, field.placeholder, MODAL_TEXT_LIMITS.description))
        }
        label.setTextInputComponent(new TextInputBuilder()
          .setCustomId(field.id)
          .setStyle(field.kind === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
          .setRequired(field.required)
          .setMaxLength(field.kind === 'paragraph' ? 1800 : 120))
      }
      modal.addLabelComponents(label)
    }
    return modal
  }

  readIntake(interaction, categoryKey) {
    const intake = {}
    for (const field of intakeFields(categoryKey)) {
      const value = field.kind === 'select'
        ? (interaction.fields.getStringSelectValues(field.id)[0] ?? '')
        : interaction.fields.getTextInputValue(field.id)
      if (value) intake[field.id] = sanitizeText(value, field.kind === 'paragraph' ? 1800 : 120)
    }
    return intake
  }

  async handleInteraction(interaction) {
    if (interaction.isButton()) return this.handleButton(interaction)
    if (interaction.isStringSelectMenu()) return this.handleSelect(interaction)
    if (interaction.isModalSubmit()) return this.handleModal(interaction)
    if (interaction.isChatInputCommand() && interaction.commandName === 'ticket') return this.handleAdminCommand(interaction)
  }

  async handleButton(interaction) {
    const [namespace, action, value] = interaction.customId.split(':')
    if (namespace !== 'ticket') return
    if (action === 'create-menu') {
      return interaction.reply({
        content: 'What do you need?',
        components: [this.categoryMenuRow()],
        flags: MessageFlags.Ephemeral,
        allowedMentions: ALLOWED_MENTIONS,
      })
    }
    // The panel no longer renders per-category buttons, but an older ephemeral message might still
    // be sitting in someone's client. Routing it to the current form costs one branch.
    if (action === 'create') {
      if (!TICKET_CATEGORIES[value]) throw new Error('Unknown ticket category.')
      return interaction.showModal(this.intakeModal(value))
    }
    const ticket = await this.repository.getTicket(ticketIdFrom(interaction.customId))
    if (!ticket) throw new Error('That ticket no longer exists.')
    if (action === 'claim') return this.claim(interaction, ticket)
    if (action === 'reply') {
      await this.requireRosteredStaff(interaction)
      if (ticket.source !== 'ingame' || ticket.claimant_discord_user_id !== interaction.user.id) throw new Error('Only the assigned staff member may reply to this player.')
      return interaction.showModal(this.modal(`ticket:reply-submit:${ticket.id}`, 'Reply to Player', 'Message shown in World of Warcraft'))
    }
    if (action === 'note') {
      await this.requireRosteredStaff(interaction)
      return interaction.showModal(this.modal(`ticket:note-submit:${ticket.id}`, 'Staff Note',
        'Staff only. Follows the player.',
        'Shows on every ticket from this account. e.g. Warned about language in June.'))
    }
    if (action?.startsWith('gm-')) {
      const key = action.slice(3)
      if (!GM_ACTIONS[key]) throw new Error('Unknown action.')
      // Teleport is the only one that needs a value from the GM, so it asks before it acts.
      if (GM_ACTIONS[key].needsDestination) {
        await this.requireRosteredStaff(interaction)
        this.requireTicketOwner(interaction, ticket)
        return interaction.showModal(this.modal(`ticket:gm-teleport-submit:${ticket.id}`, 'Teleport Player',
          'Destination', 'A name from the realm’s teleport list, or $home'))
      }
      return this.runGmAction(interaction, ticket, key)
    }
    if (action === 'remove-note') {
      await this.requireRosteredStaff(interaction)
      return interaction.showModal(this.modal(`ticket:remove-note-submit:${ticket.id}`, 'Remove Note',
        'Note number, as shown on the card', 'e.g. 12'))
    }
    if (action === 'close' || action === 'close-confirm') {
      if (!this.isAdmin(interaction) && ticket.claimant_discord_user_id !== interaction.user.id) throw new Error('Only an administrator or the assigned staff member can close this ticket.')
      // One deliberate click between a misclick and a closed ticket. The note modal that follows
      // is not a confirmation - it can be submitted empty, and a stray click reached it directly.
      if (action === 'close') {
        return interaction.reply({
          content: `Close **${ticket.public_key}**? This ends the conversation for the player and starts the retention clock.`,
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`ticket:close-confirm:${ticket.id}`).setLabel('Yes, close it').setStyle(ButtonStyle.Danger),
          )],
          flags: MessageFlags.Ephemeral,
          allowedMentions: ALLOWED_MENTIONS,
        })
      }
      return interaction.showModal(this.modal(`ticket:close-submit:${ticket.id}`, 'Close Ticket', 'Closure note'))
    }
    if (action === 'request-close') {
      await this.requireRosteredStaff(interaction)
      await this.repository.recordMessage({ ticketId: ticket.id, actorKind: 'staff', actorRef: interaction.user.id, body: 'Closure requested.', idempotencyKey: interaction.id })

      // Somebody other than the clicker has to be able to see this, or the button is theatre.
      const audience = ticket.claimant_discord_user_id
        ? `<@${ticket.claimant_discord_user_id}>`
        : this.roleMentions(this.escalationRoleIds())
      const mentions = ticket.claimant_discord_user_id
        ? { users: [ticket.claimant_discord_user_id], roles: [], repliedUser: false }
        : { users: [], roles: this.escalationRoleIds(), repliedUser: false }
      const closureThread = await this.staffThreadFor(interaction, ticket)
      await closureThread.send({
        content: `${audience} — <@${interaction.user.id}> has requested that this ticket be closed.`,
        allowedMentions: mentions,
      })
      return interaction.reply({ content: 'Closure request recorded for staff review.', flags: MessageFlags.Ephemeral, allowedMentions: ALLOWED_MENTIONS })
    }
    if (action === 'refresh-context') {
      await this.requireRosteredStaff(interaction)
      if (ticket.source !== 'ingame') throw new Error('This ticket has no in-game player.')
      // Travels the same delivery queue as whisper delivery: the module answers it and writes a
      // fresh snapshot. The version in the key lets a GM refresh repeatedly.
      await this.repository.enqueue({
        ticketId: ticket.id,
        direction: 'to_game',
        kind: 'refresh_player_context',
        payload: { realmTag: ticket.realm_tag, sourceTicketId: ticket.source_ticket_id },
        uniqueParts: ['refresh-context', interaction.id],
      })
      return interaction.reply({
        content: 'Asked the realm for fresh player info. The card updates within a few seconds — press Refresh again to redraw it.',
        flags: MessageFlags.Ephemeral,
        allowedMentions: ALLOWED_MENTIONS,
      })
    }
    if (action === 'identity-login' || action === 'identity-logout') {
      const staff = await this.requireRosteredStaff(interaction)
      if (ticket.source !== 'ingame') throw new Error('This ticket has no in-game side.')
      if (!this.isAdmin(interaction) && ticket.claimant_discord_user_id !== interaction.user.id) throw new Error('Only an administrator or the assigned staff member can control the in-game identity.')

      const gmName = ticket.claimant_gm_name ?? staff.gm_name
      const held = action === 'identity-login'
      await this.setIdentityHeld(gmName, held, interaction.user.id)
      await this.refreshTicketHeader(interaction.channel, ticket)

      return interaction.reply({
        content: held
          ? `**${gmName}** is now in game and players can whisper you.`
          : `**${gmName}** has left the game. This affects every ticket you have claimed, not just this one.`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: ALLOWED_MENTIONS,
      })
    }
    if (action === 'reopen') {
      if (!this.isAdmin(interaction)) throw new Error('Only an administrator can reopen a ticket.')
      const reopened = await this.repository.reopen(ticket.id, interaction.user.id)
      await this.refreshVisibility(this.ticketChannelFrom(interaction), reopened)
      const reopenThread = await this.staffThreadFor(interaction, reopened)
      await reopenThread.send({
        content: 'Ticket reopened. It is now **unassigned** and back in the pool — someone has to claim it again before anyone can reply to the player.',
        allowedMentions: ALLOWED_MENTIONS,
      })
      return interaction.reply({
        content: 'Ticket reopened. Reopening clears the previous claim, so it is unassigned until someone claims it again.',
        flags: MessageFlags.Ephemeral,
        allowedMentions: ALLOWED_MENTIONS,
      })
    }
  }

  // Only the GM holding the ticket, or an admin. A ticket nobody has claimed has nobody entitled
  // to act on the player through it.
  requireTicketOwner(interaction, ticket) {
    if (this.isAdmin(interaction)) return
    if (!ticket.claimant_discord_user_id) throw new Error('Claim the ticket first. Actions on a player belong to whoever is handling them.')
    if (ticket.claimant_discord_user_id !== interaction.user.id) throw new Error('Only the assigned staff member or an administrator can act on this player.')
  }

  // Also applied to a reply that arrived with HTTP 200. A refusal normally comes back as a SOAP
  // fault, but several handlers answer "Ticket not found." and similar with a successful status,
  // so the reply text is screened as well. The help text a handler triggers by refusing its
  // arguments is matched in both the spellings the core produces.
  gmActionFailureMarkers() {
    return [/not found/i, /does not exist/i, /^\s*Syntax:/im, /incorrect syntax/i, /no such/i]
  }

  async runGmAction(interaction, ticket, key, context = {}) {
    const action = GM_ACTIONS[key]
    if (!action) throw new Error('Unknown action.')
    await this.requireRosteredStaff(interaction)
    this.requireTicketOwner(interaction, ticket)
    if (ticket.source !== 'ingame') throw new Error('This ticket has no character behind it.')

    // Same validation .ticket assign puts a GM name through, for the same reason: this string
    // becomes part of a command.
    const name = validateGmName(ticket.player_name ?? '')
    const command = action.command(name, { ...context, publicKey: ticket.public_key })
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })

    let reply
    try {
      reply = await this.soap.commandExpectingEffect(command, this.gmActionFailureMarkers())
      if (action.expectSilence && reply.trim()) throw new Error(`Core rejected "${command}": ${reply.replace(/\s+/g, ' ').slice(0, 200)}`)
    } catch (error) {
      this.logger.warn('GM action refused', { ticket: ticket.public_key, action: key, by: interaction.user.id, error: String(error.message ?? error) })
      await this.repository.audit(ticket.id, 'gm_action_failed', interaction.user.id, { action: key, command, error: String(error.message ?? error) })
      throw new Error(this.explainGmActionFailure(action, name, error))
    }

    this.logger.info('GM action ran', { ticket: ticket.public_key, action: key, by: interaction.user.id, target: name })
    await this.repository.audit(ticket.id, 'gm_action', interaction.user.id, { action: key, command, ...context })
    await this.attributeSoapCommand(command, interaction.user.id)

    // Into the staff thread, so the rest of the team sees what was done rather than only the
    // person who clicked.
    const message = action.success(name, context)
    const thread = await this.staffThreadFor(interaction, ticket)
    await thread.send({ content: `${message} (<@${interaction.user.id}>)`, allowedMentions: { users: [interaction.user.id], roles: [], repliedUser: false } })
    return interaction.editReply({ content: message, allowedMentions: ALLOWED_MENTIONS })
  }

  // The core's reason for refusing arrives in the SOAP fault, and it is written for someone
  // reading a server console. These are the four that staff actually hit.
  explainGmActionFailure(action, name, error) {
    const detail = String(error.message ?? error).replace(/^SOAP command refused: /, '')
    if (/does not exist/i.test(detail) && detail.toLowerCase().includes(name.toLowerCase())) {
      return `The realm has no character called **${name}**. The ticket may name a character that has since been deleted or renamed.`
    }
    if (action.needsDestination && /teleport location|Either:|Expected/i.test(detail)) {
      return 'The realm has no teleport destination by that name. Use one from its teleport list, or $home for the player’s hearthstone.'
    }
    if (action.requiresOnline && /not found|Syntax|does not exist/i.test(detail)) {
      return `**${name}** does not appear to be online. ${action.label} needs them logged in.`
    }
    return `The realm refused that: ${detail.slice(0, 300)}`
  }

  async handleSelect(interaction) {
    const [namespace, action] = interaction.customId.split(':')
    if (namespace !== 'ticket') return
    if (action === 'create-pick') {
      const [category] = interaction.values
      if (!TICKET_CATEGORIES[category]) throw new Error('Unknown ticket category.')
      return interaction.showModal(this.intakeModal(category))
    }
  }

  async handleModal(interaction) {
    const [, action, value] = interaction.customId.split(':')
    // The intake forms carry named fields rather than one 'body', so the shared read happens after
    // them - asking for a field a modal does not have throws.
    if (action === 'create-submit') {
      if (!TICKET_CATEGORIES[value]) throw new Error('Unknown ticket category.')
      const intake = this.readIntake(interaction, value)
      const description = intakeDescription(value, intake)
      const ticket = await this.repository.createDiscordTicket({ creatorId: interaction.user.id, category: value, description, intake })
      await this.repository.recordMessage({ ticketId: ticket.id, actorKind: 'player', actorRef: interaction.user.id, body: description, idempotencyKey: interaction.id })
      return interaction.reply({ content: `Your ticket ${ticket.publicKey} is being opened. Discord will show the private channel shortly.`, flags: MessageFlags.Ephemeral, allowedMentions: ALLOWED_MENTIONS })
    }
    const body = sanitizeText(interaction.fields.getTextInputValue('body'))
    const ticket = await this.repository.getTicket(ticketIdFrom(interaction.customId))
    if (!ticket) throw new Error('That ticket no longer exists.')
    if (action === 'reply-submit') return this.replyToPlayer(interaction, ticket, body)
    // One note button, two destinations. The transcript keeps every note with the ticket it was
    // written on; when the player's account is known the same note is also pinned to the account.
    // Ordinary staff chatter needs no button - thread messages are archived on their own.
    if (action === 'note-submit') {
      await this.requireRosteredStaff(interaction)
      await this.repository.recordMessage({ ticketId: ticket.id, actorKind: 'staff', actorRef: interaction.user.id, body, idempotencyKey: interaction.id })
      const accountId = await this.ticketAccountId(ticket)
      let noteId = null
      if (accountId) noteId = await this.repository.addPlayerNote({ accountId, actorId: interaction.user.id, body, ticketId: ticket.id, idempotencyKey: interaction.id })

      // Into the staff thread: this used to post where a Discord ticket's author could read it.
      const noteThread = await this.staffThreadFor(interaction, ticket)
      await noteThread.send({
        content: noteId
          ? `Note \`#${noteId}\` from <@${interaction.user.id}>: ${body}`
          : `Internal note from <@${interaction.user.id}>: ${body}`,
        allowedMentions: { users: [interaction.user.id], roles: [], repliedUser: false },
      })
      await this.refreshTicketHeader(this.ticketChannelFrom(interaction), ticket)
      return interaction.reply({
        content: noteId
          ? `Saved as note \`#${noteId}\`. It is on the card above, and on every future ticket this account opens - on any character. Remove Note takes it back off.`
          : 'Note saved to this ticket. No game account is known for it, so it stays here rather than following a player.',
        flags: MessageFlags.Ephemeral,
        allowedMentions: ALLOWED_MENTIONS,
      })
    }
    if (action === 'remove-note-submit') {
      await this.requireRosteredStaff(interaction)
      const noteId = Number.parseInt(body.replace(/[^0-9]/g, ''), 10)
      if (!Number.isInteger(noteId)) throw new Error('Give the note number shown on the card, for example 12.')
      // Scoped to this ticket's account, so a mistyped number cannot reach another player's notes.
      const accountId = await this.ticketAccountId(ticket)
      const owned = accountId ? await this.repository.playerNotes(accountId, 100) : []
      if (!owned.some((note) => note.id === noteId)) throw new Error(`Note #${noteId} is not one of this account's notes. The card lists the numbers you can remove.`)
      await this.repository.deletePlayerNote(noteId, interaction.user.id)
      await this.refreshTicketHeader(this.ticketChannelFrom(interaction), ticket)
      return interaction.reply({
        content: `Note \`#${noteId}\` removed from the account. The ticket transcript still records that it was written.`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: ALLOWED_MENTIONS,
      })
    }
    if (action === 'gm-teleport-submit') {
      return this.runGmAction(interaction, ticket, 'teleport', { destination: validateTeleDestination(body) })
    }
    if (action === 'close-submit') return this.closeTicket(interaction, ticket, body)
  }

  async claim(interaction, ticket) {
    const staff = await this.requireRosteredStaff(interaction)
    const claimed = await this.repository.claim({ ticketId: ticket.id, discordUserId: interaction.user.id, gmName: staff.gm_name })
    if (claimed.source === 'ingame') await this.repository.enqueue({ ticketId: claimed.id, direction: 'soap', kind: 'assign_ticket', payload: { sourceTicketId: claimed.source_ticket_id, gmName: staff.gm_name, causedBy: interaction.user.id }, uniqueParts: ['assign', claimed.version] })
    await this.refreshVisibility(this.ticketChannelFrom(interaction), claimed)
    await interaction.reply({ content: `Claimed as **${staff.gm_name}**. Other Moderators and Game Masters can no longer see this channel.`, flags: MessageFlags.Ephemeral, allowedMentions: ALLOWED_MENTIONS })
  }

  async replyToPlayer(interaction, ticket, body) {
    const staff = await this.requireRosteredStaff(interaction)
    if (ticket.source !== 'ingame' || ticket.claimant_discord_user_id !== interaction.user.id || ticket.claimant_gm_name !== staff.gm_name) throw new Error('Only the currently assigned staff member can reply to this player.')

    // Discord closes an interaction after three seconds. A SOAP call that fails slowly used to blow
    // that window, so the GM saw nothing at all at the exact moment something had gone wrong - the
    // log showed the real error followed by "Unknown interaction". Deferring first means the reason
    // always reaches them, however long the realm takes to refuse.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })

    // A forgotten logout should not be a dead end: bring the identity back rather than refusing.
    const wasOffline = (await this.identityState(ticket.realm_tag, staff.gm_name)) !== 'held'
    if (wasOffline) await this.setIdentityHeld(staff.gm_name, true, interaction.user.id)

    const chunks = splitWowMessage(body)
    for (const [index, text] of chunks.entries()) {
      await this.repository.enqueue({
        ticketId: ticket.id,
        direction: 'to_game',
        kind: 'virtual_whisper',
        // Contract the game module reads. gmName must be a configured, currently-held identity
        // and playerName an online character, or the module leaves the job queued untouched.
        payload: { gmName: staff.gm_name, playerName: ticket.player_name, text },
        uniqueParts: ['whisper', interaction.id, index],
      })
    }
    await this.repository.recordMessage({ ticketId: ticket.id, actorKind: 'staff', actorRef: interaction.user.id, body, idempotencyKey: interaction.id })
    const replyThread = await this.staffThreadFor(interaction, ticket)
    await replyThread.send({ content: `**${staff.gm_name}** replied in game.`, allowedMentions: ALLOWED_MENTIONS })
    // An implicit login just changed the identity state the header reports.
    if (wasOffline) await this.refreshTicketHeader(interaction.channel, ticket)

    const note = wasOffline ? ' Your in-game identity was logged in for you.' : ''
    // Said unconditionally, this read as a failure notice at the moment of success: the player was
    // online and the whisper had already landed. The module publishes an online indicator for the
    // context card; when it does not know, the cautious wording is still the right one.
    const context = await this.repository.playerContext(ticket.id).catch(() => null)
    const arrival = context?.online
      ? `Delivering now — ${ticket.player_name} is online.`
      : `It will arrive when ${ticket.player_name} is online.`
    return interaction.editReply({
      content: `Sent as ${chunks.length} in-game message${chunks.length === 1 ? '' : 's'}. ${arrival}${note}`,
      allowedMentions: ALLOWED_MENTIONS,
    })
  }

  // The game module publishes "held" or "offline" per identity into the settings table, and is
  // driven through the same SOAP channel already used for ticket assignment and closure.

  identityStateKey(realmTag, gmName) {
    return `identity.state.${realmTag}.${gmName}`
  }

  async identityState(realmTag, gmName) {
    return (await this.repository.getSetting(this.identityStateKey(realmTag, gmName))) ?? 'offline'
  }

  async setIdentityHeld(gmName, held, causedBy = null) {
    const command = `.heimdall identity ${held ? 'login' : 'logout'} ${validateGmName(gmName)}`
    await this.soap.command(command)
    await this.attributeSoapCommand(command, causedBy)
  }

  // AzerothCore cannot tell a SOAP command from one typed at the local terminal - SOAP queues a
  // CliCommandHolder down the same path - so the module's audit log records every bot-issued
  // command as "Console". This posts the missing half: what the bot ran and which Discord user
  // caused it, so an admin can correlate the two entries by timestamp.
  //
  // This used to pass create:false, on the reasoning that the audit log is opt-in and a server that
  // never enabled it should not acquire a channel. The effect was the opposite of opt-in: the
  // channel is only ever created by postCommandAudit, which runs only on a delivery job only the
  // MODULE queues, and the module queues nothing unless Heimdall.CommandAuditEnabled is on - which
  // is off by default. So on every default install the bot's own attribution could never post, ever,
  // and said nothing about it.
  //
  // Two producers writing to one channel with different rights to create it is the bug. Both create
  // it now. The two are not equivalent in scope, and this half is the one that always applies: it
  // records what THIS BOT did to the realm, on behalf of a named Discord user, which is precisely
  // what an admin needs when the realm's own log attributes it all to "Console".
  async attributeSoapCommand(command, causedBy) {
    try {
      const channel = await this.auditChannel({ create: true })
      if (!channel) return
      const who = causedBy ? `<@${causedBy}>` : 'an automatic action'
      await channel.send({
        content: `Bot ran \`${command}\` on behalf of ${who} — the realm logs this as **Console**.`,
        allowedMentions: ALLOWED_MENTIONS,
      })
    } catch (error) {
      // Attribution is a convenience. Never let it fail the command it describes.
      this.logger.warn(`Could not post SOAP attribution for "${command}": ${error.message}`)
    }
  }

  async identityStatusLine(ticket) {
    if (!ticket.claimant_gm_name) return 'Unassigned — nobody has claimed this ticket, so nobody can reply to the player yet.'
    const state = await this.identityState(ticket.realm_tag, ticket.claimant_gm_name)
    return state === 'held'
      ? `In-game identity: **${ticket.claimant_gm_name}** is online and can be whispered.`
      : `In-game identity: **${ticket.claimant_gm_name}** is offline. Players cannot whisper right now.`
  }

  async closeTicket(interaction, ticket, note) {
    if (!this.isAdmin(interaction) && ticket.claimant_discord_user_id !== interaction.user.id) throw new Error('Only an administrator or the assigned staff member can close this ticket.')
    await this.performClose({
      ticket,
      actorId: interaction.user.id,
      note,
      idempotencyKey: interaction.id,
      channel: this.ticketChannelFrom(interaction),
      playerNotice: 'This ticket has been closed and will disappear from your channel list. '
        + 'If you need anything else, open a new ticket from the panel.',
    })
    return interaction.reply({ content: 'Ticket closed.', flags: MessageFlags.Ephemeral, allowedMentions: ALLOWED_MENTIONS })
  }

  // The single close path. Auto-close uses this too, so an automatic closure is identical to a
  // manual one - same database transition, same SOAP ".ticket close", same channel move and
  // deletion schedule - rather than a parallel implementation that can drift.
  async performClose({ ticket, actorId, note, idempotencyKey, channel, playerNotice }) {
    const closed = await this.repository.close(ticket.id, actorId, this.config.retentionDays)
    await this.repository.recordMessage({ ticketId: ticket.id, actorKind: 'staff', actorRef: actorId, body: note, idempotencyKey })
    if (closed.source === 'ingame') {
      await this.repository.enqueue({ ticketId: closed.id, direction: 'soap', kind: 'close_ticket', payload: { sourceTicketId: closed.source_ticket_id, causedBy: actorId }, uniqueParts: ['close', idempotencyKey] })
    }
    await this.applyClosureToDiscord(closed, { channel, playerNotice })
    return closed
  }

  // Everything that happens to Discord when a ticket ends, in one place, because there are two ways
  // a ticket can end and they must not drift apart. performClose owns the database transition and
  // the SOAP command; a closure that started in game needs neither - the realm has already done
  // both - but needs exactly this half, and used to get none of it.
  //
  // Idempotent by construction: the delete_channel job is keyed, and reapplying the category and
  // overwrites is a no-op the second time. Only the notice is not, which is why the in-game path
  // guards it.
  async applyClosureToDiscord(closed, { channel = null, playerNotice }) {
    if (closed.discord_channel_id) {
      await this.repository.enqueue({
        ticketId: closed.id,
        direction: 'to_discord',
        kind: 'delete_channel',
        payload: { channelId: closed.discord_channel_id },
        uniqueParts: ['delete-channel', closed.discord_channel_id],
        availableAt: new Date(Date.now() + this.config.closedChannelDeleteHours * 3_600_000),
      })
    }
    const ticketChannel = channel ?? (closed.discord_channel_id ? await this.client.channels.fetch(closed.discord_channel_id).catch(() => null) : null)
    if (!ticketChannel) return null
    // Post before reapplying permissions: closing removes the author's access, so a notice sent
    // afterwards would land in a channel they can no longer see.
    await ticketChannel.send({ content: playerNotice, allowedMentions: ALLOWED_MENTIONS })
    await this.refreshVisibility(ticketChannel, closed)
    return ticketChannel
  }

  // Closes tickets nobody has touched for the configured number of days. Off unless configured.
  async autoCloseInactiveTickets() {
    const days = this.config.autoCloseInactiveDays
    if (!days) return 0

    const stale = await this.repository.inactiveOpenTickets(days)
    let closed = 0
    for (const ticket of stale) {
      try {
        await this.performClose({
          ticket,
          actorId: this.client.user.id,
          note: `Closed automatically after ${days} day(s) without activity.`,
          idempotencyKey: `autoclose:${ticket.id}:${ticket.version}`,
          channel: null,
          playerNotice: `This ticket was closed automatically after ${days} day(s) with no activity `
            + 'and will disappear from your channel list. If you still need help, open a new ticket '
            + 'from the panel and we will pick it up.',
        })
        closed += 1
        this.logger.info(`Auto-closed ${ticket.public_key} after ${days} day(s) of inactivity.`)
      } catch (error) {
        this.logger.error(`Auto-close failed for ${ticket.public_key}`, error)
      }
    }
    return closed
  }

  // Which category a ticket channel belongs in, from its current state alone.
  categoryFor(ticket) {
    if (ticket.status === 'closed' || ticket.status === 'cancelled') return this.ids.closedCategoryId
    if (ticket.claimant_discord_user_id) return this.ids.claimedCategoryId
    return this.ids.openCategoryId
  }

  // Category, permissions and header are all derived from ticket state, so they are refreshed
  // together. Keeping them as one call is what stops the header going stale after a claim: there
  // is no way to update one and forget the other.
  async refreshVisibility(channel, ticket) {
    // The board follows every lifecycle change through this one funnel. Fire and forget: a board
    // that cannot be drawn must never stop a ticket from being claimed or closed.
    this.refreshQueueBoard().catch((error) => this.logger.error('Queue board refresh failed', error))
    await this.cacheOverwriteTargets(ticket)
    await this.withFreshCategories(`Moving ${ticket.public_key} to its category`,
      () => channel.setParent(this.categoryFor(ticket), { lockPermissions: false }))
    await channel.permissionOverwrites.set(this.overwrites(ticket), `Ticket ${ticket.public_key} visibility updated`)
    await this.refreshTicketHeader(channel, ticket)
  }

  // Who actually typed this. The staff roster is the reliable signal - it is the same table that
  // decides who may claim and reply - with the configured staff roles as a fallback for someone
  // holding a staff role who has not been rostered yet. Without this every message in a ticket
  // channel was recorded as 'player', making a GM indistinguishable from the player in the
  // transcript.
  async actorKindFor(message) {
    const rostered = await this.repository.staff(message.author.id).catch(() => null)
    if (rostered) return 'staff'
    const roleIds = [...(message.member?.roles?.cache?.keys?.() ?? [])]
    return memberCanWorkTicket(roleIds, this.config) ? 'staff' : 'player'
  }

  async archiveDiscordMessage(message) {
    if (message.author?.bot || !message.guildId) return
    // Staff discussion lives in the ticket's private thread, and a thread has its own id, so
    // matching on the channel id alone left every staff message out of the transcript. The parent
    // of a ticket thread is the ticket channel.
    const channelId = message.channel?.isThread?.() ? message.channel.parentId : message.channelId
    const ticket = await this.repository.getTicketByChannel(channelId)
    if (!ticket) return
    const body = message.content?.trim() || '(attachment only)'
    const actorKind = await this.actorKindFor(message)
    const key = await this.repository.recordMessage({ ticketId: ticket.id, actorKind, actorRef: message.author.id, body: sanitizeText(body, 2_000), discordMessageId: message.id })
    for (const attachment of message.attachments.values()) {
      const saved = await this.archive.save(ticket.public_key, attachment)
      await this.repository.recordAttachment({ ticketId: ticket.id, eventKey: key, originalName: saved.originalName, relativePath: saved.storedName, contentType: saved.contentType, byteSize: saved.byteSize, sha256: saved.sha256, expiresAt: new Date(Date.now() + this.config.retentionDays * 86_400_000) })
    }
  }

  // Player whispers are posted through a channel webhook so they appear under the character's
  // own name rather than the bot's, which makes a ticket channel read like a conversation.
  // Requires the Manage Webhooks permission on the bot's invite.
  async ticketWebhook(channel) {
    const existing = await channel.fetchWebhooks()
    const mine = existing.find((hook) => hook.name === WEBHOOK_NAME && hook.owner?.id === this.client.user.id)
    if (mine) return mine
    return channel.createWebhook({ name: WEBHOOK_NAME, reason: 'Ticket player messages' })
  }

  async postPlayerWhisper(payload) {
    if (!payload.realmTag) throw new Error('Player whisper payload is missing realmTag.')
    const ticket = await this.repository.getIngameTicket(payload.realmTag, payload.sourceTicketId)
    if (!ticket) throw new Error(`No local in-game ticket record for ${payload.realmTag}-${payload.sourceTicketId}.`)
    const { channel } = await this.ensureTicketChannel(ticket, 'support')
    const name = payload.playerName ?? ticket.player_name ?? 'Player'
    const body = sanitizeText(payload.text, 2_000)

    // A player's message must never be lost to a cosmetic problem with their character name, so
    // fall back to an ordinary bot message if the webhook cannot carry it. A WoW name like
    // "Clyde" is legal in game but rejected by Discord as a username.
    this.logger.info('Posting player whisper', { ticket: ticket.public_key, from: name, bytes: Buffer.byteLength(body) })
    this.logger.debug('Player whisper content', { ticket: ticket.public_key, body })

    if (RESERVED_USERNAME_WORDS.test(name)) return this.postPlayerWhisperFallback(channel, name, body)
    try {
      const webhook = await this.ticketWebhook(channel)
      await webhook.send({ username: name, content: body, allowedMentions: ALLOWED_MENTIONS })
    } catch (error) {
      this.logger.warn(`Webhook post failed for ${name}; falling back to a plain message.`, error?.message ?? error)
      await this.postPlayerWhisperFallback(channel, name, body)
    }
  }

  async postPlayerWhisperFallback(channel, name, body) {
    // The body has already been trimmed to the full 2000, so the prefix has to come out of it
    // rather than be added on top. This is the path a player's message takes when their name
    // cannot be a webhook username, so it must not be the fragile one.
    const prefix = `**${name}** (in game): `
    await channel.send({ content: prefix + body.slice(0, 2000 - prefix.length), allowedMentions: ALLOWED_MENTIONS })
  }

  // One batched message per delivery, not one per command. Rendered as a code block so command
  // text cannot mention anyone or render markdown.
  // The command audit log is an opt-in module feature. Provisioning its channel lazily means an
  // install that leaves it off never gets a channel it did not ask for.
  async auditChannel({ create = false } = {}) {
    // The one switch. Off means off for both producers and for creation, including the
    // enabled-then-deleted recovery below - an operator who has turned this off and deleted the
    // channel must not find it back tomorrow.
    if (!this.config.commandAuditChannel) return null
    const stored = await this.repository.getSetting('discord.audit_channel_id')
    if (stored) {
      const existing = await this.client.channels.fetch(stored).catch(() => null)
      if (existing) return existing

      // A stored id is proof the audit was switched on at some point, so this is not the quiet
      // never-enabled case that `create` guards - the channel was deleted out from under an
      // accountability log, and every entry since has been dropped without a word. That is the one
      // failure this feature must never have, so it is recreated whatever the caller asked for.
      this.logger.warn(`The GM command audit channel (${stored}) no longer exists in Discord. `
        + 'Every audit entry since it was deleted has been discarded, and those cannot be recovered. '
        + 'Recreating it now.')
      await this.warnQueueBoard('The GM command audit channel had been deleted, so audit entries were '
        + 'being discarded. It has been recreated. Anything logged while it was missing is gone.')
      return this.createAuditChannel()
    }
    if (!create) return null
    return this.createAuditChannel()
  }

  // Best effort, and deliberately not fatal: this exists to put an operator-visible notice where
  // staff already look, for a condition whose whole problem is that it is invisible.
  async warnQueueBoard(text) {
    try {
      const board = await this.queueBoardChannel()
      if (board) await board.send({ content: `⚠️ ${text}`, allowedMentions: ALLOWED_MENTIONS })
    } catch (error) {
      this.logger.warn(`Could not post an operator notice to the queue board: ${error.message}`)
    }
  }

  async createAuditChannel() {
    const channel = await this.guild.channels.create({
      name: 'gm-command-audit',
      type: ChannelType.GuildText,
      topic: 'Every GM command attempt on the realm. Admin-only.',
      // Admin-only from the moment it exists: this channel is the accountability record and must
      // not be readable by the staff it holds to account.
      permissionOverwrites: [
        { id: this.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: this.botRoleId, allow: ADMIN_PERMISSIONS },
        ...this.config.adminRoleIds.map((id) => ({ id, allow: ADMIN_PERMISSIONS })),
      ],
      reason: 'mod-heimdall command audit',
    })
    await this.repository.setSetting('discord.audit_channel_id', channel.id)
    this.logger.info(`Created GM command audit channel (${channel.id}).`)
    return channel
  }

  async postCommandAudit(payload) {
    const channel = await this.auditChannel({ create: true })
    // Dropped rather than failed. With the audit switched off these jobs would otherwise retry to
    // death and then sit in the table as `dead`, which reads as a fault rather than a setting.
    if (!channel && !this.config.commandAuditChannel) {
      this.logger.debug?.('Discarding a GM command audit entry: COMMAND_AUDIT_CHANNEL is off.')
      return
    }
    if (!channel) throw new Error('GM command audit channel could not be resolved.')

    const entries = Array.isArray(payload.entries) ? payload.entries : []
    if (!entries.length) return

    const lines = entries.map((entry) => {
      const when = new Date((entry.at ?? 0) * 1000).toISOString().replace('T', ' ').slice(0, 19)
      const who = entry.accountId ? `${entry.actor} (acct ${entry.accountId}, sec ${entry.security})` : `${entry.actor} (sec ${entry.security})`
      return `${when}  ${who}
    ${entry.command}`
    })

    // Discord caps a message at 2000 characters; a full batch of long commands can exceed it.
    const chunks = []
    let current = ''
    for (const raw of lines) {
      // A single command can be longer than a whole batch is allowed to be - .announce with a
      // paragraph after it. Truncating the line keeps the record; letting it through loses the
      // entire batch to a rejected message.
      const line = raw.length > 1700 ? `${raw.slice(0, 1699)}…` : raw
      if (current && current.length + line.length + 1 > 1800) {
        chunks.push(current)
        current = ''
      }
      current += `${line}
`
    }
    if (current) chunks.push(current)

    for (const chunk of chunks) {
      await channel.send({
        content: `**${payload.realmTag ?? 'realm'}** GM commands
\`\`\`
${chunk}\`\`\``,
        allowedMentions: ALLOWED_MENTIONS,
      })
    }
  }

  async syncIngameTicket(payload) {
    if (!payload.realmTag) throw new Error('In-game sync payload is missing realmTag; it predates realm-tagged tickets.')
    const ticket = await this.repository.getIngameTicket(payload.realmTag, payload.sourceTicketId)
    if (!ticket) throw new Error(`No local in-game ticket record for ${payload.realmTag}-${payload.sourceTicketId}.`)

    // The realm can end a ticket with Discord playing no part in it: a player abandons theirs, or a
    // GM types .ticket close at the console. Both arrive down this path, and nothing used to happen
    // - the channel sat in Open Tickets with no notice, no retention clock and nothing saying it had
    // finished. Closure side effects ran only when a GM pressed the button in Discord.
    //
    // Checked before ensureTicketChannel deliberately: a ticket that has ended must not have a
    // channel built for it.
    if (payload.completed) return this.closeFromGame(ticket, payload)

    const { channel, created } = await this.ensureTicketChannel(ticket, 'support', payload.description)
    this.logger.info(created ? 'In-game ticket channel created' : 'In-game ticket re-synced',
      { ticket: ticket.public_key, channel: channel.id })
    if (created) return
    // Closing a ticket moves lastModifiedTime, which re-publishes it with the text it has always
    // had. Repeating that text into the channel says nothing the header has not said since the
    // ticket opened, so only text that is new to this ticket - a player editing their ticket in
    // game - is worth a message.
    if (await this.repository.ingameDescriptionSeen(ticket.id, payload.description) > 1) return
    await channel.send({
      content: `**${ticket.player_name ?? payload.playerName}** edited their in-game ticket:\n${payload.description}`,
      allowedMentions: ALLOWED_MENTIONS,
    })
  }

  // The module has already written status = 'closed', closed_at and the transcript clock in the same
  // transaction that queued this delivery, so there is no transition to make and no `.ticket close`
  // to send - doing either would be telling the realm something it told us. What is missing is the
  // Discord half.
  async closeFromGame(ticket, payload) {
    // The notice is the one part that cannot be repeated safely, and a delivery can be retried.
    // Recorded after the work rather than before, so a failure part-way through is retried in full
    // rather than skipped: a duplicate notice is cosmetic, a closure that never lands is the bug
    // this exists to fix.
    if (await this.repository.hasAudit(ticket.id, 'ingame_closed')) return

    const channel = await this.applyClosureToDiscord(ticket, {
      playerNotice: 'This ticket was closed in game and will disappear from your channel list. '
        + 'If you need anything else, open a new ticket from the panel.',
    })
    await this.repository.audit(ticket.id, 'ingame_closed', 'system',
      { realmTag: payload.realmTag, sourceTicketId: payload.sourceTicketId })
    this.logger.info('In-game ticket closed', { ticket: ticket.public_key, channel: channel?.id ?? 'none' })
  }

  async processDeliveries() {
    const jobs = await this.repository.leaseBotDeliveries(20, this.config.leaseSeconds)
    for (const job of jobs) {
      try {
        if (job.direction === 'to_discord' && job.kind === 'gm_command_audit') await this.postCommandAudit(job.payload)
        else if (job.direction === 'to_discord' && job.kind === 'player_whisper') await this.postPlayerWhisper(job.payload)
        else if (job.direction === 'to_discord' && job.kind === 'sync_ingame_ticket') await this.syncIngameTicket(job.payload)
        else if (job.direction === 'to_discord' && job.kind === 'create_discord_ticket') {
          const ticket = await this.repository.getTicket(job.ticket_id)
          if (!ticket) throw new Error('Ticket no longer exists.')
          await this.ensureTicketChannel(ticket, job.payload.category, job.payload.description)
        }
        else if (job.direction === 'to_discord' && job.kind === 'delete_channel') {
          const channel = await this.client.channels.fetch(job.payload.channelId).catch(() => null)
          if (channel) await channel.delete('Configured closed-ticket review window ended')
        } else if (job.direction === 'soap' && job.kind === 'assign_ticket') {
          const gmName = validateGmName(job.payload.gmName)
          if (!Number.isSafeInteger(Number(job.payload.sourceTicketId))) throw new Error('Invalid in-game ticket number.')
          const assignCommand = `.ticket assign ${job.payload.sourceTicketId} ${gmName}`
          await this.soap.commandExpectingEffect(assignCommand)
          await this.attributeSoapCommand(assignCommand, job.payload.causedBy ?? null)
        } else if (job.direction === 'soap' && job.kind === 'close_ticket') {
          if (!Number.isSafeInteger(Number(job.payload.sourceTicketId))) throw new Error('Invalid in-game ticket number.')
          // ".ticket close", not ".ticket complete". Complete sets only `completed`, leaving
          // `type` at TICKET_TYPE_OPEN - and GetTicketByPlayer (which decides whether a player
          // "already has an open ticket") tests only !IsClosed(), i.e. type. Completing therefore
          // hides the ticket from .ticket list while permanently blocking that player from
          // opening another one. Close sets type via SetClosedBy and frees them.
          const closeCommand = `.ticket close ${job.payload.sourceTicketId}`
          await this.soap.commandExpectingEffect(closeCommand)
          await this.attributeSoapCommand(closeCommand, job.payload.causedBy ?? null)
        }
        else throw new Error(`Unsupported delivery ${job.direction}/${job.kind}`)
        await this.repository.delivered(job.id)
        this.logger.info('Delivery done', { id: job.id, kind: job.kind, direction: job.direction, ticketId: job.ticket_id ?? 'none' })
      } catch (error) {
        await this.repository.failed(job.id, error, this.config.maxAttempts)
        this.logger.error(`Ticket delivery ${job.id} failed`, error)
      }
    }
  }

  async handleAdminCommand(interaction) {
    if (!this.isAdmin(interaction)) throw new Error('Only administrators may use ticket administration commands.')
    const command = interaction.options.getSubcommand()
    if (command === 'staff-add') {
      const user = interaction.options.getUser('user', true)
      const gmName = validateGmName(interaction.options.getString('gm_name', true))
      await this.assertConfiguredIdentity(gmName)
      await this.repository.upsertStaff(user.id, gmName)
      const joined = await this.addStaffToOpenThreads(user.id)
      return interaction.reply({
        content: `Staff mapping saved for ${user}. Added to ${joined} open ticket thread(s).`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: ALLOWED_MENTIONS,
      })
    }
    if (command === 'staff-remove') {
      const user = interaction.options.getUser('user', true)
      await this.repository.disableStaff(user.id)
      return interaction.reply({ content: `Staff mapping disabled for ${user}.`, flags: MessageFlags.Ephemeral, allowedMentions: ALLOWED_MENTIONS })
    }
    if (command === 'staff-list') {
      const rows = await this.repository.listStaff()
      return interaction.reply({ content: rows.length ? rows.map((row) => `<@${row.discord_user_id}> → ${row.gm_name}${row.enabled ? '' : ' (disabled)'}`).join('\n') : 'No staff mappings are configured.', flags: MessageFlags.Ephemeral, allowedMentions: { users: rows.map((row) => row.discord_user_id), roles: [], repliedUser: false } })
    }
    const ticketId = interaction.options.getInteger('ticket_id', true)
    if (command === 'reopen') {
      const ticket = await this.repository.reopen(ticketId, interaction.user.id)
      const channel = ticket.discord_channel_id && await this.client.channels.fetch(ticket.discord_channel_id).catch(() => null)
      if (channel) await this.refreshVisibility(channel, ticket)
      return interaction.reply({ content: `${ticket.public_key} reopened.`, flags: MessageFlags.Ephemeral, allowedMentions: ALLOWED_MENTIONS })
    }
    if (command === 'reassign') {
      const user = interaction.options.getUser('user', true)
      const mapping = await this.repository.staff(user.id)
      if (!mapping) throw new Error('That user has no enabled staff mapping.')
      const member = await this.guild.members.fetch(user.id)
      if (!memberCanWorkTicket([...member.roles.cache.keys()], this.config)) throw new Error('That user must have an eligible ticket role.')
      const ticket = await this.repository.reassign({ ticketId, discordUserId: user.id, gmName: validateGmName(mapping.gm_name), actorId: interaction.user.id })
      const channel = ticket.discord_channel_id && await this.client.channels.fetch(ticket.discord_channel_id).catch(() => null)
      if (channel) await this.refreshVisibility(channel, ticket)
      return interaction.reply({ content: `${ticket.public_key} assigned to ${user} as ${mapping.gm_name}.`, flags: MessageFlags.Ephemeral, allowedMentions: { users: [user.id], roles: [], repliedUser: false } })
    }
  }

  // validateGmName is a format check, so "Helpbat" for "Helpbot" was accepted here and surfaced
  // much later as a SOAP refusal - to a GM, mid-conversation with a player. The module knows the
  // real list, because it resolves each configured name against the realm at startup and discards
  // the ones that are not usable characters; it publishes what survived. This moves the discovery
  // from mid-conversation to the moment the mistake is made.
  //
  // A missing list means the module has not restarted since the upgrade that started publishing it.
  // That must warn rather than block, or every staff-add on a half-upgraded install fails.
  async assertConfiguredIdentity(gmName) {
    const names = await this.repository.gmIdentityNames()
    if (names === null) {
      this.logger.warn('The module has not published its GM identity list, so the GM name in '
        + `/ticket staff-add could not be checked. Restart the worldserver to enable this check.`)
      return
    }
    if (names.some((name) => name.toLowerCase() === gmName.toLowerCase())) return
    if (!names.length) {
      throw new Error('No GM identities are configured on the realm, so there is no name to map to. '
        + 'Set Heimdall.GmIdentities in heimdall.conf to a real character on this realm and restart '
        + 'the worldserver, then run this again.')
    }
    throw new Error(`"${gmName}" is not a configured GM identity. The realm accepts: ${names.join(', ')}. `
      + 'Check the spelling, or add the name to Heimdall.GmIdentities in heimdall.conf and restart '
      + 'the worldserver.')
  }

  async failInteraction(interaction, error) {
    this.logger.error('Discord ticket interaction failed', error)
    const payload = { content: error.message || 'The ticket action failed safely. Please try again or contact an administrator.', flags: MessageFlags.Ephemeral, allowedMentions: ALLOWED_MENTIONS }
    // A deferred interaction is showing a spinner. Editing it replaces that with the reason;
    // following up would leave the spinner sitting there forever.
    if (interaction.deferred && !interaction.replied) await interaction.editReply(payload).catch(() => undefined)
    else if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => undefined)
    else await interaction.reply(payload).catch(() => undefined)
  }
}

export function ticketAdminCommand() {
  return new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Ticket-system administration')
    .addSubcommand((subcommand) => subcommand.setName('staff-add').setDescription('Add or update a staff GM mapping')
      .addUserOption((option) => option.setName('user').setDescription('Discord staff member').setRequired(true))
      .addStringOption((option) => option.setName('gm_name').setDescription('GM character name').setRequired(true).setMaxLength(12)))
    .addSubcommand((subcommand) => subcommand.setName('staff-remove').setDescription('Disable a staff GM mapping')
      .addUserOption((option) => option.setName('user').setDescription('Discord staff member').setRequired(true)))
    .addSubcommand((subcommand) => subcommand.setName('staff-list').setDescription('List staff GM mappings'))
    .addSubcommand((subcommand) => subcommand.setName('reopen').setDescription('Reopen a closed ticket')
      .addIntegerOption((option) => option.setName('ticket_id').setDescription('Internal ticket number').setRequired(true).setMinValue(1)))
    .addSubcommand((subcommand) => subcommand.setName('reassign').setDescription('Assign a ticket to rostered staff')
      .addIntegerOption((option) => option.setName('ticket_id').setDescription('Internal ticket number').setRequired(true).setMinValue(1))
      .addUserOption((option) => option.setName('user').setDescription('Rostered staff member').setRequired(true)))
}
