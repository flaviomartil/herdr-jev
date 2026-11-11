import { atom, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Timer } from 'claude-code'
import { snapshotActivity } from './activity'
import { cachedArt, frameFor } from './art-core'
import type { ArtSpec } from './art-core'
import { SIGNAL_VIEW } from './pane-signal'
import type { CrewState, FlowProgressState } from '../types'

export const FRAME_MS = 125
export const RECONCILE_MS = 2000
export const MISSES_TO_GONE = 2

const crewAtom = atom({ plugin: 'harness', key: 'crew' } as const, { parents: {}, gone: {}, waiting: {}, listed: [] } as CrewState)
const progressAtom = atom({ plugin: 'harness', key: 'flowProgress' } as const, null)

export const emptyCrew = (): CrewState => ({ parents: {}, gone: {}, waiting: {}, listed: [] })

export type Listed = { id: string; parentId?: string }

let crew: CrewState = emptyCrew()
let misses = new Map<string, number>()
let tick = 0
let frameTimer: Timer | null = null
let reconcileTimer: Timer | null = null
const toasted = new Set<string>()

export const crewNow = (): CrewState => crew
export const currentTick = (): number => tick

export function resetCrew(): void {
  crew = emptyCrew()
  misses = new Map()
  tick = 0
  drawn = []
  frameTimer?.cancel()
  frameTimer = null
  reconcileTimer?.cancel()
  reconcileTimer = null
  toasted.clear()
}

export const reducedMotion = (options: PluginOptions): boolean => options.reducedMotion === true

export function reconcileCrew(
  state: CrewState,
  missCounts: ReadonlyMap<string, number>,
  listed: readonly Listed[],
  tracked: readonly string[],
): { crew: CrewState; misses: Map<string, number>; newlyGone: string[] } {
  const ids = new Set(listed.map(l => l.id))
  const nextMisses = new Map<string, number>()
  const gone = { ...state.gone }
  const parents = { ...state.parents }
  const newlyGone: string[] = []
  for (const item of listed) if (item.parentId !== undefined && parents[item.id] === undefined) parents[item.id] = item.parentId
  for (const id of tracked) {
    if (ids.has(id)) {
      delete gone[id]
      continue
    }
    const count = (missCounts.get(id) ?? 0) + 1
    nextMisses.set(id, count)
    if (count >= MISSES_TO_GONE && gone[id] === undefined) {
      gone[id] = true
      newlyGone.push(id)
    }
  }
  return { crew: { ...state, parents, gone, listed: [...ids] }, misses: nextMisses, newlyGone }
}

const sameCrew = (a: CrewState, b: CrewState): boolean => JSON.stringify(a) === JSON.stringify(b)

async function publish($: EngineInterface): Promise<void> {
  const next = crew
  await update($, crewAtom, () => next).catch(() => undefined)
}

export async function setProgress($: EngineInterface, value: FlowProgressState): Promise<void> {
  await update($, progressAtom, () => value).catch(() => undefined)
}

export async function recordParent($: EngineInterface, id: string, parentId: string | undefined): Promise<void> {
  if (parentId === undefined || crew.parents[id] === parentId) return
  crew = { ...crew, parents: { ...crew.parents, [id]: parentId } }
  await publish($)
}

export async function setWaiting($: EngineInterface, id: string, waiting: boolean): Promise<void> {
  if ((crew.waiting[id] === true) === waiting) return
  const next = { ...crew.waiting }
  if (waiting) next[id] = true
  else delete next[id]
  crew = { ...crew, waiting: next }
  await publish($)
  if (waiting) $.ui.toast(SIGNAL_VIEW.waiting.toast?.(id) ?? '')
}

const trackedIds = (): string[] => Object.values(snapshotActivity()).filter(a => a.end === null).map(a => a.id)

const liveIds = (): string[] => trackedIds().filter(id => crew.gone[id] === undefined)

export async function reconcileNow($: EngineInterface): Promise<void> {
  let listed: Listed[]
  try {
    listed = (await $.agent.list()).map(a => ({ id: a.id, ...(a.parentId === undefined ? {} : { parentId: a.parentId }) }))
  } catch {
    return
  }
  const result = reconcileCrew(crew, misses, listed, trackedIds())
  misses = result.misses
  const changed = !sameCrew(crew, result.crew)
  crew = result.crew
  if (changed) await publish($)
  for (const id of result.newlyGone) {
    const key = `gone.${id}`
    if (toasted.has(key)) continue
    toasted.add(key)
    $.ui.toast(SIGNAL_VIEW.gone.toast?.(id) ?? '')
  }
}

export type DrawnArt = { key: string; spec: ArtSpec }

let drawn: DrawnArt[] = []
let drawnPane = ''

const animated = (): DrawnArt[] => drawn.filter(d => d.spec.state === 'running' && d.spec.animate === true)

export function syncFrames($: EngineInterface, options: PluginOptions, paneId: string, entries: DrawnArt[]): void {
  drawn = entries
  drawnPane = paneId
  if (reducedMotion(options) || animated().length === 0) {
    frameTimer?.cancel()
    frameTimer = null
    return
  }
  if (frameTimer !== null) return
  frameTimer = $.clock.every(FRAME_MS, () => {
    const running = animated()
    if (running.length === 0) {
      frameTimer?.cancel()
      frameTimer = null
      return
    }
    tick += 1
    for (const entry of running) {
      const art = cachedArt({ ...entry.spec, frame: frameFor(tick, false) })
      void $.ui.blit({ requestId: drawnPane, key: entry.key, cells: art.packed, columns: art.columns, rows: art.rows }).catch(() => undefined)
    }
  })
}

export function ensureCrewTimers($: EngineInterface, _options: PluginOptions): void {
  if (reconcileTimer !== null) return
  reconcileTimer = $.clock.every(RECONCILE_MS, () => {
    if (liveIds().length === 0) {
      reconcileTimer?.cancel()
      reconcileTimer = null
      return
    }
    void reconcileNow($)
  })
}
