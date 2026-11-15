import type { Automatic } from '../types'

export type QueueRow = NonNullable<Automatic['pending']>[number]
export type QueueEdit = { rows: QueueRow[]; text: string; dropped: string[] }

export const QUEUE_USAGE = 'Usage: /queue, /queue rm <n>, /queue edit <n> <text>, /before <task>'
const QUEUE_LIMIT = 32

export function listQueue(rows: readonly QueueRow[]): string {
  return rows.length === 0 ? 'Queue is empty.' : rows.map((row, i) => `${i + 1}. ${row.task}`).join('\n')
}

export function queueCommand(rows: readonly QueueRow[], args: string, editTurn: string, listed: readonly QueueRow[] = rows): QueueEdit | string {
  const trimmed = args.trim()
  if (trimmed === '') return listQueue(rows)
  const match = trimmed.match(/^(rm|edit)\s+(\d+)(?:\s+([\s\S]+))?$/)
  if (match === null) return QUEUE_USAGE
  const n = Number(match[2])
  const text = match[3]?.trim() ?? ''
  if (match[1] === 'edit' && text === '') return QUEUE_USAGE
  const target = listed[n - 1]
  if (target === undefined) return `No item ${n}; the queue has ${listed.length}.`
  if (!rows.some(row => row.turn === target.turn)) return `Item ${n} (${target.task}) is no longer queued; run /queue for the current list.`
  if (match[1] === 'rm') {
    return { rows: rows.filter(row => row.turn !== target.turn), text: `Removed ${n}. ${target.task}`, dropped: [target.turn] }
  }
  return {
    rows: rows.map(row => (row.turn === target.turn ? { ...row, turn: editTurn, task: text } : row)),
    text: `Edited ${n}. ${text}`,
    dropped: [target.turn],
  }
}

export function beforeCommand(rows: readonly QueueRow[], row: QueueRow, isActive: boolean): QueueEdit | string {
  if (row.task === '') return QUEUE_USAGE
  if (!isActive) return 'Nothing is running, so nothing is queued; send the task as a normal prompt.'
  if (rows.length >= QUEUE_LIMIT) return 'Herdr-Jev request queue is full; remove an item with /queue rm <n> first.'
  return { rows: [row, ...rows], text: `Queued first: ${row.task}`, dropped: [] }
}
