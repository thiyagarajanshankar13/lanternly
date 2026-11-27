// Images from Docker Hub (and other registries) as people paste them: nginx,
// nginx:1.27, bitnami/redis:7.4, ghcr.io/owner/app:v2, image@sha256:…, or a
// hub.docker.com page link. Pure, so it is easy to test.

export type ImageRef = {
  /** What clubctl pulls: registry/path:tag or registry/path@sha256:… (always with a registry). */
  ref: string
  /** Short form for screens: nginx:1.27, bitnami/redis:7.4, ghcr.io/owner/app:v2. */
  display: string
  /** docker.io, ghcr.io… (where to sign in for a private image). */
  registry: string
  /** A digest, or a tag other than "latest": the same image every time. */
  pinned: boolean
}

const PATH_PART = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/
const DIGEST = /^sha256:[a-f0-9]{64}$/
const HOST = /^(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d{1,5})?$/

/** A hub.docker.com page link turned into name[:tag], or null when it isn't one. */
function fromHubUrl(input: string): string | null {
  let url: URL
  try { url = new URL(input) } catch { return null }
  if (!/^(www\.)?hub\.docker\.com$/i.test(url.hostname)) return null
  const parts = url.pathname.split('/').filter(Boolean)
  let name = ''
  let tag = url.searchParams.get('name') || url.searchParams.get('tag') || ''
  if (parts[0] === '_' && parts[1]) name = parts[1]
  else if (parts[0] === 'r' && parts[1] && parts[2]) name = `${parts[1]}/${parts[2]}`
  else if (parts[0] === 'layers' && parts.length >= 4) {
    // /layers/library/nginx/1.27/images/sha256-… or /layers/user/app/tag/…
    name = parts[1] === 'library' ? parts[2] : `${parts[1]}/${parts[2]}`
    tag = tag || parts[3]
  } else return ''
  return tag ? `${name}:${tag}` : name
}

export function parseImageRef(raw: string): ImageRef | { error: string } {
  let input = raw.trim().replace(/^docker\s+pull\s+/i, '').trim()
  if (!input) return { error: 'Enter an image, like nginx:1.27 or a hub.docker.com link.' }
  if (/^https?:\/\//i.test(input)) {
    const fromUrl = fromHubUrl(input)
    if (fromUrl === null) return { error: "That link isn't an image. Paste a hub.docker.com page link or a name like nginx:1.27." }
    if (!fromUrl) return { error: 'Open the image\'s own page on Docker Hub and paste that link (it looks like hub.docker.com/_/nginx or hub.docker.com/r/owner/name).' }
    input = fromUrl
  }
  if (input.length > 255 || /\s/.test(input)) return { error: "That isn't an image name." }

  let digest = ''
  const at = input.indexOf('@')
  if (at >= 0) { digest = input.slice(at + 1); input = input.slice(0, at); if (!DIGEST.test(digest)) return { error: 'A digest looks like @sha256: followed by 64 letters and digits.' } }
  let tag = ''
  const colon = input.lastIndexOf(':')
  if (colon > input.lastIndexOf('/')) { tag = input.slice(colon + 1); input = input.slice(0, colon); if (!TAG.test(tag)) return { error: `"${tag}" isn't a valid tag.` } }

  const parts = input.split('/')
  let registry = 'docker.io'
  if (parts.length > 1 && (parts[0].includes('.') || parts[0].includes(':') || parts[0] === 'localhost')) registry = parts.shift()!.toLowerCase()
  if (!HOST.test(registry)) return { error: `"${registry}" isn't a registry address.` }
  if (registry === 'index.docker.io' || registry === 'registry-1.docker.io') registry = 'docker.io'
  const path = parts.map((p) => p.toLowerCase())
  if (!path.length || path.some((p) => !PATH_PART.test(p))) return { error: 'Image names use lowercase letters, digits and . _ - between slashes, like owner/name.' }
  if (registry === 'docker.io' && path.length === 1) path.unshift('library')

  const suffix = digest ? `@${digest}` : `:${tag || 'latest'}`
  const ref = `${registry}/${path.join('/')}${suffix}`
  const shortPath = registry === 'docker.io' ? (path[0] === 'library' ? path.slice(1) : path).join('/') : `${registry}/${path.join('/')}`
  return { ref, display: `${shortPath}${suffix}`, registry, pinned: !!digest || (!!tag && tag !== 'latest') }
}

/** The short form of a stored ref, for screens. */
export function imageDisplay(ref: string): string {
  const parsed = parseImageRef(ref)
  return 'error' in parsed ? ref : parsed.display
}

/** A Docker Hub (or other registry) user name: no spaces or line breaks. */
export function registryUserError(user: string): string | null {
  return /^[A-Za-z0-9._@+-]{1,100}$/.test(user) ? null : 'The registry user name may only hold letters, digits and . _ @ + -'
}
