import { ja } from './ja'

// 将来の英語対応用。現在は日本語のみ。
export type Dict = typeof ja
const dicts: Record<string, Dict> = { ja }
let current: Dict = ja

export function setLocale(locale: string) { current = dicts[locale] ?? ja }
export const t = () => current
