# Security

## Reporting a problem

Please don't open a public issue for a security problem. Use GitHub's **Report a vulnerability** button on this repository's Security tab (private vulnerability reporting). Include what you found, how to reproduce it and what an attacker could do with it.

We aim to answer within 5 working days and to fix confirmed problems within 30 days, sooner for serious ones. We'll credit you in the release notes unless you'd rather we didn't.

Only the newest release gets security fixes.

## How the deployer is meant to be safe

Knowing the design helps you judge whether something is a bug.

- **The deployer can't get a shell on your servers.** Its SSH key is locked in `authorized_keys` to `agent/clubctl-ssh`, which only runs `clubctl` with a fixed set of commands, each argument checked. The `deployer` user's sudo rule allows that one program.
- **Host keys are pinned.** Each server's SSH host key is saved when the server is added, and the deployer refuses to talk to a server that presents another one.
- **Secrets are encrypted at rest** with AES-256-GCM under `DEPLOYER_SECRET_KEY` (app secret settings, registry tokens, bucket keys, SMTP password, two-step sign-in secrets). Database passwords are made on the server and never stored by the deployer.
- **Backups are encrypted before upload** with a backup key that only the deployer holds. The services VM never talks to the bucket.
- **Sign-in** needs a password and an authenticator code for everyone. Sessions are server-side and end at once when someone is suspended or removed.
- **Access is checked on every action.** `src/lib/access.ts` holds the rules; `tests/access.test.ts` fails if a server action or admin API route forgets to call a check. A service a person may not see answers 404.
- **Logs are masked** for secret settings and anything that looks like a password or token before they leave the deployer.
- **Monitoring refuses private and loopback addresses**, so it can't be used to probe your own network.

## Out of scope

- Anything that needs an owner account (owners can already do everything).
- Attacks that need root on the deployer VM or a services VM.
- Problems in the apps you deploy with it.
- Rate limits and denial of service against a single install, unless they are easy to trigger without signing in.
