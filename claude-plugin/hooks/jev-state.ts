import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { DelegationRow } from '../types'

export const ROSTER_KEY = 'jev.roster'
const ROSTER_CAP = 500

export const delegationsAtom = atom({ plugin: 'harness', key: 'delegations' } as const, [], { shape: 'delegations-1' })
export const rosterIdsAtom = atom({ plugin: 'harness', key: 'rosterIds' } as const, {}, { shape: 'roster-1' })

export async function publishDelegations($: EngineInterface, rows: DelegationRow[]): Promise<void> {
  await update($, delegationsAtom, () => rows)
  await noteAgents($, rows.map(row => row.id))
}

export async function noteAgents($: EngineInterface, ids: string[]): Promise<void> {
  const held = await read($, rosterIdsAtom)
  let known: Record<string, number> = held
  if (Object.keys(held).length === 0) {
    try {
      const stored = await $.store.get(ROSTER_KEY)
      if (typeof stored === 'object' && stored !== null && !Array.isArray(stored)) {
        known = Object.fromEntries(Object.entries(stored).filter(([, v]) => typeof v === 'number')) as Record<string, number>
      }
    } catch {
      known = held
    }
  }
  const fresh = ids.filter((id, i) => known[id] === undefined && ids.indexOf(id) === i)
  if (fresh.length === 0 && known === held) return
  let next = Math.max(-1, ...Object.values(known)) + 1
  const merged: Record<string, number> = { ...known }
  for (const id of fresh) merged[id] = next++
  const kept = Object.entries(merged).sort((a, b) => b[1] - a[1]).slice(0, ROSTER_CAP)
  const out = Object.fromEntries(kept)
  await update($, rosterIdsAtom, () => out)
  try {
    await $.store.set(ROSTER_KEY, out)
  } catch {
    return
  }
}
