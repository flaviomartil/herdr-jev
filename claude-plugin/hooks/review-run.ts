export type ReviewRecord = { client: string; session: string; cwd: string; status: string }

export type StoredReview = { client: string; session: string; at: number; status: string | null }

export type ReviewIds = Record<string, StoredReview>

export const STATUS_PATTERN = /^[a-z_]{1,40}$/
export const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
export const CLIENT_PATTERN = /^[a-z][a-z0-9_-]{0,30}$/

export const reviewIdsKey = (sessionId: string): string => `reviewIds:${sessionId}`

function accept(client: unknown, session: unknown, cwd: unknown, status: unknown): ReviewRecord | null {
  if (typeof client !== 'string' || !CLIENT_PATTERN.test(client)) return null
  if (typeof session !== 'string' || !TOKEN_PATTERN.test(session)) return null
  if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.length > 1024 || /[\u0000-\u001f\u007f]/.test(cwd)) return null
  if (typeof status !== 'string' || !STATUS_PATTERN.test(status)) return null
  return { client, session, cwd, status }
}

export function parseReviewText(output: string): ReviewRecord | null {
  const header = /^Review session (\S+) \((\S+)\) in (\/[^\n]*?)[ \t]*$/m.exec(output)
  if (header === null) return null
  let status: string | null = null
  for (const match of output.matchAll(/^Status: ([a-z_]+)(?: \(.*\))?[ \t]*$/gm)) status = match[1] ?? null
  return accept(header[2], header[1], header[3], status)
}

export function parseReviewJson(output: string): ReviewRecord | null {
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let raw: unknown
  try {
    raw = JSON.parse(output.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  return accept(record.client, record.session, record.cwd, record.status)
}

export function parseReviewRun(output: string, json: boolean): ReviewRecord | null {
  return json ? parseReviewJson(output) : parseReviewText(output)
}

export function mergeReviewIds(ids: ReviewIds, cwd: string, entry: StoredReview): ReviewIds {
  return { ...ids, [cwd]: entry }
}

export function parseReviewIds(value: unknown): ReviewIds {
  const out: ReviewIds = {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out
  for (const [cwd, one] of Object.entries(value as Record<string, unknown>)) {
    if (typeof one !== 'object' || one === null) continue
    const entry = one as Record<string, unknown>
    if (typeof entry.client !== 'string' || typeof entry.session !== 'string' || typeof entry.at !== 'number') continue
    const status = typeof entry.status === 'string' ? entry.status : null
    out[cwd] = { client: entry.client, session: entry.session, at: entry.at, status }
  }
  return out
}
