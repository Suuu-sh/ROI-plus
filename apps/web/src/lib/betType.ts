import type { BetType } from '@edgelab/shared/src/types'

export const betTypeLabel: Record<BetType, string> = { win: '単勝', place: '複勝', quinella: '2連複/馬連', exacta: '2連単/馬単', wide: '拡連複/ワイド', trio: '3連複', trifecta: '3連単' }
