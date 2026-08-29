import crypto from 'node:crypto'

// Discord's limits on the text of a modal. Declared here so the forms below can be checked against
// them without a live Discord connection; the builder enforces the same numbers at send time.
export const MODAL_TEXT_LIMITS = Object.freeze({ title: 45, label: 45, description: 100, placeholder: 100, option: 100 })

// Where the player says the problem is. Shared by more than one intake form, and the value staff
// read off the ticket header, so it is declared once.
export const HELP_LOCATIONS = Object.freeze({
  in_game: 'In game',
  discord: 'Discord',
  website: 'The website',
  client: 'The game client',
  launcher: 'The launcher',
})

// Every entry the panel menu offers, in the order it offers them. Adding one is a change here and
// nowhere else: the menu, the modal and the stored answers are all built from this.
//
// The parked self-service entries - Unstuck, Restore a deleted character - will arrive as two more
// objects with `action: 'self_service'` once account linking exists (see the addendum in
// design-T2-staff-qol.md). They are deliberately absent rather than present and disabled: an entry
// a user can click and be refused is worse than one that is not there yet.
export const TICKET_CATEGORIES = Object.freeze({
  support: {
    label: 'Support',
    description: 'Account, gameplay, or connection help.',
    action: 'ticket',
    // Discord allows five components in a modal. Three is a form people finish.
    intake: [
      {
        id: 'location',
        kind: 'select',
        label: 'Where do you need help?',
        options: HELP_LOCATIONS,
        required: true,
        headline: 'Where',
      },
      {
        id: 'character',
        kind: 'short',
        label: 'Character name',
        placeholder: 'Leave blank if this is not about one character.',
        required: false,
        headline: 'Character',
      },
      {
        id: 'details',
        kind: 'paragraph',
        label: 'What do you need help with?',
        placeholder: 'What happened, and what you have already tried.',
        required: true,
        body: true,
      },
    ],
  },
  bug: {
    label: 'Bug Report',
    description: 'A reproducible game or website issue.',
    action: 'ticket',
    intake: [
      {
        id: 'location',
        kind: 'select',
        label: 'Where does it happen?',
        options: HELP_LOCATIONS,
        required: true,
        headline: 'Where',
      },
      {
        id: 'observed',
        kind: 'paragraph',
        label: 'What happened?',
        placeholder: 'What the game or site actually did.',
        required: true,
        body: true,
      },
      {
        id: 'expected',
        kind: 'short',
        label: 'What did you expect instead?',
        placeholder: 'One line is enough.',
        required: true,
      },
      {
        id: 'steps',
        kind: 'paragraph',
        label: 'How can we make it happen again?',
        placeholder: 'Optional, but it is the difference between fixed and not.',
        required: false,
      },
    ],
  },
  player_report: {
    label: 'Player Report',
    description: 'Conduct or rule concerns.',
    action: 'ticket',
    intake: [
      {
        id: 'subject',
        kind: 'short',
        label: 'Who are you reporting?',
        placeholder: 'Character name, or their Discord name.',
        required: true,
        headline: 'Reported',
      },
      {
        id: 'conduct',
        kind: 'paragraph',
        label: 'What did they do?',
        placeholder: 'Quote what was said if you can.',
        required: true,
        body: true,
      },
      {
        id: 'occurred',
        kind: 'short',
        label: 'When did this happen?',
        placeholder: 'e.g. tonight around 9pm, or 28 August',
        required: true,
        headline: 'When',
      },
    ],
  },
})

// GM actions a ticket's staff thread can run on the player.
//
// The list is short on purpose, and the shape of it was decided by reading the core rather than by
// wishing. A command qualifies only if it is Console::Yes *and* works without an invoking GM
// standing in the world: .appear, .summon and .recall are all Console::No, because each is defined
// relative to whoever typed it, and SOAP has no whoever.
//
// `expectSilence` records that the handler prints nothing when it works, so an empty reply is the
// success case rather than a sign the command went missing.
export const GM_ACTIONS = Object.freeze({
  revive: {
    label: 'Revive',
    // cs_misc.cpp:115. Resurrects a connected player, and falls back to Player::OfflineResurrect
    // for one who is not, so this is the rare action that works on an offline character.
    command: (name) => `.revive ${name}`,
    tokens: 2,
    requiresOnline: false,
    expectSilence: true,
    success: (name) => `**${name}** has been revived.`,
  },
  unstuck: {
    label: 'Unstuck',
    // cs_misc.cpp:125. The location argument is not optional in practice: the handler reads
    // `location->empty()` on an Optional it never checks, so omitting it dereferences an empty
    // optional. Always send one.
    command: (name) => `.unstuck ${name} inn`,
    tokens: 3,
    requiresOnline: false,
    expectSilence: false,
    success: (name) => `**${name}** has been sent to their home inn.`,
  },
  combatstop: {
    label: 'Stop Combat',
    // cs_misc.cpp:148. Clears combat and threat, which is what actually frees a player who cannot
    // log out, resurrect or teleport.
    command: (name) => `.combatstop ${name}`,
    tokens: 2,
    requiresOnline: true,
    expectSilence: true,
    success: (name) => `**${name}** is out of combat.`,
  },
  kick: {
    label: 'Kick',
    // cs_misc.cpp:124. A stuck client is often fixed by nothing more than a forced reconnect.
    // The reason is ONE token: cs_misc.cpp:1410 declares it Optional<std::string_view>, not Tail
    // the way .mute does, and the parser refuses a command with anything left over. "Ticket R1-5"
    // was two tokens, so every click was refused with the command's syntax line and nobody was
    // ever kicked.
    command: (name, context) => `.kick ${name} Ticket-${context.publicKey}`,
    tokens: 3,
    requiresOnline: true,
    expectSilence: false,
    success: (name) => `**${name}** has been disconnected and can log straight back in.`,
  },
  teleport: {
    label: 'Teleport',
    // cs_tele.cpp:46. Takes a destination from the game_tele table, or $home for the player's own
    // hearth. Works whether or not they are connected.
    command: (name, context) => `.tele name ${name} ${context.destination}`,
    tokens: 4,
    requiresOnline: false,
    expectSilence: false,
    needsDestination: true,
    success: (name, context) => `**${name}** has been teleported to ${context.destination}.`,
  },
})

// Destinations are typed by a GM and become part of a command string, so they are held to the
// shape game_tele actually uses. $home is the one special value the core accepts.
export function validateTeleDestination(value) {
  const destination = String(value ?? '').trim()
  if (destination === '$home') return destination
  if (!/^[A-Za-z0-9_'-]{1,48}$/.test(destination)) {
    throw new Error('A destination is one word from the realm’s teleport list, for example "stormwind", or $home for their hearthstone.')
  }
  return destination
}

export function intakeFields(categoryKey) {
  const category = TICKET_CATEGORIES[categoryKey]
  if (!category) throw new Error('Unknown ticket category.')
  return category.intake
}

// The answers staff should see without opening the description. Only fields marked `headline`
// qualify, so a form can grow without the header growing with it.
export function intakeHeadline(categoryKey, intake) {
  if (!intake) return []
  return intakeFields(categoryKey)
    .filter((field) => field.headline && intake[field.id])
    .map((field) => `**${field.headline}:** ${intake[field.id]}`)
}

// The ticket body, as the player wrote it, with any answer that is not the free-text field
// labelled above it. This is what goes in the channel header and the transcript.
export function intakeDescription(categoryKey, intake) {
  const lines = []
  for (const field of intakeFields(categoryKey)) {
    const value = intake?.[field.id]
    if (!value) continue
    lines.push(field.body ? value : `**${field.headline ?? field.label}** ${value}`)
  }
  return lines.join('\n\n')
}

const TRANSITIONS = Object.freeze({
  open: new Set(['claimed', 'closing', 'cancelled']),
  claimed: new Set(['open', 'closing', 'cancelled']),
  closing: new Set(['closed', 'claimed']),
  closed: new Set(['claimed']),
  cancelled: new Set(),
})

export function assertTransition(from, to) {
  if (!TRANSITIONS[from]?.has(to)) throw new Error(`Invalid ticket transition: ${from} -> ${to}`)
}

// Discord-created tickets only. In-game keys are minted by the game module as <REALM_TAG>-<id>,
// where the realm tag comes from server-side config the bot has no view of, so the bot never
// constructs them - it reads public_key off the row.
export function ticketPublicKey(source, sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('Ticket sequence must be a positive integer')
  if (source === 'discord') return `DIS-${String(sequence).padStart(6, '0')}`
  throw new Error(`Unknown ticket source: ${source}`)
}

export function safeChannelName(publicKey, label = '') {
  const suffix = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  return `${publicKey.toLowerCase()}${suffix ? `-${suffix}` : ''}`.slice(0, 90)
}

export function splitWowMessage(input, maxBytes = 240) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 255) throw new Error('maxBytes must be between 1 and 255')
  const words = String(input).replace(/\r/g, '').split(/\n+/).flatMap((line) => line.split(/\s+/)).filter(Boolean)
  const chunks = []
  let chunk = ''
  for (const word of words) {
    if (Buffer.byteLength(word, 'utf8') > maxBytes) throw new Error('A single word exceeds the WoW message limit')
    const candidate = chunk ? `${chunk} ${word}` : word
    if (Buffer.byteLength(candidate, 'utf8') <= maxBytes) {
      chunk = candidate
    } else {
      chunks.push(chunk)
      chunk = word
    }
  }
  if (chunk) chunks.push(chunk)
  if (!chunks.length) throw new Error('Message cannot be empty')
  return chunks
}

export function eventKey(parts) {
  return crypto.createHash('sha256').update(parts.map(String).join('\u001f')).digest('hex')
}

export function sanitizeText(value, maxLength = 1800) {
  const text = String(value ?? '').trim()
  if (!text) throw new Error('Text is required')
  if (text.length > maxLength) throw new Error(`Text exceeds ${maxLength} characters`)
  return text.replace(/@(everyone|here)/g, (_, label) => `@\u200b${label}`)
}

export function validateGmName(value) {
  const name = String(value ?? '').trim()
  if (!/^[A-Za-z][A-Za-z0-9]{1,11}$/.test(name)) throw new Error('GM names must use 2–12 letters or numbers and start with a letter.')
  return name
}

export function archiveExpiry(closedAt, days = 180) {
  const date = new Date(closedAt)
  if (Number.isNaN(date.getTime()) || !Number.isInteger(days) || days < 1) throw new Error('Invalid retention inputs')
  date.setUTCDate(date.getUTCDate() + days)
  return date
}

export function memberCanWorkTicket(memberRoleIds, config) {
  const roles = new Set(memberRoleIds)
  return roles.has(config.adminRoleId) || roles.has(config.moderatorRoleId) || roles.has(config.gmRoleId)
}
