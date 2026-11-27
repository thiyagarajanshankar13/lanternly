# Contributing

Thanks for helping. Bug reports, fixes, docs and new plugins are all welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Security problems go through private reporting, not issues: see [SECURITY.md](SECURITY.md).

## Working on it

```bash
cp .env.example .env.local      # DEPLOYER_SECRET_KEY (64 hex characters), DEPLOYER_SETUP_TOKEN, DEPLOYER_FAKE_ENGINE=1
npm install
npm run dev                     # http://localhost:3100/admin, with a simulated server and GitHub
```

Before you send a pull request:

```bash
npm run typecheck
npm test
npx next build
```

- Add or change tests with the code. Tests live in `tests/`, a plugin's in `tests/plugins/<id>/`.
- `tests/contract.test.ts` snapshots every `clubctl` call and the settings sent with it. A changed snapshot is a change to what live servers receive: only update it on purpose (`npx vitest run -u`), with a matching change to `agent/clubctl`, and say so in the pull request.
- Every server action and admin API route must call an access check (`requireOwner`, `requireSite` and friends in `src/lib/guards.ts`). `tests/access.test.ts` fails otherwise.
- Database changes are a new entry at the end of `MIGRATIONS` in `src/lib/db.ts`. Never edit an existing one.
- Keep on-screen text plain and short. Changes to how a page looks are easier to agree on with a screenshot in the pull request.

## Sign your commits (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/) instead of a CLA. Add a `Signed-off-by` line to each commit to confirm you wrote the change or have the right to submit it under this project's licence:

```bash
git commit -s -m "Fix the backup retry"
```

By contributing you agree your work is released under the [GNU AGPL v3](LICENSE).

## Writing a plugin

A plugin adds a service kind, pages, settings or timers without the core knowing about it. The AWS plugin (`src/plugins/aws/`) is a full example.

1. Make `src/plugins/<id>/plugin.ts` exporting a `DeployerPlugin` (`src/plugins/types.ts`): id, name, description, icon, the pages it owns, optional side-menu items and service kinds.
2. Add one line for it to `src/plugins/installed.ts`, and if it has them, to `installed-hooks.ts` (server code: timers, service kind steps, `latestVersion`) and `installed-parts.ts` (React parts: settings card, Servers or Services page parts, a service's page).
3. Pages under `src/app/admin/(console)/` that belong to the plugin check `requirePlugin('<id>')`; actions return `pluginOffError('<id>')` while it is off.
4. A service kind's own steps on the server go in `agent/kinds/<id>.sh`, which `clubctl` loads when present.
5. Owners turn it on under Settings → Plugins. Nothing it adds should show while it is off.

### Tagging plugin lines

Every line in shared files that mentions a plugin ends with a comment `plugin:<id>` (for example `// plugin:aws`), and longer stretches sit between `plugin:<id>:start` and `plugin:<id>:end` comments. A file whose first line carries the tag belongs to the plugin as a whole. This lets `scripts/export-core.mjs` produce a copy without any given plugin, so keep the tags when you edit those lines.
