export interface ParentSessionTitleResolver {
  getTitle(sessionID: string): Promise<string | undefined>
}

interface CachedTitle {
  title?: string
  expiresAt: number
}

const TITLE_CACHE_TTL_MS = 5 * 60 * 1000

let resolver: ParentSessionTitleResolver | null = null
let resolverGeneration = 0
const cache = new Map<string, CachedTitle>()

/** Install the host-backed title lookup and discard titles from the old host. */
export function setParentSessionTitleResolver(next: ParentSessionTitleResolver | null): void {
  resolver = next
  resolverGeneration += 1
  cache.clear()
}

/**
 * Resolve readable OpenCode session titles for sidebar grouping.
 *
 * Parent sessions can disappear while their PTY transcripts remain archived, so
 * failures deliberately resolve to an omitted title and the UI falls back to the
 * session id. Positive and negative results are cached briefly because the list
 * endpoint is refreshed on focus and activity.
 */
export async function resolveParentSessionTitles(
  sessionIDs: readonly string[]
): Promise<Record<string, string>> {
  const activeResolver = resolver
  if (!activeResolver) return {}

  const generation = resolverGeneration
  const now = Date.now()
  const uniqueIDs = [...new Set(sessionIDs.map((id) => id.trim()).filter(Boolean))]
  const titles: Record<string, string> = {}
  const pending: string[] = []

  for (const id of uniqueIDs) {
    const cached = cache.get(id)
    if (cached && cached.expiresAt > now) {
      if (cached.title) titles[id] = cached.title
      continue
    }
    pending.push(id)
  }

  await Promise.all(
    pending.map(async (id) => {
      let title: string | undefined
      try {
        title = (await activeResolver.getTitle(id))?.trim() || undefined
      } catch {
        // Archived PTYs can outlive their parent OpenCode session. Keep the
        // result absent and let the caller show the stable session id instead.
      }
      if (generation !== resolverGeneration) return
      if (title) titles[id] = title
      cache.set(id, {
        ...(title === undefined ? {} : { title }),
        expiresAt: now + TITLE_CACHE_TTL_MS,
      })
    })
  )

  return generation === resolverGeneration ? titles : {}
}
