import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions } from 'claude-code'
import { classifyCommand } from './claims'

export type TurnTally = { files: string[]; passed: number; failed: number; commits: number; delegated: number }

const cardAtom = atom({ plugin: 'harness', key: 'turnCard' } as const, null)
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const COMMIT = /(^|[\s;&|(])git\s+(?:-C\s+\S+\s+)?commit(\s|$)/

export const emptyTally = (): TurnTally => ({ files: [], passed: 0, failed: 0, commits: 0, delegated: 0 })

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

export function cardText(tally: TurnTally): string | null {
  const parts: string[] = []
  if (tally.files.length > 0) parts.push(plural(tally.files.length, 'arquivo', 'arquivos'))
  if (tally.passed + tally.failed > 0) parts.push(`testes ✓${tally.passed} ✗${tally.failed}`)
  if (tally.commits > 0) parts.push(plural(tally.commits, 'commit', 'commits'))
  if (tally.delegated > 0) parts.push(plural(tally.delegated, 'delegado', 'delegados'))
  return parts.length === 0 ? null : ['turno', ...parts].join(' · ')
}

export function tallyCall(tally: TurnTally, tool: string, input: Record<string, unknown>, ran: { isError?: boolean; result?: unknown }): TurnTally {
  if (EDIT_TOOLS.has(tool)) {
    const path = String(input.file_path ?? input.notebook_path ?? '')
    return ran.isError === true || path === '' || tally.files.includes(path) ? tally : { ...tally, files: [...tally.files, path] }
  }
  if (tool !== 'Bash') return tally
  const command = String(input.command ?? '')
  const result = typeof ran.result === 'object' && ran.result !== null ? (ran.result as { interrupted?: unknown }) : {}
  const isOk = ran.isError !== true && result.interrupted !== true
  const isTest = classifyCommand(command).includes('test')
  return {
    ...tally,
    passed: tally.passed + (isTest && isOk ? 1 : 0),
    failed: tally.failed + (isTest && !isOk ? 1 : 0),
    commits: tally.commits + (isOk && COMMIT.test(command) ? 1 : 0),
  }
}

let tally = emptyTally()

export const resetTurnCard = (): void => {
  tally = emptyTally()
}

export const noteTurnCall = (tool: string, input: Record<string, unknown>, ran: { isError?: boolean; result?: unknown }): void => {
  tally = tallyCall(tally, tool, input, ran)
}

export const noteTurnSpawn = (): void => {
  tally = { ...tally, delegated: tally.delegated + 1 }
}

export async function hideTurnCard($: EngineInterface): Promise<void> {
  if ((await read($, cardAtom)) !== null) await update($, cardAtom, () => null)
}

export async function showTurnCard($: EngineInterface, options: PluginOptions): Promise<void> {
  if (options.turnCard === false) return
  const text = cardText(tally)
  await update($, cardAtom, () => text)
}

export function registerTurnCard(on: On): void {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rendered = await next(e)
    const text = await read($, cardAtom)
    if (text === null || e.props.hasSurvey) return rendered
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box key="turn-card-band" flexDirection="column">
        {rendered}
        <Box key="turn-card" marginX={1}>
          <Text dimColor wrap="truncate-end">{text}</Text>
        </Box>
      </Box>
    )
  }).catch(($, e, next) => next(e))
}
