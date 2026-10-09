import type { ModelInfo, Sport } from '@edgelab/shared/src/types'
import type { OriginFilter } from './origin'

// サンプルモデルは version を 'sample-' で始める規約（db/seed/generate.mjs）
export const isSampleModel = (m: ModelInfo) => m.version.startsWith('sample-')

const rank = { active: 0, candidate: 1, retired: 2, untrained: 3 } as const

/** 表示中のデータ出所に対応する代表モデル（稼働中 > 昇格候補 > 退役）。 */
export function representativeModel(models: ModelInfo[], sport: Sport, origin: OriginFilter): ModelInfo | null {
  const pool = models
    .filter((m) => m.sport === sport && m.status !== 'untrained')
    .filter((m) => origin === 'all' || (origin === 'sample') === isSampleModel(m))
    .sort((a, b) => rank[a.status] - rank[b.status] || (b.trainedAt ?? '').localeCompare(a.trainedAt ?? ''))
  return pool[0] ?? null
}
