# Helpers for the "Set up a VM" workflow. Sourced, not run.
# Expects SSH_KEY, HOST, VM_USER and (optionally) HOST_KEY in the environment.

need() { # need VAR "what to set"
  [ -n "${!1:-}" ] || { echo "::error::Set the $2 first (Settings > Secrets and variables > Actions)."; exit 1; }
}

# Writes the key and known_hosts. With HOST_KEY set the VM must present that
# key; without it (a first run) the key it presents is accepted and reported.
connect() {
  install -d -m 700 ~/.ssh
  KEYFILE=$(mktemp ~/.ssh/vm-key.XXXXXX)
  KNOWN=$(mktemp ~/.ssh/vm-known.XXXXXX)
  printf '%s\n' "$SSH_KEY" | tr -d '\r' > "$KEYFILE"; chmod 600 "$KEYFILE"
  if [ -n "${HOST_KEY:-}" ]; then
    printf '%s %s\n' "$HOST" "$HOST_KEY" > "$KNOWN"
    SEEN_HOST_KEY="$HOST_KEY"
  else
    local scanned=""
    for _ in 1 2 3 4 5 6; do
      scanned=$(ssh-keyscan -T 10 -t ed25519 "$HOST" 2>/dev/null | grep " ssh-ed25519 " | grep -v "^#" | head -1) && [ -n "$scanned" ] && break
      sleep 5
    done
    [ -n "$scanned" ] || { echo "::error::Couldn't reach $HOST on port 22. Check the address and that the VM's firewall allows SSH."; exit 1; }
    printf '%s\n' "$scanned" > "$KNOWN"
    SEEN_HOST_KEY=$(printf '%s' "$scanned" | cut -d' ' -f2,3)
  fi
  SSH_OPTS=(-i "$KEYFILE" -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$KNOWN" -o BatchMode=yes -o ConnectTimeout=20)
}

vm_ssh() { ssh "${SSH_OPTS[@]}" "$VM_USER@$HOST" "$@"; }

# write_vars FILE NAME... : the named variables as a shell file, safely quoted.
write_vars() {
  local file=$1; shift
  : > "$file"; chmod 600 "$file"
  local name
  for name in "$@"; do
    [ -n "${!name:-}" ] && printf '%s=%q\n' "$name" "${!name}" >> "$file"
  done
  return 0
}

# run_remote DIR SCRIPT : copies DIR to the VM and runs DIR/SCRIPT as root with
# DIR/vars.env exported. Secrets travel in the file, never on a command line.
run_remote() {
  local dir=$1 script=$2
  tar czf - -C "$dir" . | vm_ssh "set -e; d=\$(mktemp -d); trap 'sudo rm -rf \"\$d\"' EXIT; tar xzf - -C \"\$d\"; sudo bash -c 'set -a; . \"\$1/vars.env\"; set +a; rm -f \"\$1/vars.env\"; exec bash \"\$1/$script\"' _ \"\$d\""
}
