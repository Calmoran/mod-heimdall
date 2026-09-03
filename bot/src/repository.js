import { eventKey, intakeDescription, ticketPublicKey } from './domain.js'

export class TicketRepository {
  // runId identifies this PROCESS and owns both the instance lock and the delivery leases. label is
  // BOT_INSTANCE_ID, carried only so messages can name the instance the way its operator does.
  // They are separate because two copies of one .env share the label but must not share the lock.
  constructor(pool, runId, label = runId) {
    this.pool = pool
    this.runId = runId
    this.instanceId = label
  }

  // Two bots against one database and one token double every human action and complain about
  // nothing, which is close to undiagnosable from the symptoms. The lock is a heartbeat rather
  // than a flag so that a crashed instance frees itself: `updated_at` on the settings table is
  // already ON UPDATE CURRENT_TIMESTAMP, so no schema change is needed to age it out.
  //
  // The timestamp is written explicitly. MySQL only fires ON UPDATE when a column value actually
  // changes, and an instance re-writing its own id changes nothing - the heartbeat would never
  // advance and the holder would time itself out.

  async claimInstanceLock(staleSeconds) {
    await this.pool.execute(
      "INSERT IGNORE INTO heimdall_setting (setting_key, setting_value) VALUES ('discord.bot_instance', ?)",
      [this.runId],
    )
    await this.pool.execute(
      "UPDATE heimdall_setting SET setting_value = ?, updated_at = CURRENT_TIMESTAMP"
      + " WHERE setting_key = 'discord.bot_instance'"
      + "   AND (setting_value = ? OR updated_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ? SECOND))",
      [this.runId, this.runId, staleSeconds],
    )
    return this.instanceLockHolder()
  }

  async instanceLockHolder() {
    const [[row]] = await this.pool.execute(
      "SELECT setting_value AS holder, TIMESTAMPDIFF(SECOND, updated_at, CURRENT_TIMESTAMP) AS age"
      + " FROM heimdall_setting WHERE setting_key = 'discord.bot_instance'",
    )
    return { holder: row?.holder ?? null, age: Number(row?.age ?? 0), held: row?.holder === this.runId }
  }

  // Returns false if another instance has taken the lock, which is the signal to stop rather than
  // keep acting on a database someone else owns.
  async beatInstanceLock() {
    await this.pool.execute(
      "UPDATE heimdall_setting SET updated_at = CURRENT_TIMESTAMP"
      + " WHERE setting_key = 'discord.bot_instance' AND setting_value = ?",
      [this.runId],
    )
    return (await this.instanceLockHolder()).held
  }

  // Ages the heartbeat out on a clean shutdown so a restart is immediate rather than waiting for
  // the staleness window to pass.
  async releaseInstanceLock() {
    await this.pool.execute(
      "UPDATE heimdall_setting SET updated_at = DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 1 DAY)"
      + " WHERE setting_key = 'discord.bot_instance' AND setting_value = ?",
      [this.runId],
    )
  }

  async getSetting(key) {
    const [rows] = await this.pool.execute('SELECT setting_value FROM heimdall_setting WHERE setting_key = ?', [key])
    return rows[0]?.setting_value ?? null
  }

  async setSetting(key, value) {
    await this.pool.execute(
      'INSERT INTO heimdall_setting (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
      [key, value],
    )
  }

  async createDiscordTicket({ creatorId, category, description, intake = null }) {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [existing] = await connection.execute(
        "SELECT id FROM heimdall_ticket WHERE source = 'discord' AND discord_creator_id = ? AND status IN ('open', 'claimed', 'closing') FOR UPDATE",
        [creatorId],
      )
      if (existing.length) throw new Error('You already have an open Discord ticket.')
      const [result] = await connection.execute(
        "INSERT INTO heimdall_ticket (source, public_key, discord_creator_id, category) VALUES ('discord', ?, ?, ?)",
        [`PENDING-${Date.now()}-${Math.random()}`, creatorId, category],
      )
      const publicKey = ticketPublicKey('discord', result.insertId)
      await connection.execute('UPDATE heimdall_ticket SET public_key = ? WHERE id = ?', [publicKey, result.insertId])
      await connection.execute(
        // The structured answers ride along with the creation event: no schema change, and they
        // are read straight back onto the staff header so nobody has to parse the description.
        "INSERT INTO heimdall_event (ticket_id, event_key, event_type, actor_kind, actor_ref, payload_json) VALUES (?, ?, 'discord_ticket_created', 'player', ?, JSON_OBJECT('category', ?, 'intake', CAST(? AS JSON)))",
        [result.insertId, eventKey(['create', result.insertId]), creatorId, category, JSON.stringify(intake ?? {})],
      )
      await connection.execute(
        "INSERT INTO heimdall_delivery (ticket_id, delivery_key, direction, kind, payload_json) VALUES (?, ?, 'to_discord', 'create_discord_ticket', JSON_OBJECT('category', ?, 'description', ?))",
        [result.insertId, eventKey(['delivery', result.insertId, 'create_discord_ticket']), category, description],
      )
      await connection.commit()
      return { id: result.insertId, publicKey, source: 'discord', discordCreatorId: creatorId, category, status: 'open' }
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async getTicketByChannel(channelId) {
    const [rows] = await this.pool.execute('SELECT * FROM heimdall_ticket WHERE discord_channel_id = ?', [channelId])
    return rows[0] ?? null
  }

  async getTicket(id) {
    const [rows] = await this.pool.execute('SELECT * FROM heimdall_ticket WHERE id = ?', [id])
    return rows[0] ?? null
  }

  // Scoped by realm_tag as well as source_ticket_id: every realm auto-numbers its tickets from 1,
  // so source_ticket_id alone stops identifying a row the moment two realms share this database.
  // The tag travels on the delivery payload the game module writes.
  async getIngameTicket(realmTag, sourceTicketId) {
    const [rows] = await this.pool.execute(
      "SELECT * FROM heimdall_ticket WHERE source = 'ingame' AND realm_tag = ? AND source_ticket_id = ?",
      [realmTag, sourceTicketId],
    )
    return rows[0] ?? null
  }

  async setChannel(id, channelId) {
    await this.pool.execute('UPDATE heimdall_ticket SET discord_channel_id = ?, version = version + 1 WHERE id = ?', [channelId, id])
  }

  async reassign({ ticketId, discordUserId, gmName, actorId }) {
    const [result] = await this.pool.execute(
      "UPDATE heimdall_ticket SET status = 'claimed', claimant_discord_user_id = ?, claimant_gm_name = ?, claimed_at = CURRENT_TIMESTAMP, version = version + 1 WHERE id = ? AND status IN ('open', 'claimed', 'closed')",
      [discordUserId, gmName, ticketId],
    )
    if (result.affectedRows !== 1) throw new Error('Ticket cannot be reassigned in its current state.')
    await this.audit(ticketId, 'ticket_reassigned', actorId, { discordUserId, gmName })
    return this.getTicket(ticketId)
  }

  async claim({ ticketId, discordUserId, gmName }) {
    const [result] = await this.pool.execute(
      "UPDATE heimdall_ticket SET status = 'claimed', claimant_discord_user_id = ?, claimant_gm_name = ?, claimed_at = CURRENT_TIMESTAMP, version = version + 1 WHERE id = ? AND status IN ('open', 'closed') AND (claimant_discord_user_id IS NULL OR claimant_discord_user_id = ?)",
      [discordUserId, gmName, ticketId, discordUserId],
    )
    if (result.affectedRows !== 1) throw new Error('This ticket is no longer available to claim.')
    await this.audit(ticketId, 'ticket_claimed', discordUserId, { gmName })
    return this.getTicket(ticketId)
  }

  async close(ticketId, actorId, retentionDays) {
    const [result] = await this.pool.execute(
      "UPDATE heimdall_ticket SET status = 'closed', closed_at = CURRENT_TIMESTAMP, transcript_expires_at = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ? DAY), version = version + 1 WHERE id = ? AND status IN ('open', 'claimed', 'closing')",
      [retentionDays, ticketId],
    )
    if (result.affectedRows !== 1) throw new Error('Ticket cannot be closed in its current state.')
    await this.pool.execute(
      'UPDATE heimdall_attachment SET expires_at = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ? DAY) WHERE ticket_id = ?',
      [retentionDays, ticketId],
    )
    await this.audit(ticketId, 'ticket_closed', actorId, { retentionDays })
    return this.getTicket(ticketId)
  }

  async reopen(ticketId, actorId) {
    const [result] = await this.pool.execute(
      "UPDATE heimdall_ticket SET status = 'open', claimant_discord_user_id = NULL, claimant_gm_name = NULL, claimed_at = NULL, closed_at = NULL, transcript_expires_at = NULL, version = version + 1 WHERE id = ? AND status = 'closed'",
      [ticketId],
    )
    if (result.affectedRows !== 1) throw new Error('Only a closed ticket can be reopened.')
    await this.cancelPendingChannelDeletion(ticketId)
    await this.audit(ticketId, 'ticket_reopened', actorId, {})
    return this.getTicket(ticketId)
  }

  // A reopened ticket must not be deleted by the job queued when it was closed. Only jobs that
  // have not run yet are cancelled; an already-delivered one has nothing left to stop.
  async cancelPendingChannelDeletion(ticketId) {
    const [result] = await this.pool.execute(
      "UPDATE heimdall_delivery SET state = 'dead', last_error = 'Cancelled: ticket reopened'"
      + " WHERE ticket_id = ? AND kind = 'delete_channel' AND state IN ('queued', 'leased')",
      [ticketId],
    )
    return result.affectedRows
  }

  async staff(discordUserId) {
    const [rows] = await this.pool.execute('SELECT * FROM heimdall_staff WHERE discord_user_id = ? AND enabled = 1', [discordUserId])
    return rows[0] ?? null
  }

  async upsertStaff(discordUserId, gmName) {
    await this.pool.execute(
      'INSERT INTO heimdall_staff (discord_user_id, gm_name) VALUES (?, ?) ON DUPLICATE KEY UPDATE gm_name = VALUES(gm_name), enabled = 1',
      [discordUserId, gmName],
    )
  }

  async disableStaff(discordUserId) {
    await this.pool.execute('UPDATE heimdall_staff SET enabled = 0 WHERE discord_user_id = ?', [discordUserId])
  }

  // The player context snapshot the module publishes. One row per ticket, kept current in place.
  async playerContext(ticketId) {
    const [rows] = await this.pool.execute(
      "SELECT payload_json FROM heimdall_event WHERE ticket_id = ? AND event_type = 'player_context' LIMIT 1",
      [ticketId],
    )
    const raw = rows[0]?.payload_json
    if (!raw) return null
    return typeof raw === 'string' ? JSON.parse(raw) : raw
  }

  // History is keyed on the auth account, so it follows a player across alts. Entirely within this
  // module's own tables - no player-data grant needed.
  async accountTicketHistory(accountId, { days = 180, recent = 3 } = {}) {
    if (!accountId) return null
    const [[counts]] = await this.pool.execute(
      'SELECT COUNT(*) AS total, MIN(opened_at) AS first_seen FROM heimdall_ticket'
      + ' WHERE player_account_id = ? AND opened_at >= DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ? DAY)',
      [accountId, days],
    )
    const [rows] = await this.pool.execute(
      'SELECT public_key, status, claimant_gm_name, opened_at FROM heimdall_ticket'
      + ' WHERE player_account_id = ? AND opened_at >= DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ? DAY)'
      + ' ORDER BY opened_at DESC LIMIT ?',
      [accountId, days, recent],
    )
    return { total: counts.total, firstSeen: counts.first_seen, recent: rows, days }
  }

  // Notes attach to the account, not the ticket, so they surface on every future ticket that
  // account opens - including on a different character.
  // Every other write in this schema is keyed and replayable; a note was the one that was not,
  // so a retried or doubly-delivered submission wrote it twice. The audit table is frozen and
  // cannot take a unique index, so the key lives in the payload and the insert screens on it.
  async addPlayerNote({ accountId, actorId, body, ticketId = null, idempotencyKey = null }) {
    const key = idempotencyKey ?? eventKey(['player_note', accountId, actorId, body])
    const [result] = await this.pool.execute(
      "INSERT INTO heimdall_audit (ticket_id, subject_account_id, action, actor_ref, metadata_json)"
      + " SELECT ?, ?, 'player_note', ?, JSON_OBJECT('body', ?, 'key', ?) FROM DUAL WHERE NOT EXISTS ("
      + "   SELECT 1 FROM (SELECT id FROM heimdall_audit WHERE subject_account_id = ?"
      + "     AND action = 'player_note' AND JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.key')) = ?) existing)",
      [ticketId, accountId, actorId, body, key, accountId, key],
    )
    if (result.insertId) return result.insertId
    const [[row]] = await this.pool.execute(
      "SELECT id FROM heimdall_audit WHERE subject_account_id = ? AND action = 'player_note'"
      + " AND JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.key')) = ? ORDER BY id LIMIT 1",
      [accountId, key],
    )
    return row?.id ?? null
  }

  async playerNotes(accountId, limit = 10) {
    if (!accountId) return []
    const [rows] = await this.pool.execute(
      "SELECT id, actor_ref, metadata_json, created_at FROM heimdall_audit"
      + " WHERE subject_account_id = ? AND action = 'player_note' ORDER BY id DESC LIMIT ?",
      [accountId, limit],
    )
    return rows.map((row) => {
      const meta = typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) : row.metadata_json
      return { id: row.id, actorRef: row.actor_ref, body: meta?.body ?? '', createdAt: row.created_at }
    })
  }

  async deletePlayerNote(noteId, actorId) {
    const [[note]] = await this.pool.execute(
      "SELECT subject_account_id FROM heimdall_audit WHERE id = ? AND action = 'player_note'",
      [noteId],
    )
    if (!note) throw new Error('That note no longer exists.')
    await this.pool.execute("DELETE FROM heimdall_audit WHERE id = ? AND action = 'player_note'", [noteId])
    // Deleting a note is itself auditable.
    await this.pool.execute(
      "INSERT INTO heimdall_audit (subject_account_id, action, actor_ref, metadata_json)"
      + " VALUES (?, 'player_note_deleted', ?, JSON_OBJECT('noteId', ?))",
      [note.subject_account_id, actorId, noteId],
    )
  }

  async listStaff() {
    const [rows] = await this.pool.execute('SELECT discord_user_id, gm_name, enabled FROM heimdall_staff ORDER BY gm_name')
    return rows
  }

  // The module publishes one row per realm holding the identities that survived its startup
  // validation. Null means no row exists at all - the module has not restarted since the upgrade
  // that started publishing - which the caller must treat differently from an empty list.
  async gmIdentityNames() {
    const [rows] = await this.pool.execute(
      "SELECT setting_value FROM heimdall_setting WHERE setting_key LIKE 'ingame.gm_identities.%'",
    )
    if (!rows.length) return null
    const names = new Set()
    for (const row of rows) {
      for (const name of String(row.setting_value ?? '').split(',')) {
        const trimmed = name.trim()
        if (trimmed) names.add(trimmed)
      }
    }
    return [...names]
  }

  async activeStaffIds() {
    const [rows] = await this.pool.execute('SELECT discord_user_id FROM heimdall_staff WHERE enabled = 1')
    return rows.map((row) => row.discord_user_id)
  }

  // Thread ids live in the settings table rather than a column, because the schema is frozen.
  // One small row per ticket, removed again when the ticket's content is purged.
  threadSettingKey(ticketId) {
    return `discord.ticket_thread.${ticketId}`
  }

  async getThreadId(ticketId) {
    return this.getSetting(this.threadSettingKey(ticketId))
  }

  async setThreadId(ticketId, threadId) {
    await this.setSetting(this.threadSettingKey(ticketId), threadId)
  }

  // The header used to be found by scanning a channel for an embed whose title matched the ticket
  // key. A Components V2 message has no embed and no title, so the id is remembered instead - in
  // the settings table, beside the thread id, for the same reason: the schema is frozen and this
  // needs no column. Two keys, because a Discord-native ticket has two headers: the staff one in
  // the private thread and the player-safe one in the channel.
  headerSettingKey(ticketId, which) {
    return which === 'player' ? `discord.ticket_player_header.${ticketId}` : `discord.ticket_header.${ticketId}`
  }

  async getHeaderId(ticketId, which = 'staff') {
    return this.getSetting(this.headerSettingKey(ticketId, which))
  }

  async setHeaderId(ticketId, messageId, which = 'staff') {
    await this.setSetting(this.headerSettingKey(ticketId, which), messageId)
  }

  // Who has been granted access to a closed ticket's channel. Stored rather than applied once,
  // because refreshVisibility rebuilds the overwrite list with permissionOverwrites.set() and
  // would wipe an overwrite that only existed on Discord's side.
  grantSettingKey(ticketId) {
    return `discord.ticket_grants.${ticketId}`
  }

  async ticketGrants(ticketId) {
    const raw = await this.getSetting(this.grantSettingKey(ticketId))
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []
    } catch {
      return []
    }
  }

  async addTicketGrant(ticketId, discordUserId) {
    const current = await this.ticketGrants(ticketId)
    if (current.includes(discordUserId)) return current
    const next = [...current, discordUserId]
    await this.setSetting(this.grantSettingKey(ticketId), JSON.stringify(next))
    return next
  }

  // The durable ticket body. It used to be read back out of the Discord embed's own description
  // and written straight back in, which worked only because an embed was there to hold it. The
  // events have always carried it; this reads the one that is current.
  async ticketBody(ticket) {
    if (ticket.source === 'ingame') {
      const [[row]] = await this.pool.execute(
        "SELECT payload_json FROM heimdall_event WHERE ticket_id = ?"
        + " AND event_type IN ('ingame_ticket_observed', 'ingame_ticket_closed')"
        + ' ORDER BY id DESC LIMIT 1',
        [ticket.id],
      )
      if (!row) return null
      const payload = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json
      return payload?.description ?? null
    }
    const intake = await this.ticketIntake(ticket.id)
    if (!intake) return null
    return intakeDescription(ticket.category, intake) || null
  }

  // Everything the queue board shows, computed by MySQL so the board never disagrees with the
  // database about how long something has been waiting.
  async queueSnapshot() {
    const [rows] = await this.pool.execute(
      "SELECT id, public_key, category, status, claimant_discord_user_id, claimant_gm_name,"
      + " TIMESTAMPDIFF(SECOND, opened_at, CURRENT_TIMESTAMP) AS open_seconds,"
      + " TIMESTAMPDIFF(SECOND, opened_at, COALESCE(claimed_at, CURRENT_TIMESTAMP)) AS unclaimed_seconds,"
      + " claimed_at IS NULL AS never_claimed"
      + " FROM heimdall_ticket WHERE status IN ('open', 'claimed', 'closing')"
      + " ORDER BY opened_at",
    )
    return rows
  }

  // Used to nudge about a ticket once rather than every time the board refreshes.
  async hasAudit(ticketId, action) {
    const [[row]] = await this.pool.execute(
      'SELECT id FROM heimdall_audit WHERE ticket_id = ? AND action = ? LIMIT 1',
      [ticketId, action],
    )
    return Boolean(row)
  }

  // hasAudit answers "has this EVER happened", which is the wrong question for anything a ticket
  // can do twice. A ticket closed in game, reopened, and closed in game again matched the
  // already-handled guard on the second closure and never reached Discord at all - the channel
  // sat open with no notice, which is the exact bug closeFromGame was written to fix. Every
  // once-per-life-of-the-ticket guard has to mean once per life SINCE THE LAST REOPEN.
  //
  // Compared on id, not created_at: ids are monotonic, and a close and a reopen inside the same
  // second are not distinguishable by a TIMESTAMP column.
  async hasAuditSinceReopen(ticketId, action) {
    const [[row]] = await this.pool.execute(
      'SELECT (SELECT MAX(id) FROM heimdall_audit WHERE ticket_id = ? AND action = ?) AS marked,'
      + " (SELECT MAX(id) FROM heimdall_audit WHERE ticket_id = ? AND action = 'ticket_reopened') AS reopened",
      [ticketId, action, ticketId],
    )
    if (row?.marked === null || row?.marked === undefined) return false
    return row.reopened === null || row.reopened === undefined || Number(row.marked) > Number(row.reopened)
  }

  async ticketsWithOpenWork() {
    const [rows] = await this.pool.execute("SELECT * FROM heimdall_ticket WHERE status IN ('open', 'claimed', 'closing')")
    return rows
  }

  // Open tickets whose most recent recorded activity is older than the cutoff. Last activity is
  // taken from the event log rather than a column, since the schema cannot grow one; a ticket
  // with no events at all falls back to when it was opened.
  async inactiveOpenTickets(days, limit = 25) {
    const [rows] = await this.pool.execute(
      "SELECT t.*, COALESCE(MAX(e.created_at), t.opened_at) AS last_activity"
      + ' FROM heimdall_ticket t LEFT JOIN heimdall_event e ON e.ticket_id = t.id'
      + " WHERE t.status IN ('open', 'claimed')"
      + ' GROUP BY t.id'
      + ' HAVING last_activity < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ? DAY)'
      + ' ORDER BY last_activity LIMIT ?',
      [days, limit],
    )
    return rows
  }

  // The module re-publishes a ticket every time gm_ticket's lastModifiedTime moves - closing it
  // counts - and the payload carries the ticket text unchanged. Counting how many observations
  // already hold this exact text separates a real edit by the player from a restatement of what
  // the channel has said since it was created.
  async ingameDescriptionSeen(ticketId, description) {
    const [[row]] = await this.pool.execute(
      "SELECT COUNT(*) AS seen FROM heimdall_event"
      + " WHERE ticket_id = ? AND event_type IN ('ingame_ticket_observed', 'ingame_ticket_closed')"
      + " AND JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.description')) = ?",
      [ticketId, description],
    )
    return Number(row.seen)
  }

  async ticketIntake(ticketId) {
    const [[row]] = await this.pool.execute(
      "SELECT payload_json FROM heimdall_event WHERE ticket_id = ? AND event_type = 'discord_ticket_created' LIMIT 1",
      [ticketId],
    )
    if (!row) return null
    const payload = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json
    return payload?.intake ?? null
  }

  async recordMessage({ ticketId, actorKind, actorRef, body, discordMessageId = null, idempotencyKey = null }) {
    const key = eventKey(['message', ticketId, actorKind, actorRef, idempotencyKey ?? discordMessageId ?? body])
    await this.pool.execute(
      "INSERT IGNORE INTO heimdall_event (ticket_id, event_key, event_type, actor_kind, actor_ref, payload_json) VALUES (?, ?, 'message', ?, ?, JSON_OBJECT('body', ?, 'discordMessageId', ?))",
      [ticketId, key, actorKind, actorRef, body, discordMessageId],
    )
    return key
  }

  async recordAttachment({ ticketId, eventKey: sourceEventKey, originalName, relativePath, contentType, byteSize, sha256, expiresAt }) {
    await this.pool.execute(
      'INSERT IGNORE INTO heimdall_attachment (ticket_id, source_event_key, original_name, stored_name, content_type, byte_size, sha256, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [ticketId, sourceEventKey, originalName, relativePath, contentType, byteSize, sha256, expiresAt],
    )
  }

  async enqueue({ ticketId, direction, kind, payload, uniqueParts, availableAt = null }) {
    const key = eventKey(['delivery', ticketId, direction, kind, ...uniqueParts])
    await this.pool.execute(
      'INSERT IGNORE INTO heimdall_delivery (ticket_id, delivery_key, direction, kind, payload_json, available_at) VALUES (?, ?, ?, ?, CAST(? AS JSON), COALESCE(?, CURRENT_TIMESTAMP))',
      [ticketId, key, direction, kind, JSON.stringify(payload), availableAt],
    )
    return key
  }

  async leaseBotDeliveries(limit, leaseSeconds) {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [rows] = await connection.execute(
        // Expired leases are picked back up: without this, a bot that dies mid-delivery strands
        // its jobs in 'leased' forever, because nothing else ever revisits that state.
        //
        // Only Discord-bound work. A row bound for the realm is the worldserver's: the module
        // leases it and performs it there, and leasing it here too would mean two sides running
        // one command.
        "SELECT * FROM heimdall_delivery WHERE direction = 'to_discord' AND available_at <= CURRENT_TIMESTAMP"
        + " AND (state = 'queued' OR (state = 'leased' AND leased_until < CURRENT_TIMESTAMP))"
        + ' ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED',
        [limit],
      )
      if (rows.length) {
        const ids = rows.map((row) => row.id)
        const markers = ids.map(() => '?').join(',')
        await connection.execute(
          `UPDATE heimdall_delivery SET state = 'leased', attempts = attempts + 1, lease_owner = ?, leased_until = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ? SECOND) WHERE id IN (${markers})`,
          [this.runId, leaseSeconds, ...ids],
        )
      }
      await connection.commit()
      return rows.map((row) => ({ ...row, payload: typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json }))
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async delivered(id) {
    await this.pool.execute("UPDATE heimdall_delivery SET state = 'delivered', delivered_at = CURRENT_TIMESTAMP, leased_until = NULL WHERE id = ? AND lease_owner = ?", [id, this.runId])
  }

  // Returns what it decided, because the caller cannot otherwise tell a retry from a burial - and
  // a job that has been buried is the one a human needs telling about. Reads the row back rather
  // than recomputing the IF() here, so there is one definition of "dead" and not two that can drift.
  async failed(id, error, maxAttempts) {
    await this.pool.execute(
      "UPDATE heimdall_delivery SET state = IF(attempts >= ?, 'dead', 'queued'), available_at = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL LEAST(900, POW(2, attempts) * 5) SECOND), leased_until = NULL, last_error = LEFT(?, 512) WHERE id = ? AND lease_owner = ?",
      [maxAttempts, String(error?.message ?? error), id, this.runId],
    )
    const [rows] = await this.pool.execute('SELECT state, attempts FROM heimdall_delivery WHERE id = ?', [id])
    return rows[0] ?? { state: 'queued', attempts: 0 }
  }

  // Rewrites a GM name to the realm's spelling wherever it is stored. The comparison is
  // case-insensitive by the column's own collation, so this matches the rows that need fixing and
  // leaves everything else alone.
  async canonicaliseGmName(fromName, canonical) {
    await this.pool.execute('UPDATE heimdall_staff SET gm_name = ? WHERE LOWER(gm_name) = LOWER(?)', [canonical, fromName])
    await this.pool.execute('UPDATE heimdall_ticket SET claimant_gm_name = ? WHERE LOWER(claimant_gm_name) = LOWER(?)', [canonical, fromName])
  }

  async expiredAttachments(limit = 100) {
    const [rows] = await this.pool.execute(
      "SELECT attachment.id, attachment.stored_name FROM heimdall_attachment attachment INNER JOIN heimdall_ticket ticket ON ticket.id = attachment.ticket_id WHERE attachment.expires_at <= CURRENT_TIMESTAMP AND ticket.status IN ('closed', 'cancelled') ORDER BY attachment.id LIMIT ?",
      [limit],
    )
    return rows
  }

  async removeAttachment(id) {
    await this.pool.execute('DELETE FROM heimdall_attachment WHERE id = ?', [id])
  }

  async expiredTicketIds(limit = 100) {
    const [rows] = await this.pool.execute(
      "SELECT id FROM heimdall_ticket WHERE status IN ('closed', 'cancelled') AND transcript_expires_at <= CURRENT_TIMESTAMP ORDER BY id LIMIT ?",
      [limit],
    )
    return rows.map((row) => row.id)
  }

  // Deliveries not attached to a ticket - the GM command audit batches - are never reached by
  // purgeTicketContent, which deletes by ticket_id. Without this they accumulate indefinitely.
  // Discord is the durable record; these rows are only transport.
  async pruneDeliveredSystemJobs(days = 7) {
    const [result] = await this.pool.execute(
      "DELETE FROM heimdall_delivery WHERE ticket_id IS NULL AND state = 'delivered'"
      + ' AND delivered_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ? DAY)',
      [days],
    )
    return result.affectedRows
  }

  async purgeTicketContent(ticketId) {
    await this.pool.execute('DELETE FROM heimdall_event WHERE ticket_id = ?', [ticketId])
    await this.pool.execute('DELETE FROM heimdall_delivery WHERE ticket_id = ?', [ticketId])
    await this.pool.execute('DELETE FROM heimdall_attachment WHERE ticket_id = ?', [ticketId])
    await this.pool.execute('DELETE FROM heimdall_audit WHERE ticket_id = ?', [ticketId])
    await this.pool.execute(
      "UPDATE heimdall_ticket SET player_name = NULL, discord_creator_id = NULL, claimant_discord_user_id = NULL, claimant_gm_name = NULL, discord_channel_id = NULL, summary = NULL, transcript_expires_at = NULL, version = version + 1 WHERE id = ?",
      [ticketId],
    )
  }

  async audit(ticketId, action, actorRef, metadata) {
    await this.pool.execute('INSERT INTO heimdall_audit (ticket_id, action, actor_ref, metadata_json) VALUES (?, ?, ?, CAST(? AS JSON))', [ticketId, action, actorRef, JSON.stringify(metadata)])
  }
}
