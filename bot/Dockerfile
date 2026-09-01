# The Heimdall bot, for running beside an AzerothCore Docker stack.
#
# Node 22 because that is what the project's Linux install runs and what CI tests; package.json
# declares >=20 as the floor. Alpine because the bot needs no native build tooling at runtime.
FROM node:22-alpine

WORKDIR /app

# Dependencies first, so a source change does not reinstall them. --omit=dev because nothing in the
# test suite is needed to run the bot.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# Transcripts and attachments. Mounted as a volume by the compose fragment - declared here so the
# path exists and is writable even when it is not mounted.
RUN mkdir -p /var/lib/heimdall/archive && chown -R node:node /var/lib/heimdall /app

# Never root. The bot opens no listener; it connects out to Discord and inward to MySQL.
USER node

CMD ["node", "src/index.js"]
