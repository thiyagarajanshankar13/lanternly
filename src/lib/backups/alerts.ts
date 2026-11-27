import { updateClub, type Club } from '../clubs'
import { mailReady, sendMail } from '../mail'
import { alertRecipients } from '../monitor'

// Emails about backups go to the same people as Monitoring's alerts.

type Sender = (subject: string, text: string) => Promise<void> | void
const g = globalThis as unknown as { __backupSender?: Sender }

export function setBackupAlertSenderForTests(sender: Sender | undefined) { g.__backupSender = sender }

export async function alert(subject: string, text: string) {
  if (g.__backupSender) return g.__backupSender(subject, text)
  if (!mailReady()) return
  const error = await sendMail(alertRecipients(), subject, text)
  if (error) console.error(`[backups] alert not sent: ${error}`)
}

/** Called when a backup finishes, good or bad: emails on the first failure and when it works again. */
export async function backupFinished(club: Club, ok: boolean, error = '') {
  if (!ok && club.backupAlert !== 'failed') {
    updateClub(club.id, { backupAlert: 'failed' })
    await alert(`Backup failed: ${club.displayName}`,
      `The backup of ${club.displayName} (${club.name}) to the bucket failed.\n\nWhat went wrong: ${error}\n\nIt will be tried again on its schedule. The deployer's Backups page shows every site's last good backup. You'll get another email when backups work again.`)
  } else if (ok && club.backupAlert) {
    updateClub(club.id, { backupAlert: '' })
    await alert(`Backups working again: ${club.displayName}`, `${club.displayName} (${club.name}) backed up to the bucket again.`)
  }
}

