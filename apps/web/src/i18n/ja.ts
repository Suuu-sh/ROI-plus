export const ja = {
  app: 'ROI+',
  tagline: 'AI予測・期待値・仮想運用',
  nav: { overview: '概要', horse: '競馬', boat: 'ボートレース', performance: '成績', models: 'モデル', data: 'データ収集' },
  origin: { all: 'すべて', real: '実データ', sample: 'サンプル' },
  sport: { horse: '競馬', boat: 'ボートレース' },
  edge: {
    HIGH_EDGE: 'HIGH EDGE', POSITIVE_EDGE: 'POSITIVE EDGE', NEUTRAL: 'NEUTRAL',
    NEGATIVE_EDGE: 'NEGATIVE EDGE', INSUFFICIENT_DATA: 'INSUFFICIENT DATA',
  },
  edgeHint: {
    HIGH_EDGE: '不確実性を差し引いても期待収益率 +20% 以上',
    POSITIVE_EDGE: '不確実性を差し引いても期待収益率 +5% 以上',
    NEUTRAL: '期待収益率がほぼ損益分岐',
    NEGATIVE_EDGE: '期待収益率がマイナス',
    INSUFFICIENT_DATA: '予測・オッズの欠損、未学習モデル、または不確実性が大きい',
  },
  status: { scheduled: '発走前', closed: '締切', finished: '確定', cancelled: '中止' },
  modelStatus: { untrained: '未学習', candidate: '昇格候補', active: '稼働中', retired: '退役' },
  betStatus: { open: '結果待ち', won: '的中', lost: '不的中', void: '返還' },
} as const
