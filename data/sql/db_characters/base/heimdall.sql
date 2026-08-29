-- mod-heimdall owns only tables with this prefix. It reads gm_ticket but never mutates it.
--
-- These tables were named mod_discord_tickets_* before the module was renamed to Heimdall. There
-- is no migration and none is coming: the rename happened before first publication, so no install
-- exists that could need one. An operator who somehow has the old tables should drop them.

CREATE TABLE IF NOT EXISTS heimdall_ticket (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source ENUM('ingame','discord') NOT NULL,
  -- Realm this ticket belongs to. Defaults to '' so a Discord-sourced INSERT that predates
  -- realm awareness still succeeds; the game side always writes a real tag. Width is headroom for
  -- a hand-written prefix: worldserver refuses a RealmID above 255 (the client reads it as a
  -- uint8), so the automatic fallback tag is at most "R255".
  realm_tag VARCHAR(16) NOT NULL DEFAULT '',
  source_ticket_id BIGINT UNSIGNED NULL,
  -- gm_ticket.lastModifiedTime as of the last time the poller recorded this row. Lets the
  -- poller rebuild its in-memory state after a restart without rewriting unchanged tickets.
  source_modified_time INT UNSIGNED NULL,
  public_key VARCHAR(48) NOT NULL,
  player_guid BIGINT UNSIGNED NULL,
  -- The auth account behind the character. Ticket history and player notes are keyed on the
  -- account, not the character, so they follow a player across alts. Populated by the module
  -- from characters.account; the bot has no access to that table by design.
  player_account_id INT UNSIGNED NULL,
  player_name VARCHAR(12) NULL,
  discord_creator_id VARCHAR(32) NULL,
  category VARCHAR(32) NOT NULL,
  status ENUM('open','claimed','closing','closed','cancelled') NOT NULL DEFAULT 'open',
  discord_channel_id VARCHAR(32) NULL,
  claimant_discord_user_id VARCHAR(32) NULL,
  claimant_gm_name VARCHAR(12) NULL,
  opened_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claimed_at TIMESTAMP NULL,
  closed_at TIMESTAMP NULL,
  transcript_expires_at TIMESTAMP NULL,
  summary TEXT NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_heimdall_public_key (public_key),
  UNIQUE KEY uq_heimdall_source (source, realm_tag, source_ticket_id),
  KEY ix_heimdall_status (status, opened_at),
  KEY ix_heimdall_player (player_guid, status),
  KEY ix_heimdall_player_account (player_account_id, opened_at),
  KEY ix_heimdall_creator (discord_creator_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS heimdall_event (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_id BIGINT UNSIGNED NOT NULL,
  event_key CHAR(64) NOT NULL,
  event_type VARCHAR(48) NOT NULL,
  actor_kind ENUM('player','staff','bot','system') NOT NULL,
  actor_ref VARCHAR(64) NULL,
  payload_json JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_heimdall_event_key (event_key),
  KEY ix_heimdall_event_ticket (ticket_id, id),
  CONSTRAINT fk_heimdall_event_ticket
    FOREIGN KEY (ticket_id) REFERENCES heimdall_ticket(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS heimdall_delivery (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- Nullable: a delivery is not always about a ticket. The GM command audit log rides this
  -- same queue with no ticket attached, rather than inventing a second transport.
  ticket_id BIGINT UNSIGNED NULL,
  delivery_key CHAR(64) NOT NULL,
  direction ENUM('to_discord','to_game','soap') NOT NULL,
  kind VARCHAR(48) NOT NULL,
  payload_json JSON NOT NULL,
  state ENUM('queued','leased','delivered','failed','dead') NOT NULL DEFAULT 'queued',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  available_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  leased_until TIMESTAMP NULL,
  lease_owner VARCHAR(64) NULL,
  delivered_at TIMESTAMP NULL,
  last_error VARCHAR(512) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_heimdall_delivery_key (delivery_key),
  KEY ix_heimdall_delivery_lease (state, available_at, leased_until),
  CONSTRAINT fk_heimdall_delivery_ticket
    FOREIGN KEY (ticket_id) REFERENCES heimdall_ticket(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS heimdall_attachment (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_id BIGINT UNSIGNED NOT NULL,
  message_event_id BIGINT UNSIGNED NULL,
  source_event_key CHAR(64) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  stored_name VARCHAR(255) NOT NULL,
  content_type VARCHAR(128) NULL,
  byte_size BIGINT UNSIGNED NOT NULL,
  sha256 CHAR(64) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_heimdall_attachment_store (stored_name),
  UNIQUE KEY uq_heimdall_attachment_event (source_event_key, stored_name),
  KEY ix_heimdall_attachment_expiry (expires_at),
  CONSTRAINT fk_heimdall_attachment_ticket
    FOREIGN KEY (ticket_id) REFERENCES heimdall_ticket(id) ON DELETE CASCADE,
  CONSTRAINT fk_heimdall_attachment_event
    FOREIGN KEY (message_event_id) REFERENCES heimdall_event(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS heimdall_staff (
  discord_user_id VARCHAR(32) NOT NULL,
  gm_name VARCHAR(12) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (discord_user_id),
  UNIQUE KEY uq_heimdall_staff_gm (gm_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS heimdall_setting (
  setting_key VARCHAR(96) NOT NULL,
  setting_value TEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS heimdall_audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_id BIGINT UNSIGNED NULL,
  -- Set when the row is about a player rather than a ticket, so account-scoped notes stay
  -- queryable and survive the retention purge that clears rows by ticket_id.
  subject_account_id INT UNSIGNED NULL,
  action VARCHAR(64) NOT NULL,
  actor_ref VARCHAR(64) NULL,
  metadata_json JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_heimdall_audit_ticket (ticket_id, id),
  KEY ix_heimdall_audit_created (created_at),
  KEY ix_heimdall_audit_subject (subject_account_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
