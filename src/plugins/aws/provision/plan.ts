// Pure rules for servers the deployer makes in Lightsail itself: sizes and
// their prices, names, the budget check, the firewall, the AWS policy and the
// scripts a new VM runs on first boot. No database, no AWS (tested in
// tests/provision.test.ts).
import { fmtMoney, type CurrencyCode } from '../money'

/** A Lightsail plan as GetBundles describes it (US$ a month). */
export type Bundle = { bundleId: string; ramGb: number; cpus: number; diskGb: number; transferGb: number; priceUsd: number }

export type Purpose = 'sites' | 'apps'

/** The sizes offered, smallest first. 1 GB is for one small app, never a site. */
export const SIZES: { ramGb: number; maxSites: number; purpose: Purpose; fits: string }[] = [
  { ramGb: 1, maxSites: 1, purpose: 'apps', fits: 'one small app (not a site)' },
  { ramGb: 2, maxSites: 2, purpose: 'sites', fits: '2 sites' },
  { ramGb: 4, maxSites: 5, purpose: 'sites', fits: '5 sites' },
  { ramGb: 8, maxSites: 10, purpose: 'sites', fits: '10 sites' },
  { ramGb: 16, maxSites: 20, purpose: 'sites', fits: '20 sites' },
]
export const DEFAULT_SIZE_GB = 8
export const sizeFor = (ramGb: number) => SIZES.find((s) => s.ramGb === ramGb) ?? null

export type SizeOption = (typeof SIZES)[number] & { bundle: Bundle }

/** The cheapest active Linux plan with each offered amount of memory (IPv4, so it can have a static IP). */
export function sizeOptions(bundles: (Bundle & { active?: boolean; linux?: boolean })[]): SizeOption[] {
  const out: SizeOption[] = []
  for (const size of SIZES) {
    const best = bundles
      .filter((b) => b.active !== false && b.linux !== false && !/ipv6/i.test(b.bundleId) && Math.abs(b.ramGb - size.ramGb) < 0.01)
      .sort((a, b) => a.priceUsd - b.priceUsd)[0]
    if (best) out.push({ ...size, bundle: best })
  }
  return out
}

/** "avro-sydney-2" from "Sydney 2": the VM's name in Lightsail. */
export function lightsailNameFor(display: string): string {
  const slug = display.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return `avro-${slug || 'server'}`
}

export function serverNameError(name: string): string | null {
  if (!name) return 'Give the server a name, like Sydney 2.'
  if (name.length > 40) return 'Keep the name under 40 characters.'
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name)) return 'Use letters, digits, spaces, dots, dashes or underscores.'
  return null
}

/** A US$ price in the currency costs are shown in. */
export const priceText = (usd: number, rate: number, currency: CurrencyCode, locale = 'en-US') => fmtMoney(Math.round(usd * rate * 100) / 100, currency, locale)

export type BudgetCheck = {
  /** A month for the VMs and bucket today, the new server, and both, in the currency costs are shown in. */
  nowCost: number; addCost: number; afterCost: number
  budget: number
  over: boolean
  text: string
  /** Formats an amount like the rest of this check. */
  money: (n: number) => string
}

/**
 * Whether a new server keeps the fixed monthly Lightsail cost (every VM and
 * bucket at its plan price) within the budget. No budget = never over.
 */
export function budgetCheck(o: { currentUsd: number; addUsd: number; rate: number; budget: number; currency: CurrencyCode; locale?: string }): BudgetCheck {
  const r2 = (n: number) => Math.round(n * 100) / 100
  const nowCost = r2(o.currentUsd * o.rate)
  const addCost = r2(o.addUsd * o.rate)
  const afterCost = r2(nowCost + addCost)
  const over = o.budget > 0 && afterCost > o.budget
  const money = (n: number) => fmtMoney(n, o.currency, o.locale)
  const text = o.budget > 0
    ? `Plans today ${money(nowCost)} a month, ${money(afterCost)} with this server. Budget ${money(o.budget)}.`
    : `Plans today ${money(nowCost)} a month, ${money(afterCost)} with this server. No budget set.`
  return { nowCost, addCost, afterCost, budget: o.budget, over, text, money }
}

/** Why another server can't be made, or null. Counts servers already made and ones being made. */
export function limitError(managed: number, max: number): string | null {
  return managed >= max ? `The deployer already has ${managed} server${managed === 1 ? '' : 's'} it made (the limit is ${max}). Delete one or raise the limit under "AWS for new servers".` : null
}

// ── Firewall ────────────────────────────────────────────────────────────────

export type PortRule = { fromPort: number; toPort: number; protocol: 'tcp' | 'udp'; cidrs: string[]; ipv6Cidrs: string[]; cidrListAliases: string[] }

export const isIpv4 = (ip: string) => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(ip)

/**
 * Web traffic from anywhere; SSH only from the deployer (and Lightsail's own
 * browser SSH, so the server can still be reached from the AWS console).
 */
export function portRules(deployerIp: string): PortRule[] {
  if (!isIpv4(deployerIp)) throw new Error(`The deployer's IP (${deployerIp || 'empty'}) isn't an IPv4 address.`)
  const web = { cidrs: ['0.0.0.0/0'], ipv6Cidrs: ['::/0'], cidrListAliases: [] }
  return [
    { fromPort: 22, toPort: 22, protocol: 'tcp', cidrs: [`${deployerIp}/32`], ipv6Cidrs: [], cidrListAliases: ['lightsail-connect'] },
    { fromPort: 80, toPort: 80, protocol: 'tcp', ...web },
    { fromPort: 443, toPort: 443, protocol: 'tcp', ...web },
    { fromPort: 443, toPort: 443, protocol: 'udp', ...web },
  ]
}

// ── AWS policy ──────────────────────────────────────────────────────────────

export const MANAGED_TAG = 'avro-managed'

/** What the "new servers" key needs: paste as an inline policy on its own IAM user. */
export function provisionPolicy(region = 'ap-southeast-2'): string {
  const inRegion = { StringEquals: { 'aws:RequestedRegion': region } }
  const tagged = { StringEquals: { 'aws:RequestedRegion': region, [`aws:ResourceTag/${MANAGED_TAG}`]: 'yes' } }
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      { Sid: 'Read', Effect: 'Allow', Resource: '*', Condition: inRegion, Action: [
        'lightsail:GetBundles', 'lightsail:GetBlueprints', 'lightsail:GetRegions', 'lightsail:GetInstance', 'lightsail:GetInstances',
        'lightsail:GetStaticIp', 'lightsail:GetStaticIps', 'lightsail:GetInstanceSnapshot', 'lightsail:GetInstanceSnapshots',
      ] },
      { Sid: 'CreateOnlyTagged', Effect: 'Allow', Resource: '*', Action: ['lightsail:CreateInstances', 'lightsail:TagResource'],
        Condition: { StringEquals: { 'aws:RequestedRegion': region, [`aws:RequestTag/${MANAGED_TAG}`]: 'yes' } } },
      { Sid: 'ChangeOnlyTagged', Effect: 'Allow', Resource: '*', Condition: tagged, Action: [
        'lightsail:PutInstancePublicPorts', 'lightsail:CreateInstanceSnapshot', 'lightsail:DeleteInstance', 'lightsail:DeleteInstanceSnapshot',
      ] },
      // Static IPs can't carry tags; the deployer only ever touches the ones it named avro-ip-….
      { Sid: 'StaticIps', Effect: 'Allow', Resource: '*', Condition: inRegion, Action: [
        'lightsail:AllocateStaticIp', 'lightsail:AttachStaticIp', 'lightsail:DetachStaticIp', 'lightsail:ReleaseStaticIp',
      ] },
    ],
  }, null, 2)
}

// ── First boot ──────────────────────────────────────────────────────────────

/** Single-quotes a value for bash. */
export const sq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`

/**
 * The launch script Lightsail runs as root on first boot. Tiny on purpose: it
 * fetches the real setup from the deployer with a one-time code, so no secret
 * sits in the VM's launch settings for longer than the setup takes.
 */
export function userData(o: { deployerUrl: string; jobId: number; token: string }): string {
  const url = `${o.deployerUrl.replace(/\/+$/, '')}/api/provision/${o.jobId}/script`
  return [
    '#!/bin/bash',
    '# Deployer: fetch this server\'s setup and run it (tries for 15 minutes).',
    `for i in $(seq 1 60); do`,
    `  if curl -fsS -m 30 -H ${sq(`Authorization: Bearer ${o.token}`)} ${sq(url)} -o /root/avro-setup.sh; then`,
    '    exec bash /root/avro-setup.sh > /var/log/avro-setup.log 2>&1',
    '  fi',
    '  sleep 15',
    'done',
    '',
  ].join('\n')
}

export type AgentFile = { path: string; mode: number; content: Buffer }

/**
 * The setup the VM fetches: the agent files (clubctl, compose files, the
 * setup script), then setup-clubs-vm.sh with the deployer's key, then the
 * VM's host key sent back so the deployer knows it's talking to this machine.
 * Lines starting "==> " are passed on as progress.
 */
export function setupScript(o: {
  deployerUrl: string; jobId: number; token: string; files: AgentFile[]
  deployerPublicKey: string; acmeEmail: string; ghcrUser: string; ghcrToken: string
}): string {
  const base = `${o.deployerUrl.replace(/\/+$/, '')}/api/provision/${o.jobId}`
  const auth = sq(`Authorization: Bearer ${o.token}`)
  const lines = [
    '#!/usr/bin/env bash',
    '# Written by the deployer for one new server. Runs once, as root.',
    'set -uo pipefail',
    'export DEBIAN_FRONTEND=noninteractive',
    `post() { curl -fsS -m 30 --retry 3 -X POST -H ${auth} -H 'Content-Type: text/plain' --data-binary "$2" ${sq(base)}/"$1" >/dev/null || true; }`,
    'say() { echo "$1"; post progress "$1"; }',
    '# bash keeps reading this file through its open handle, so it can go now (it holds the package token).',
    'rm -f /root/avro-setup.sh',
    'say "==> The server is up and running the setup"',
    '# Ubuntu\'s first-boot updates hold the package lock for a while.',
    'for i in $(seq 1 90); do fuser /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock >/dev/null 2>&1 || break; sleep 5; done',
    'work=$(mktemp -d)',
  ]
  for (const f of o.files) {
    if (!/^[A-Za-z0-9._/-]+$/.test(f.path) || f.path.includes('..')) throw new Error(`Unsafe agent file name: ${f.path}`)
    lines.push(`mkdir -p "$work/$(dirname ${sq(f.path)})"`)
    lines.push(`base64 -d > "$work/"${sq(f.path)} <<'AVRO_B64'`, ...(f.content.toString('base64').match(/.{1,76}/g) ?? []), 'AVRO_B64')
    lines.push(`chmod ${(f.mode & 0o777).toString(8)} "$work/"${sq(f.path)}`)
  }
  lines.push(
    'cd "$work"',
    `export DEPLOYER_PUBLIC_KEY=${sq(o.deployerPublicKey)} ACME_EMAIL=${sq(o.acmeEmail)} GHCR_USER=${sq(o.ghcrUser)} GHCR_TOKEN=${sq(o.ghcrToken)}`,
    'bash ./setup-clubs-vm.sh 2>&1 | tee /var/log/avro-setup-clubs.log | while IFS= read -r line; do',
    '  echo "$line"',
    '  case "$line" in "==> "*) post progress "$line" ;; esac',
    'done',
    'rc=${PIPESTATUS[0]}',
    'unset GHCR_TOKEN',
    'if [ "$rc" -ne 0 ]; then',
    '  rm -rf "$work"',
    '  post done "failed',
    '$(tail -n 40 /var/log/avro-setup-clubs.log)"',
    '  exit 1',
    'fi',
    'post done "ok',
    '$(cut -d" " -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"',
    'rm -rf "$work"',
    '',
  )
  return lines.join('\n')
}

/** A host key line the VM sent back ("ssh-ed25519 AAAA…"), or null when it isn't one. */
export function parseHostKey(text: string): string | null {
  const m = text.trim().match(/^(ssh-ed25519) (AAAA[A-Za-z0-9+/]+={0,2})$/)
  return m ? `${m[1]} ${m[2]}` : null
}

/** The VM's "done" message: "ok\n<host key>" or "failed\n<last lines>". */
export function parseDone(body: string): { ok: true; hostKey: string } | { ok: false; error: string } {
  const [first, ...rest] = body.replace(/\r/g, '').split('\n')
  const tail = rest.join('\n').trim()
  if (first.trim() === 'ok') {
    const hostKey = parseHostKey(tail)
    return hostKey ? { ok: true, hostKey } : { ok: false, error: 'The server finished but sent no usable host key.' }
  }
  return { ok: false, error: `The setup on the server failed:\n${tail.slice(-4000) || '(no output)'}` }
}

/** The snapshot kept when a server is deleted: "<vm>-final-20261124". */
export const finalSnapshotName = (lightsailName: string, at: Date) => `${lightsailName}-final-${at.toISOString().slice(0, 10).replace(/-/g, '')}`
export const SNAPSHOT_KEEP_DAYS = 14
export const staticIpNameFor = (lightsailName: string) => `${lightsailName.replace(/^avro-/, 'avro-ip-')}`
/** Minutes a new VM has to report back before the job is called failed. */
export const BOOT_MINUTES = 30
