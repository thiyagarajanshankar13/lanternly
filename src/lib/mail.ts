import nodemailer from 'nodemailer'
import { getSettings } from './settings'

// The deployer's own emails (monitoring alerts). Uses the outgoing email
// account from Settings, the same one sites send through.

export function mailReady(): boolean {
  return !!getSettings().smtpHost
}

/** Sends a plain-text email. Returns null when sent, else why it wasn't. */
export async function sendMail(to: string[], subject: string, text: string): Promise<string | null> {
  const s = getSettings()
  if (!s.smtpHost) return 'Outgoing email is not set up (Settings).'
  if (!to.length) return 'Nobody to send to.'
  const port = Number(s.smtpPort) || 587
  try {
    const transport = nodemailer.createTransport({
      host: s.smtpHost, port, secure: port === 465,
      auth: s.smtpUser ? { user: s.smtpUser, pass: s.smtpPass } : undefined,
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 20_000,
    })
    await transport.sendMail({ from: `"${s.brandName}" <${s.smtpFromAddress || `no-reply@${s.baseDomain}`}>`, to: to.join(', '), subject, text })
    return null
  } catch (err) {
    return (err as Error).message || 'The email could not be sent.'
  }
}
