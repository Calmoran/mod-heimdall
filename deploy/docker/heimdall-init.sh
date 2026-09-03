#!/bin/bash
# Heimdall's database and the bot's account, created when the MySQL container initialises.
#
# The mysql image runs everything in /docker-entrypoint-initdb.d/ exactly once, on the first start
# with an empty data volume, against a temporary server that only listens on its socket. The
# compose fragment in bot/deploy/docker-compose.bot.yml mounts this file there and passes the
# bot's password in as HEIMDALL_BOT_DB_PASSWORD; MYSQL_ROOT_PASSWORD is the container's own.
#
# The core connects to ac-database as root in the shipped compose, so it needs no grant of its
# own here. The bot's account gets Heimdall's database and nothing else, from '%' because it
# connects from another container on the Compose network, never from localhost.
#
# An existing volume is not touched: this file never runs against one. Create the database and
# the account by hand there (deploy/create-heimdall-database.sql, bot/deploy/mysql-grants.sql).

# No `set -euo pipefail` here on purpose. The entrypoint executes this file if the bind mount made
# it executable and sources it otherwise, and a sourced `set -u` would apply to the rest of the
# entrypoint. Failures are checked explicitly instead; `exit 1` stops the container either way.

if [ -z "${HEIMDALL_BOT_DB_PASSWORD:-}" ]; then
  echo "heimdall-init: HEIMDALL_BOT_DB_PASSWORD is not set in the compose .env" >&2
  exit 1
fi
if [ -z "${MYSQL_ROOT_PASSWORD:-}" ]; then
  echo "heimdall-init: MYSQL_ROOT_PASSWORD is not set" >&2
  exit 1
fi

HEIMDALL_DATABASE="${HEIMDALL_DATABASE:-heimdall}"

# The password goes into a SQL string literal: escape the two characters that could end it.
password="${HEIMDALL_BOT_DB_PASSWORD//\\/\\\\}"
password="${password//\'/\\\'}"

case "$HEIMDALL_DATABASE" in
  *[!A-Za-z0-9_\$]*|"")
    echo "heimdall-init: HEIMDALL_DATABASE '$HEIMDALL_DATABASE' is not a plain identifier" >&2
    exit 1
    ;;
esac

echo "heimdall-init: creating database \`$HEIMDALL_DATABASE\` and account 'heimdall_bot'@'%'"

MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --protocol=socket -uroot <<SQL
CREATE DATABASE IF NOT EXISTS \`$HEIMDALL_DATABASE\` DEFAULT CHARACTER SET utf8mb4;
CREATE USER IF NOT EXISTS 'heimdall_bot'@'%' IDENTIFIED BY '$password';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`$HEIMDALL_DATABASE\`.* TO 'heimdall_bot'@'%';
FLUSH PRIVILEGES;
SQL
if [ $? -ne 0 ]; then
  echo "heimdall-init: failed - see the MySQL error above" >&2
  exit 1
fi
echo "heimdall-init: done"
