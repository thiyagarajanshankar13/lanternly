import { db } from './db'
import { decrypt, encrypt } from './crypto'

// Platform settings an admin edits on /admin/settings. Secret ones are
// stored encrypted and never sent back to the browser.
export type PlatformSettings = {
  /** Name shown in the side menu, on the sign-in page and in the authenticator app. */
  brandName: string
  /** Small line under the name, and the end of every page title (empty = the name). */
  brandTagline: string
  /** Logo address (https://… or /path); empty = the built-in mark. */
  brandLogoUrl: string
  /** How dates and numbers are written (a BCP 47 tag such as en-US, en-GB, en-AU). */
  locale: string
  /** Plugins that are on, separated by spaces (see src/plugins). Empty = none. */
  plugins: string
  /** Names new services can't take, on top of the built-in list (space or comma separated). */
  extraReservedNames: string
  /** The domain services live under (<name>.<baseDomain>); empty until set in Settings. */
  baseDomain: string
  defaultImage: string
  defaultMemoryMb: number
  defaultTimezone: string
  smtpHost: string
  smtpPort: string
  smtpUser: string
  smtpPass: string
  smtpFromAddress: string
  indexing: boolean
  /** AI assistant on for every site (each site can also be switched off). */
  assistEnabled: boolean
  /** Requests per site per day, all features together. */
  assistDailyLimit: number
  /** Who gets monitoring alerts (comma separated). Empty = every admin. */
  alertEmails: string
  /** Minutes between checks of each watched site. */
  monitorMinutes: number
  /** Off-site backups: the Lightsail bucket and an access key for it. */
  backupBucket: string
  backupRegion: string
  backupAccessKeyId: string
  backupSecretAccessKey: string
  /** Only for testing against another S3-compatible store. */
  backupEndpoint: string
  /** 64 hex characters; everything in the bucket is encrypted with it. */
  backupKey: string
  /** The admin has seen and stored the backup key. */
  backupKeySaved: boolean
  /** Also keep each app version (image) a backup needs in the bucket. */
  backupSaveImages: boolean
  /** Schedule given to new sites. */
  backupDefaultFrequentHours: number
  backupDefaultFrequentKeepDays: number
  backupDefaultDaily: boolean
  backupDefaultDailyHour: number
  backupDefaultDailyKeepDays: number
  /** Days a removed site's backups are kept. */
  backupRemovedKeepDays: number
  /** Apps: the GitHub App that reads repos, starts builds and sends push notices. */
  githubAppId: string
  githubPrivateKey: string
  githubWebhookSecret: string
  /** The only GitHub organisation (or user) whose repos can be deployed. */
  githubOwner: string
  /** owner/name of the repo holding the build workflow (this deployer's repo). App images
   *  are ghcr.io/<its owner>/app-<site name>:<commit>. */
  githubBuildRepo: string
  /** The GitHub App's address name (github.com/apps/<slug>) and display name, when known. */
  githubAppSlug: string
  githubAppName: string
  /** A GitHub App made with "Create GitHub app" that isn't installed yet (JSON, encrypted). */
  githubPendingApp: string
  /** The one-time check for the trip to GitHub and back: "<state> <expires ms> <owner> <build repo>". */
  githubSetupState: string
  /** "<app id> <build repo>" once the deployer saved that app's ID and key as the build repo's Actions secrets. */
  githubBuildSecretsFor: string
  /** Memory limit given to new apps (MB). */
  appDefaultMemoryMb: number
  /** Costs: a read-only AWS key for Cost Explorer, Lightsail plans and the AWS budget. */
  costAccessKeyId: string
  costSecretAccessKey: string
  /** Where the Lightsail VMs and bucket are. */
  costRegion: string
  /** The currency costs are shown in (AWS plugin): a code from plugins/aws/money.ts. US$ = no conversion. */
  costCurrency: string
  /** Monthly budget in that currency (0 = none). */
  costBudget: number
  /** Units of that currency per US$, typed by an admin (0 = the day's rate, fetched once a day). */
  costRate: number
  /** Promotional credits left (US$, from AWS Billing > Credits), the day it was typed, and when they expire. */
  costCreditsUsd: number
  costCreditsAsOf: string
  costCreditsExpire: string
  /** Internal: which cost alerts already went out (JSON). */
  costAlertState: string
  /** Creating servers: an AWS key that may make and delete tagged Lightsail VMs (not the costs key). */
  provisionAccessKeyId: string
  provisionSecretAccessKey: string
  provisionRegion: string
  provisionZone: string
  /** The deployer VM's public IP: the only address let in on SSH (port 22) of a new server. */
  provisionDeployerIp: string
  /** Email for HTTPS certificate notices, and the token new servers pull private images with. */
  provisionAcmeEmail: string
  provisionGhcrUser: string
  provisionGhcrToken: string
  /** Most servers the deployer may have made (and be making) at once. */
  provisionMaxServers: number
  /** Internal: the last check for Lightsail VMs tagged as ours that the deployer doesn't know (JSON). */
  provisionCheck: string
}

// Generic defaults for a new install. An install made before these became
// settings had the Avrotech values written in by migration 13 (lib/db.ts).
const DEFAULTS: PlatformSettings = {
  brandName: 'Deployer',
  brandTagline: '',
  brandLogoUrl: '',
  locale: 'en-US',
  plugins: '',
  extraReservedNames: '',
  baseDomain: '',
  defaultImage: '',
  defaultMemoryMb: 700,
  defaultTimezone: 'UTC',
  smtpHost: '',
  smtpPort: '587',
  smtpUser: '',
  smtpPass: '',
  smtpFromAddress: '',
  indexing: true,
  assistEnabled: true,
  assistDailyLimit: 100,
  alertEmails: '',
  monitorMinutes: 5,
  backupBucket: '',
  backupRegion: 'us-east-1',
  backupAccessKeyId: '',
  backupSecretAccessKey: '',
  backupEndpoint: '',
  backupKey: '',
  backupKeySaved: false,
  backupSaveImages: true,
  backupDefaultFrequentHours: 0,
  backupDefaultFrequentKeepDays: 2,
  backupDefaultDaily: true,
  backupDefaultDailyHour: 2,
  backupDefaultDailyKeepDays: 30,
  backupRemovedKeepDays: 30,
  githubAppId: '',
  githubPrivateKey: '',
  githubWebhookSecret: '',
  githubOwner: '',
  githubBuildRepo: '',
  githubAppSlug: '',
  githubAppName: '',
  githubPendingApp: '',
  githubSetupState: '',
  githubBuildSecretsFor: '',
  appDefaultMemoryMb: 256,
  costAccessKeyId: '',
  costSecretAccessKey: '',
  costRegion: 'us-east-1',
  costCurrency: 'USD',
  costBudget: 0,
  costRate: 0,
  costCreditsUsd: 0,
  costCreditsAsOf: '',
  costCreditsExpire: '',
  costAlertState: '',
  provisionAccessKeyId: '',
  provisionSecretAccessKey: '',
  provisionRegion: 'us-east-1',
  provisionZone: 'us-east-1a',
  provisionDeployerIp: '',
  provisionAcmeEmail: '',
  provisionGhcrUser: '',
  provisionGhcrToken: '',
  provisionMaxServers: 5,
  provisionCheck: '',
}
export const SETTINGS_DEFAULTS: Readonly<PlatformSettings> = DEFAULTS
const SECRET_KEYS = new Set<keyof PlatformSettings>(['smtpPass', 'backupSecretAccessKey', 'backupKey', 'githubPrivateKey', 'githubWebhookSecret', 'githubPendingApp', 'costSecretAccessKey', 'provisionSecretAccessKey', 'provisionGhcrToken'])

export function getSettings(): PlatformSettings {
  const rows = db().prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  const out: Record<string, unknown> = { ...DEFAULTS }
  for (const row of rows) {
    if (!(row.key in DEFAULTS)) continue
    const key = row.key as keyof PlatformSettings
    let value = row.value
    if (SECRET_KEYS.has(key) && value) {
      try { value = decrypt(value) } catch { value = '' }
    }
    const def = DEFAULTS[key]
    out[key] = typeof def === 'number' ? (key.startsWith('backup') || key.startsWith('cost') ? (value !== '' && Number.isFinite(Number(value)) ? Number(value) : def) : Number(value) || def) : typeof def === 'boolean' ? value === 'true' : value
  }
  return out as PlatformSettings
}

export function saveSettings(patch: Partial<PlatformSettings>) {
  const stmt = db().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  db().transaction(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULTS) || v === undefined) continue
      const key = k as keyof PlatformSettings
      let value = String(v)
      if (SECRET_KEYS.has(key) && value) value = encrypt(value)
      stmt.run(key, value)
    }
  })()
}

/** The extra reserved names from Settings, lowercased. */
export function extraReservedNames(): Set<string> {
  return new Set(getSettings().extraReservedNames.toLowerCase().split(/[\s,]+/).filter(Boolean))
}

/** A locale Intl accepts: the setting, or en-US when it isn't one. */
export function displayLocale(): string {
  const want = getSettings().locale || 'en-US'
  try { return Intl.DateTimeFormat.supportedLocalesOf([want]).length ? want : 'en-US' } catch { return 'en-US' }
}

/** The deployer's name as people know it: "Deployer (Avrosphere by Avrotech)" when it has a line under the name. */
export function deployerTitle(s: Pick<PlatformSettings, 'brandName' | 'brandTagline'> = getSettings()): string {
  return s.brandTagline ? `${s.brandName} (${s.brandTagline})` : s.brandName
}
