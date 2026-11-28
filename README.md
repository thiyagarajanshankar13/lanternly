<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/lanternly-logo-dark.png">
    <img src="brand/lanternly-logo-light.png" alt="Lanternly" width="320">
  </picture>
</h1>

A small, self-hosted platform for running web apps and PostgreSQL databases on your own Linux servers, in the style of Railway or Render. You get a web console where you:

- deploy apps from a GitHub repo (built on GitHub Actions) or from a ready-made Docker image;
- give apps HTTPS addresses under your own domain, plus custom domains;
- group services into projects with a private network each;
- run PostgreSQL with backups, upgrades and a size quota;
- give apps S3-compatible bucket storage (MinIO) on their own server;
- back up to any S3-compatible bucket, encrypted before upload;
- monitor your sites (and sites hosted anywhere else) with email alerts;
- give people access per project, as owner, operator or viewer.

It runs on any Ubuntu 24.04 VM with Docker: AWS, Google Cloud, Vultr, Hetzner, DigitalOcean or a box under your desk. Licensed under the [GNU AGPL v3](LICENSE).

## How it fits together

```
Deployer VM (small)                      Services VM(s)
┌──────────────────────────┐   SSH,      ┌────────────────────────────────────┐
│ Caddy → deployer app     │  clubctl    │ Caddy → one container per service   │
│ (Next.js + SQLite)       │ ──────────► │ apps, PostgreSQL, plugin services   │
│ admin.example.com        │   only      │ *.example.com + custom domains      │
└──────────────────────────┘             └────────────────────────────────────┘
```

- **`agent/clubctl`** runs on each services VM and does the real work: create, configure, deploy, pause, resume, back up, restore, remove, status, logs. Caddy on that VM serves every service over HTTPS.
- **The deployer app** (`src/`) keeps the list of services, queues each change as an operation, and calls `clubctl` over SSH. Its SSH key is locked to `clubctl` on the VM (`agent/clubctl-ssh`), so it never gets a shell there, and it refuses a server whose host key doesn't match.
- **Secrets.** Database passwords are generated on the services VM and never leave it. App secret settings, bucket keys and two-step sign-in secrets are stored encrypted (AES-256-GCM, `DEPLOYER_SECRET_KEY`).

## Setting it up

You need two Ubuntu 24.04 VMs (deployer: 2 GB; services: 4 GB or more), each with a static IP and ports 22, 80 and 443 open, and a domain whose DNS you control.

1. **DNS.** `admin.example.com` → deployer VM. `*.example.com` → services VM.
2. **Deployer VM.** Copy `deploy/` to it and run `sudo DEPLOYER_DOMAIN=admin.example.com ./setup-deployer-vm.sh`. It prints the deployer's SSH public key, the VM's host key and a one-time setup code. Then either let the "Deploy the deployer" workflow build and deliver the app (it needs the secret `DEPLOYER_VM_SSH_KEY` and the variable `DEPLOYER_VM_HOST`), or build it on the VM yourself: `docker build -t deployer .` in a copy of this repo, then `sudo env DEPLOYER_IMAGE=deployer docker compose up -d` in `/opt/deployer`.
3. **Services VM.** Copy `agent/` to it and run `sudo DEPLOYER_PUBLIC_KEY="<the public key from step 2>" ACME_EMAIL=you@example.com ./setup-clubs-vm.sh`. Add `GHCR_USER` and `GHCR_TOKEN` (a token that can read packages) if your app images are private on ghcr.io. Then limit port 22 on it to the deployer VM's IP. `AGENT_ROOT` and `AGENT_NAMESPACE` choose the folder and container name prefix.
4. **First sign-in.** Open `https://admin.example.com/admin`, enter the setup code, create the first owner and scan the QR code with an authenticator app. Then remove `DEPLOYER_SETUP_TOKEN` from `/opt/deployer/.env`.
5. **In the deployer.** Settings → set the base domain (`example.com`) and the outgoing email account. Servers → add the services VM (address, public IP, host key, how many services it holds). Then Services → New app.

The "Set up a VM" workflow (`.github/workflows/setup-vm.yml`) can run steps 2 and 3 for you from GitHub Actions; its header lists the secrets and variables it needs.

## Apps

- **From GitHub.** Settings → GitHub apps → **Connect GitHub**: enter your organisation and your copy of this repo, press **Create GitHub app**, confirm on GitHub and install it on this repo plus the repos you deploy. The deployer saves the App's ID, key and webhook secret itself and copies the ID and key into this repo's Actions secrets for the build workflow (`DEPLOYER_URL` must be the deployer's public https address so GitHub can send pushes). An App you made by hand still works: Settings → GitHub apps (Contents: Read, Metadata: Read, Actions: Read and write, Secrets: Read and write optional, the Push event). A repo needs a `Dockerfile` and one web port. The deployer runs `.github/workflows/build-app-image.yml`, which pushes `ghcr.io/<owner>/app-<name>:<commit>`, then deploys it. Every push to the app's branch can deploy itself. Versions are commits; Roll back starts an earlier image without building.
- **From a Docker image.** `nginx:1.27`, `ghcr.io/owner/app:v2`, `image@sha256:…` or a Docker Hub link. The tag is pinned to the digest it pulled. Private registries take a read-only token, used once per pull.
- **Health checks.** A new version must answer its health page within 2 minutes or the previous one is started again.
- **Settings and secrets.** Plain settings and secret ones (stored encrypted, masked in logs). Apps get `PORT`.
- No volumes yet: keep data in a project database.

## Projects and PostgreSQL

A project groups services on one server, with its own Docker network where each service is reachable by name (`shop-db:5432`). Projects can't reach each other.

- **PostgreSQL** (16 by default) runs in its own container with a volume and a health check. The password stays on the server; Connect → Reveal reads it over SSH and records who did. **New password** rotates it and restarts the apps using it; **Newer PostgreSQL** upgrades by dump and restore, rolling back on failure.
- **Linking.** Tick a database in an app's settings to give it `DATABASE_URL` and the `PG*` variables, or use `${{shop-db.DATABASE_URL}}` in any setting. They are filled in on the server.
- **Pre-deploy command** (`npm run migrate`) runs once per new version before it takes over.
- **Quota.** A soft size limit per database with alerts at 80% and 100%, read-only at 100%.

## S3 storage

**New service → S3 storage (MinIO)** gives a project its own S3-compatible storage: one MinIO container per storage, up to 20 buckets, each readable by apps only or by anyone with the link, and an optional HTTPS address for public files and signed links. Tick it in an app's settings under **Databases and storage** and pick a bucket: the app gets `S3_ENDPOINT`, `S3_PUBLIC_URL`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and `S3_FORCE_PATH_STYLE`, plus the `AWS_*` names AWS SDKs read when there's no prefix. Keys are made on the server and never stored by the deployer; **New keys** rotates them. A soft quota emails at 80% and 100%. Storage is backed up with everything else.

## Backups

Backups go to any S3-compatible bucket (AWS S3, Lightsail, Backblaze B2, Cloudflare R2, MinIO…), on a schedule per service, before upgrades and restores, and by hand. Everything is encrypted with a backup key before upload; keep that key in a password manager, because losing it means losing the backups. Files are stored once per content. A backup can be restored onto the service or into a copy at a new address. `scripts/backup-tool.mjs` reads the bucket without the deployer.

## Monitoring

Every service with an address is checked every few minutes (`<site>/api/health` if it has one, else its home page), and you can add sites hosted anywhere by address. It records up or down, speed, version and certificate expiry, and emails when a site fails twice in a row, comes back, or has a certificate about to run out. Sites can be grouped by label.

## People and access

| | Owner | Operator | Viewer |
|---|---|---|---|
| Status, versions, addresses, monitoring, logs | everything | their services | their services |
| Deploy, restart, pause, roll back, settings, domains, back up now | yes | their services | no |
| Add apps and databases to a project | yes | their whole projects | no |
| Create, remove or restore services, projects, servers, settings, people | yes | no | no |

Everyone signs in with a password and an authenticator app. People are invited with a one-time link. An access log keeps a year of sign-ins, changes and log reads.

## Plugins

Plugins add service kinds, pages and settings without the core knowing about them. Each lives in `src/plugins/<id>/` with a `plugin.ts` descriptor, and is listed with one line each in `src/plugins/installed.ts`, `installed-hooks.ts` and `installed-parts.ts`. Owners turn them on and off under Settings → Plugins. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to write one.

**Amazon Web Services** (included): creates and deletes Lightsail servers from the console, and shows what AWS charges (Cost Explorer) in a currency you pick, with budget alerts and a per-project estimate. Off by default.

## Running it locally

```bash
cp .env.example .env.local      # set DEPLOYER_SECRET_KEY (64 hex characters), DEPLOYER_SETUP_TOKEN, DEPLOYER_FAKE_ENGINE=1
npm install
npm run dev                     # http://localhost:3100/admin
npm test
npm run typecheck
```

`DEPLOYER_FAKE_ENGINE=1` simulates the services VM and GitHub, so every screen works without either. To try `clubctl` for real on a machine with Docker, run `sudo ./agent/setup-clubs-vm.sh` and use names under `.localhost`.

## Known limits

- One operation runs at a time across all servers (app builds run on GitHub, outside that queue).
- Certificates are issued per address (Let's Encrypt allows about 50 new ones a week per registered domain).
- While a new app version starts, the app is briefly unavailable.
- Apps have no volumes; data belongs in a database or S3 storage.
- Some internal names (the default folder `/opt/avrosphere`, container prefix `avrosphere`) come from the project this was extracted from. Set `AGENT_ROOT` and `AGENT_NAMESPACE` on a new server to use your own.

## Licence

Copyright the contributors. Released under the GNU Affero General Public License v3.0 only. If you run a modified version as a service for others, you must offer them its source.
