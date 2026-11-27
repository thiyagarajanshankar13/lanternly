import { maskSecrets, secretValues } from './access'
import type { Club } from './clubs'

/** A site's run log or deploy output as it may be shown: its secrets blanked out. */
export function maskedLog(text: string, club: Pick<Club, 'secrets' | 'extraEnv'> | null | undefined): string {
  return maskSecrets(text, club ? secretValues(club) : [])
}
