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

// Cuts a word too long to fit any whisper into pieces that do fit. Iterating characters rather than
// bytes is what keeps the pieces valid: slicing a UTF-8 buffer at a byte offset can land in the
// middle of an accented or CJK character and the client renders the halves as garbage. `for...of`
// walks code points, so surrogate pairs stay together too.
function splitLongToken(token, maxBytes) {
  const pieces = []
  let piece = ''
  let bytes = 0
  for (const character of token) {
    const size = Buffer.byteLength(character, 'utf8')
    // Only reachable below maxBytes 4, which the caller's own bounds already exclude.
    if (size > maxBytes) throw new Error(`A single character does not fit in ${maxBytes} bytes`)
    if (bytes + size > maxBytes) {
      pieces.push(piece)
      piece = ''
      bytes = 0
    }
    piece += character
    bytes += size
  }
  if (piece) pieces.push(piece)
  return pieces
}

export function splitWowMessage(input, maxBytes = 240) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 255) throw new Error('maxBytes must be between 1 and 255')
  const words = String(input).replace(/\r/g, '').split(/\n+/).flatMap((line) => line.split(/\s+/)).filter(Boolean)
  const chunks = []
  let chunk = ''
  for (const word of words) {
    // A word longer than a whole whisper used to throw, which rejected the entire reply - the
    // player received nothing and the GM was told the rule with no way to satisfy it. The realistic
    // trigger is a pasted URL with query parameters, and chopping a URL by hand does not leave a
    // working link, so there was no workaround. Splitting mid-word is ugly; delivering nothing is
    // worse. Throwing is kept for input that genuinely cannot be sent.
    if (Buffer.byteLength(word, 'utf8') > maxBytes) {
      const pieces = splitLongToken(word, maxBytes)
      if (chunk) chunks.push(chunk)
      // All but the last piece are full; the last becomes the running chunk so the words that
      // follow can still share a whisper with it.
      chunks.push(...pieces.slice(0, -1))
      chunk = pieces[pieces.length - 1]
      continue
    }
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
  // Admins can always work tickets; the admin tier adds authority, it never removes capability.
  return config.staffRoleIds.some((id) => roles.has(id)) || config.adminRoleIds.some((id) => roles.has(id))
}

// ---------------------------------------------------------------------------------------------
// The Components V2 header's text budget.
//
// Discord counts 4,000 characters across ALL text displays in one message, not per display, and
// it rejects the whole message when the total is over - so a long ticket body plus a talkative
// account would take the header down entirely rather than degrade. The embed this replaced had
// per-field caps that failed the same way, which is why fieldValue() existed.
//
// The working budget is deliberately under the real one: truncation notices are themselves text,
// and the container formatting Discord adds is not free either.
export const HEADER_TEXT_LIMIT = 4000
export const HEADER_TEXT_BUDGET = 3400
// Discord counts every component in the message against one ceiling: containers, the text
// displays inside them, separators, action rows, and each button or select in those rows.
export const HEADER_COMPONENT_LIMIT = 40
const NOTE_BODY_LIMIT = 180

// One notice per kind, and a later step replaces an earlier step's rather than stacking beside
// it: the ladder can cut notes three times, and "…and 37 more" followed by "…and 2 more" reads
// as two separate facts when it is one fact getting worse.
function noticed(state, kind, text) {
  return { ...state.notices, [kind]: text }
}

function noticeLines(notices) {
  return ['notes', 'history', 'context'].map((kind) => notices[kind]).filter(Boolean)
}

function measure(state) {
  return [state.headline, state.body, ...state.context, ...state.history, ...state.notes, ...noticeLines(state.notices)]
    .filter(Boolean).join('\n').length
}

function notesTo(state, keep) {
  // state.notes carries one rendered line per note. The count in the notice is the ORIGINAL
  // number, not the number this particular step removed, so it stays true however many steps run.
  const real = state.notes.filter((line) => line !== state.noteEmptyLine)
  if (real.length <= keep) return null
  const hidden = state.noteCount - keep
  return {
    ...state,
    notes: keep ? real.slice(0, keep) : [],
    notices: noticed(state, 'notes', keep
      ? `…and ${hidden} more ${hidden === 1 ? 'note' : 'notes'} on this account.`
      : `${state.noteCount} ${state.noteCount === 1 ? 'note is' : 'notes are'} not shown here; ${state.noteCount === 1 ? 'it stays' : 'they stay'} on the account.`),
  }
}

function historyToCount(state) {
  if (state.history.length <= 1) return null
  return {
    ...state,
    history: state.history.slice(0, 1),
    notices: noticed(state, 'history', '…full history in the ticket record.'),
  }
}

function contextToEssentials(state) {
  // The played/account-age line is the one a GM can do without: it is background, where the rest
  // of the block is who and where the player is right now.
  const kept = state.context.filter((line) => !line.startsWith('Played:'))
  if (kept.length === state.context.length) return null
  return { ...state, context: kept, notices: noticed(state, 'context', '…player background omitted for length.') }
}

// Least useful first, and the ticket body is never touched until everything else has gone. The
// body is the reason the ticket exists; a GM who cannot read it has to open the database.
const LADDER = [notesTo3, notesTo1, notesTo0, historyToCount, contextToEssentials]
function notesTo3(state) { return notesTo(state, 3) }
function notesTo1(state) { return notesTo(state, 1) }
function notesTo0(state) { return notesTo(state, 0) }

// Trims a note's own text before it ever reaches the ladder. One note may run to 1,800
// characters and five of those alone would exhaust the budget.
export function trimNoteBody(body) {
  const text = String(body ?? '')
  return text.length > NOTE_BODY_LIMIT ? `${text.slice(0, NOTE_BODY_LIMIT - 1)}…` : text
}

// Fits the header's text inside the budget and says what it gave up. Pure: it takes rendered
// lines and returns rendered lines, so it is tested directly rather than through a Discord fake.
export function buildHeaderText(parts, budget = HEADER_TEXT_BUDGET) {
  let state = {
    headline: parts.headline ?? '',
    body: parts.body ?? '',
    context: [...(parts.context ?? [])],
    history: [...(parts.history ?? [])],
    notes: [...(parts.notes ?? [])],
    noteEmptyLine: parts.noteEmptyLine ?? null,
    notices: {},
  }
  state.noteCount = state.notes.filter((line) => line !== state.noteEmptyLine).length

  for (const step of LADDER) {
    if (measure(state) <= budget) break
    const next = step(state)
    if (next) state = next
  }

  // Everything else has already gone. What is left is the body, and it is cut with a notice
  // rather than silently - a GM must never read a truncated sentence as the whole complaint.
  const over = measure(state) - budget
  if (over > 0) {
    const notice = '…truncated. The full text is in the ticket record.'
    const room = Math.max(0, state.body.length - over - notice.length - 1)
    state = {
      ...state,
      body: room ? `${state.body.slice(0, room)}\n${notice}` : notice,
    }
  }

  return {
    headline: state.headline,
    body: state.body,
    context: state.context,
    history: state.history,
    notes: state.notes,
    notices: noticeLines(state.notices),
    length: measure(state),
  }
}
