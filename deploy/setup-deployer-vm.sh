#!/usr/bin/env bash
# Prepares a fresh Ubuntu VM to run the deployer. Run once as root:
#
#   sudo DEPLOYER_DOMAIN=admin.avro.site ./setup-deployer-vm.sh
#
# or press "Set up a VM" under Actions, which runs this for you.
#
# Safe to re-run. It installs Docker, creates the deployer's SSH key and
# secrets (kept in /opt/deployer, never printed again), and writes the files
# the "Deploy the deployer" workflow needs. The app itself is started by
# that workflow, which also delivers each new version.
set -euo pipefail
cd "$(dirname "$0")"
ROOT=/opt/deployer
[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)."; exit 1; }
: "${DEPLOYER_DOMAIN:?Set DEPLOYER_DOMAIN, e.g. admin.avro.site}"
[[ "$DEPLOYER_DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$ ]] || { echo "DEPLOYER_DOMAIN doesn't look like a domain"; exit 1; }
log() { echo "==> $*"; }

if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
if [[ -z "$(swapon --show 2>/dev/null)" ]]; then
  log "Adding a 2 GB swap file"
  if { [[ -f /swapfile ]] || { fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null; }; } && swapon /swapfile; then
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
fi

mkdir -p "$ROOT"/{data,keys,caddy/data,caddy/config}
# The app runs as uid 1001 inside its container.
chown 1001 "$ROOT/data"
cp docker-compose.yml "$ROOT/"

if [[ ! -f "$ROOT/keys/id_ed25519" ]]; then
  log "Creating the deployer's SSH key"
  ssh-keygen -q -t ed25519 -N '' -C deployer -f "$ROOT/keys/id_ed25519"
fi
chown -R 1001 "$ROOT/keys"; chmod 700 "$ROOT/keys"; chmod 600 "$ROOT/keys/id_ed25519"

FIRST=""
if [[ ! -f "$ROOT/.env" ]]; then
  log "Generating secrets"
  # DEPLOYER_SETUP_TOKEN can be given (the "Set up a VM" workflow passes a GitHub
  # secret) so the code never has to be printed; otherwise one is made up.
  GIVEN="${DEPLOYER_SETUP_TOKEN:-}"
  GIVEN="${GIVEN#"${GIVEN%%[![:space:]]*}"}"; GIVEN="${GIVEN%"${GIVEN##*[![:space:]]}"}"   # trim
  if [[ -n "$GIVEN" ]]; then
    (( ${#GIVEN} >= 16 )) || { echo "DEPLOYER_SETUP_TOKEN is ${#GIVEN} characters long; it must be 16 or more."; exit 1; }
    if [[ "$GIVEN" =~ [^[:graph:]] || "$GIVEN" == *[\'\"\\\$\`#]* ]]; then
      echo "DEPLOYER_SETUP_TOKEN can't contain spaces, quotes, backslashes, \$, \` or #."; exit 1
    fi
    FIRST="$GIVEN"
  else
    FIRST="$(openssl rand -hex 16)"
  fi
  {
    echo "DEPLOYER_SECRET_KEY=$(openssl rand -hex 32)"
    echo "DEPLOYER_SETUP_TOKEN=$FIRST"
    echo "DEPLOYER_URL=https://$DEPLOYER_DOMAIN"
  } > "$ROOT/.env"
  chmod 600 "$ROOT/.env"
fi
sed -i "s|^DEPLOYER_URL=.*|DEPLOYER_URL=https://$DEPLOYER_DOMAIN|" "$ROOT/.env"

# The public front door: PUBLIC_DOMAIN, or DEPLOYER_DOMAIN without its first
# label (admin.avro.site -> avro.site). Set PUBLIC_DOMAIN=none for no public site.
PUBLIC="${PUBLIC_DOMAIN:-}"
if [[ -z "$PUBLIC" && "$DEPLOYER_DOMAIN" =~ ^[^.]+\.(.+\..+)$ ]]; then PUBLIC="${BASH_REMATCH[1]}"; fi
[[ "$PUBLIC" == none ]] && PUBLIC=""
if [[ -n "$PUBLIC" ]]; then
  [[ "$PUBLIC" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$ ]] || { echo "PUBLIC_DOMAIN doesn't look like a domain"; exit 1; }
fi

{
  cat <<CADDY
$DEPLOYER_DOMAIN {
	encode zstd gzip
	reverse_proxy deployer-app:3100
}
CADDY
  if [[ -n "$PUBLIC" ]]; then
    cat <<CADDY

# Public pages only: the admin screens stay on $DEPLOYER_DOMAIN.
$PUBLIC {
	encode zstd gzip
	@admin path /admin /admin/* /api/admin/*
	redir @admin https://$DEPLOYER_DOMAIN{uri}
	reverse_proxy deployer-app:3100
}

www.$PUBLIC {
	redir https://$PUBLIC{uri} permanent
}
CADDY
  fi
} > "$ROOT/Caddyfile"
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx deployer-caddy; then
  log "Reloading Caddy"
  docker exec deployer-caddy caddy reload --config /etc/caddy/Caddyfile 2>&1 | tail -2 || echo "   (reload failed: run 'docker restart deployer-caddy')"
fi

# Daily copy of the deployer's own database, kept 14 days.
cat > /etc/cron.d/deployer-backup <<CRON
30 16 * * * root cp $ROOT/data/deployer.sqlite $ROOT/data/backup-\$(date -u +\%Y\%m\%d).sqlite 2>/dev/null; find $ROOT/data -name 'backup-*.sqlite' -mtime +14 -delete
CRON

log "Ready."
echo
if [[ -n "$PUBLIC" ]]; then echo "Public site: https://$PUBLIC (point $PUBLIC and www.$PUBLIC at this VM)."; echo; fi
echo "1. Public key for the clubs VM (DEPLOYER_PUBLIC_KEY in setup-clubs-vm.sh):"
echo "   $(cat "$ROOT/keys/id_ed25519.pub")"
echo
echo "2. This VM's host key (GitHub variable DEPLOYER_VM_HOST_KEY):"
echo "   $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null || echo '(run: ssh-keyscan -t ed25519 <this server>)')"
if [[ -n "$FIRST" && -n "${GIVEN:-}" ]]; then
  echo
  echo "3. One-time setup code for https://$DEPLOYER_DOMAIN/admin/setup: the DEPLOYER_SETUP_TOKEN you supplied."
elif [[ -n "$FIRST" ]]; then
  echo
  echo "3. One-time setup code for https://$DEPLOYER_DOMAIN/admin/setup (shown once):"
  echo "   $FIRST"
fi
