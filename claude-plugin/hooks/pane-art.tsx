import type { ArtSpec } from './art-core'
import { cachedArt, frameFor } from './art-core'
import type { Avatar } from './identity-core'
import { avatarRuns } from './identity-core'

export type ArtKit = { Box: any; Text: any; Raster?: any; Svg?: any }

export type ArtRequest = ArtSpec & { key: string; tick: number; reducedMotion: boolean; fallback: Avatar }

export const ART_COLUMNS = 7
export const ART_ROWS = 5

export function artFrame(request: ArtRequest): ArtSpec {
  const { kind, state, role, lead, ageMs, animate } = request
  const frame = state === 'running' ? frameFor(request.tick, request.reducedMotion) : 0
  return { kind, state, role, lead, ageMs, animate, frame }
}

export function Art(kit: ArtKit, request: ArtRequest) {
  const { Box, Text, Raster, Svg } = kit
  const spec = artFrame(request)
  const alt = `${spec.kind} agent, ${spec.state}`
  if (Raster !== undefined) {
    const art = cachedArt(spec)
    return <Raster key={request.key} columns={art.columns} rows={art.rows} cells={art.packed} />
  }
  if (Svg !== undefined) {
    return <Svg key={request.key} source={cachedArt(spec).svg} alt={alt} width={56} height={40} />
  }
  return (
    <Box key={request.key} flexDirection="column" width={6} flexShrink={0}>
      {avatarRuns(request.fallback).map((row, y) => (
        <Box key={`${request.key}-${y}`} flexDirection="row">
          {row.map((run, x) => (
            <Text key={`${request.key}-${y}-${x}`} color={run.fg} backgroundColor={run.bg}>
              {run.text}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  )
}

export const artWidth = (kit: ArtKit): number => (kit.Raster !== undefined ? ART_COLUMNS : kit.Svg !== undefined ? 8 : 6)
