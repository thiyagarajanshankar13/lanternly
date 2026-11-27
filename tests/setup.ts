import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resetDbForTests } from '@/lib/db'

/** A fresh database and key for each test file. */
export function freshEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployer-test-'))
  process.env.DEPLOYER_DATA_DIR = dir
  process.env.DEPLOYER_SECRET_KEY = 'ab'.repeat(32)
  process.env.DEPLOYER_FAKE_ENGINE = '1'
  delete process.env.DEPLOYER_FAKE_ENGINE_DELAY
  resetDbForTests()
  return dir
}
