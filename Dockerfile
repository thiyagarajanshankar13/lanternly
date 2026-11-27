# The deployer web app. Build: docker build -t avrosphere-self-service .
FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production PORT=3100 HOSTNAME=0.0.0.0 DEPLOYER_DATA_DIR=/data
RUN useradd --system --uid 1001 --create-home deployer && mkdir -p /data && chown deployer /data
COPY --from=build --chown=deployer /app/.next/standalone ./
COPY --from=build --chown=deployer /app/.next/static ./.next/static
COPY --from=build --chown=deployer /app/public ./public
# The user guide index for the AI assistant's "How do I..." answers.
COPY --from=build --chown=deployer /app/assist ./assist
# The sites VM setup (clubctl and its files): sent to servers the deployer makes in Lightsail.
COPY --from=build --chown=deployer /app/agent ./agent
USER deployer
VOLUME /data
EXPOSE 3100
CMD ["node", "server.js"]
