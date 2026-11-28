'use server'

import crypto from 'node:crypto'
import { redirect } from 'next/navigation'
import {
  acceptInvite, adminCount, checkCode, checkPassword, clientIp, createAdmin, currentAdmin, endSession, findInvite, passwordError, pendingAdmin,
  recordAttempt, startSession, tooManyAttempts,
} from '@/lib/auth'
import { homePage } from '@/lib/access'
import { audit } from '@/lib/audit'
import { isEmail } from '@/lib/validate'

export type FormState = { error?: string } | undefined

export async function loginAction(_prev: FormState, form: FormData): Promise<FormState> {
  const email = String(form.get('email') || '').trim().toLowerCase()
  const password = String(form.get('password') || '')
  const ip = await clientIp()
  if (tooManyAttempts(`ip:${ip}`, 20) || tooManyAttempts(`email:${email}`)) {
    return { error: 'Too many attempts. Wait 15 minutes and try again.' }
  }
  const adminId = checkPassword(email, password)
  if (!adminId) {
    recordAttempt(`ip:${ip}`)
    recordAttempt(`email:${email}`)
    await audit(null, 'sign-in-failed', { email: email.slice(0, 200) })
    return { error: "That email and password don't match." }
  }
  await startSession(adminId, false)
  redirect('/admin/login/code')
}

export async function codeAction(_prev: FormState, form: FormData): Promise<FormState> {
  const admin = await pendingAdmin()
  if (!admin) redirect('/admin/login')
  const key = `code:${admin.id}`
  if (tooManyAttempts(key)) return { error: 'Too many attempts. Wait 15 minutes and try again.' }
  if (!checkCode(admin.id, String(form.get('code') || ''))) {
    recordAttempt(key)
    await audit(admin, 'code-failed')
    return { error: "That code isn't right. Codes change every 30 seconds." }
  }
  await startSession(admin.id, true)
  await audit(admin, 'sign-in')
  redirect(homePage(admin))
}

export async function setupAction(_prev: FormState, form: FormData): Promise<FormState> {
  if (adminCount() > 0) redirect('/admin/login')
  const want = (process.env.DEPLOYER_SETUP_TOKEN || '').trim()
  const got = String(form.get('token') || '').trim()
  const ip = await clientIp()
  if (tooManyAttempts(`setup:${ip}`)) return { error: 'Too many attempts. Wait 15 minutes and try again.' }
  if (want.length < 16) return { error: 'Set DEPLOYER_SETUP_TOKEN (16+ characters) on the server first.' }
  const a = Buffer.from(want), b = Buffer.from(got)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    recordAttempt(`setup:${ip}`)
    return { error: "That setup code isn't right." }
  }
  const email = String(form.get('email') || '').trim().toLowerCase()
  const name = String(form.get('name') || '').trim()
  const password = String(form.get('password') || '')
  if (!isEmail(email)) return { error: 'Enter a valid email address.' }
  const bad = passwordError(password)
  if (bad) return { error: bad }
  const id = createAdmin(email, name, password)
  await startSession(id, false)
  redirect('/admin/login/code')
}

export async function inviteAction(_prev: FormState, form: FormData): Promise<FormState> {
  const token = String(form.get('token') || '')
  const ip = await clientIp()
  if (tooManyAttempts(`invite:${ip}`)) return { error: 'Too many attempts. Wait 15 minutes and try again.' }
  const person = findInvite(token)
  if (!person) {
    recordAttempt(`invite:${ip}`)
    return { error: 'This invite link has expired or was already used. Ask for a new one.' }
  }
  const password = String(form.get('password') || '')
  const bad = passwordError(password)
  if (bad) return { error: bad }
  if (password !== String(form.get('password2') || '')) return { error: "The two passwords don't match." }
  const id = acceptInvite(token, password)
  if (!id) return { error: 'This invite link has expired or was already used. Ask for a new one.' }
  await endSession()
  await audit(person, 'invite-accepted')
  await startSession(id, false)
  redirect('/admin/login/code')
}

export async function logoutAction() {
  const admin = await currentAdmin()
  if (admin) await audit(admin, 'sign-out')
  await endSession()
  redirect('/admin/login')
}
