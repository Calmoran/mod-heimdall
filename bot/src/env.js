// Where the environment file is.
//
// Every supported launcher sets HEIMDALL_ENV_FILE: run-bot.cmd points it at the .env beside itself,
// the systemd unit at /etc/heimdall-bot/heimdall.env, the container at its own path. Running
// `node src/index.js` by hand sets nothing, and the failure that produced was misleading - no file
// was opened, so configuration validation reported every required value as missing, which reads as
// a broken .env rather than as an unread one. An operator then checks the file, finds it complete,
// and is no closer.
//
// So an unset variable means the .env beside the bot: the location the install guide gives, and the
// one run-bot.cmd already points at. It is resolved from this module's own path rather than the
// working directory, because the directory a bot is started from is not something to depend on.
import { fileURLToPath } from 'node:url'

export function resolveEnvFile(environment = process.env) {
  return environment.HEIMDALL_ENV_FILE || fileURLToPath(new URL('../.env', import.meta.url))
}
