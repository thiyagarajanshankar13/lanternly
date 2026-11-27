#!/usr/bin/env bash
# Prepares a fresh Ubuntu VM to run the deployer's services (apps, databases
# and, with the Avrosphere plugin, Avrosphere sites). Run once as root:
#
#   sudo DEPLOYER_PUBLIC_KEY="ssh-ed25519 AAAA… deployer" ACME_EMAIL=you@example.com ./setup-clubs-vm.sh
#
# Add GHCR_USER and GHCR_TOKEN (a token that can read packages) so this VM can
# pull the private Avrosphere image.
#
# Names and folders (written to <AGENT_ROOT>/agent.conf, read by clubctl):
#   AGENT_ROOT=/opt/avrosphere   where everything lives
#   AGENT_NAMESPACE=avrosphere   prefix of container names and labels (<namespace>-<service>)
# Leave both unset on a server that already runs sites: the defaults are the
# names it has always used. A server's names can't be changed once it has services.
#
# Safe to re-run (it also updates clubctl and its files). It installs Docker,
# adds swap, starts the shared Postgres and Caddy, and creates the `deployer`
# user whose SSH key can run clubctl and nothing else.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="${AGENT_ROOT:-/opt/avrosphere}"
NAMESPACE="${AGENT_NAMESPACE:-avrosphere}"
[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)."; exit 1; }
log() { echo "==> $*"; }
[[ "$ROOT" =~ ^/[A-Za-z0-9._/-]+$ && "$ROOT" != / ]] || { echo "AGENT_ROOT must be an absolute folder"; exit 1; }
[[ "$NAMESPACE" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || { echo "AGENT_NAMESPACE may only hold a-z, 0-9 and -"; exit 1; }
# The shared networks: the namespace itself and <namespace>-apps, except on
# servers set up before agent.conf, which keep avrosphere and avro-apps.
SHARED_NET="$NAMESPACE"; APPS_NET="$NAMESPACE-apps"
[[ "$NAMESPACE" == avrosphere ]] && APPS_NET=avro-apps
if [[ -f "$ROOT/agent.conf" ]]; then
  had="$(sed -n 's/^NAMESPACE=//p' "$ROOT/agent.conf")"
  [[ -z "$had" || "$had" == "$NAMESPACE" ]] || { echo "This server already uses the namespace $had: set AGENT_NAMESPACE=$had"; exit 1; }
elif [[ -d "$ROOT/clubs" && -n "$(ls -A "$ROOT/clubs" 2>/dev/null)" && "$NAMESPACE" != avrosphere ]]; then
  echo "This server already runs services under the old names: leave AGENT_NAMESPACE unset"; exit 1
fi
export NAMESPACE SHARED_NET APPS_NET AGENT_ROOT="$ROOT"

if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
if [[ -z "$(swapon --show 2>/dev/null)" ]]; then
  log "Adding a 4 GB swap file"
  if { [[ -f /swapfile ]] || { fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null; }; } && swapon /swapfile; then
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  else
    echo "   (couldn't add swap, carrying on)"
  fi
fi

mkdir -p "$ROOT"/{bin/files,bin/kinds,base/sites,base/pages,backups,removed,postgres,caddy/data,caddy/config,clubs,locks}
printf 'NAMESPACE=%s\nSHARED_NET=%s\nAPPS_NET=%s\n' "$NAMESPACE" "$SHARED_NET" "$APPS_NET" > "$ROOT/agent.conf"
chmod 644 "$ROOT/agent.conf"
install -m 755 clubctl clubctl-ssh "$ROOT/bin/"
# Kinds of service that come with deployer plugins (Avrosphere sites).
mkdir -p "$ROOT/bin/kinds"
for k in kinds/*.sh; do [[ -f "$k" ]] && install -m 644 "$k" "$ROOT/bin/kinds/"; done
# The core's compose files, plus any a service kind brings (Avrosphere: docker-compose.club.yml and start.sh).
for f in files/docker-compose.*.yml files/start.sh; do if [[ -f "$f" ]]; then install -m 644 "$f" "$ROOT/bin/files/"; fi; done
install -m 644 files/docker-compose.base.yml files/Caddyfile "$ROOT/base/"
install -m 644 files/paused.html "$ROOT/base/pages/"

if [[ ! -f "$ROOT/base/.env" ]]; then
  log "Generating the Postgres admin password"
  echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" > "$ROOT/base/.env"
  chmod 600 "$ROOT/base/.env"
fi
if [[ -n "${ACME_EMAIL:-}" ]]; then
  [[ "$ACME_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+$ ]] || { echo "ACME_EMAIL doesn't look like an email address"; exit 1; }
  printf '{\n\temail %s\n}\n' "$ACME_EMAIL" > "$ROOT/base/global.caddy"
elif [[ ! -f "$ROOT/base/global.caddy" ]]; then
  echo "# no ACME email set" > "$ROOT/base/global.caddy"
fi
# Caddy refuses to start on an import glob that matches nothing.
[[ -n "$(ls -A "$ROOT/base/sites")" ]] || echo "# placeholder" > "$ROOT/base/sites/_empty.caddy"
log "Starting Postgres and Caddy"
# Apps built from GitHub repos get their own network (Caddy joins it, Postgres doesn't).
docker network inspect "$APPS_NET" >/dev/null 2>&1 || docker network create "$APPS_NET" >/dev/null
docker compose -f "$ROOT/base/docker-compose.base.yml" --env-file "$ROOT/base/.env" up -d --wait postgres
docker compose -f "$ROOT/base/docker-compose.base.yml" --env-file "$ROOT/base/.env" up -d caddy
docker exec "$NAMESPACE-caddy" caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || docker restart "$NAMESPACE-caddy" >/dev/null
# Caddy joins every project's network (a recreated Caddy has lost them).
for net in $(docker network ls --filter "label=$NAMESPACE.project=1" --format '{{.Name}}'); do
  [[ "$(docker inspect -f "{{if index .NetworkSettings.Networks \"$net\"}}yes{{end}}" "$NAMESPACE-caddy")" == yes ]] || docker network connect "$net" "$NAMESPACE-caddy"
done

if [[ -n "${GHCR_TOKEN:-}" ]]; then
  log "Signing in to ghcr.io"
  echo "$GHCR_TOKEN" | docker login ghcr.io -u "${GHCR_USER:?set GHCR_USER too}" --password-stdin >/dev/null
fi

# Nightly database dumps of every club, kept 14 days.
cat > "$ROOT/bin/backup-all.sh" <<BACKUP
#!/usr/bin/env bash
set -euo pipefail
umask 077
DIR=$ROOT/backups
STAMP="\$(date -u +%Y%m%d-%H%M)"
for db in \$(docker exec $NAMESPACE-postgres psql -U postgres -qtA -c \\
  "SELECT datname FROM pg_database WHERE datname NOT IN ('postgres','template0','template1')"); do
  docker exec $NAMESPACE-postgres pg_dump -U postgres --no-owner --no-acl "\$db" | gzip > "\$DIR/\$db-\$STAMP.sql.gz"
  echo "\$(date -u +%FT%TZ) backed up \$db"
done
# PostgreSQL database services (their own containers).
for kind in $ROOT/clubs/*/.kind; do
  [[ "\$(cat "\$kind")" == postgres ]] || continue
  name="\$(basename "\$(dirname "\$kind")")"
  [[ "\$(cat "\$(dirname "\$kind")/.state" 2>/dev/null)" == running ]] || continue
  $ROOT/bin/clubctl backup "\$name" || echo "\$(date -u +%FT%TZ) backup of \$name failed"
done
find "\$DIR" \( -name '*.sql.gz' -o -name '*.dump' \) -mtime +14 -delete
BACKUP
chmod 755 "$ROOT/bin/backup-all.sh"
cat > "/etc/cron.d/$NAMESPACE-backup" <<CRON
# Nightly database backups (16:00 UTC = 2-3am Sydney), kept 14 days.
0 16 * * * root $ROOT/bin/backup-all.sh >> $ROOT/backups/backup.log 2>&1
CRON

# The deployer's login: key only, no shell, only clubctl through sudo.
if ! id deployer >/dev/null 2>&1; then
  log "Creating the deployer user"
  useradd --create-home --shell /bin/bash deployer
fi
echo "deployer ALL=(root) NOPASSWD: $ROOT/bin/clubctl" > "/etc/sudoers.d/$NAMESPACE-deployer"
chmod 440 "/etc/sudoers.d/$NAMESPACE-deployer"
if [[ -n "${DEPLOYER_PUBLIC_KEY:-}" ]]; then
  [[ "$DEPLOYER_PUBLIC_KEY" =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-[a-z0-9-]+)\ [A-Za-z0-9+/=]+(\ .*)?$ ]] || { echo "DEPLOYER_PUBLIC_KEY doesn't look like a public key"; exit 1; }
  install -d -m 700 -o deployer -g deployer /home/deployer/.ssh
  echo "command=\"$ROOT/bin/clubctl-ssh\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty $DEPLOYER_PUBLIC_KEY" > /home/deployer/.ssh/authorized_keys
  chown deployer:deployer /home/deployer/.ssh/authorized_keys; chmod 600 /home/deployer/.ssh/authorized_keys
  log "The deployer's key is installed"
else
  echo "   (no DEPLOYER_PUBLIC_KEY given: the deployer can't connect until you re-run with it)"
fi

log "Ready. Host key for the deployer's settings:"
cut -d" " -f1,2 /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null || echo "   (no ed25519 host key found: run ssh-keyscan -t ed25519 <this server> from your computer)"
