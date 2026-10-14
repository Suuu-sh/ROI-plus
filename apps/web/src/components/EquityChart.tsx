import { useId } from 'react'
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { yen } from '../lib/format'

export function EquityChart({ data, base, compact = false, valueLabel = '仮想資産', baseLabel = '初期資金' }: { data: { at: string; bankroll: number }[]; base: number; compact?: boolean; valueLabel?: string; baseLabel?: string }) {
  const last = data.at(-1)?.bankroll ?? base
  const up = last >= base
  const color = up ? 'rgb(var(--pos))' : 'rgb(var(--neg))'
  const gradient = `eq-${useId().replace(/:/g, '')}`
  const animate = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  return (
    <div className={`anim-fade w-full ${compact ? 'h-[168px]' : 'h-[240px]'}`}>
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.28} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="rgb(var(--line))" strokeDasharray="2 4" />
          <XAxis dataKey="at" tickFormatter={(v: string) => v.slice(5, 10).replace('-', '/')} tick={{ fontSize: 11, fill: 'rgb(var(--faint))' }} tickLine={false} axisLine={false} minTickGap={32} />
          <YAxis tickFormatter={(v: number) => `${Math.round(v / 1000)}k`} tick={{ fontSize: 11, fill: 'rgb(var(--faint))' }} tickLine={false} axisLine={false} width={40} domain={['auto', 'auto']} />
          <ReferenceLine y={base} stroke="rgb(var(--ink))" strokeOpacity={0.5} strokeDasharray="4 4" label={{ value: baseLabel, position: 'insideTopLeft', fontSize: 10, fill: 'rgb(var(--muted))' }} />
          <Tooltip
            contentStyle={{ background: 'rgb(var(--surface))', border: '1px solid rgb(var(--ink))', borderRadius: 4, fontSize: 12, boxShadow: '3px 3px 0 rgb(var(--ink))' }}
            cursor={{ stroke: 'rgb(var(--ink))', strokeWidth: 1, strokeDasharray: '3 3' }}
            labelStyle={{ color: 'rgb(var(--muted))' }}
            formatter={(v) => [yen(Number(v)), valueLabel]}
            labelFormatter={(v) => String(v).slice(0, 16).replace('T', ' ')}
          />
          <Area type="monotone" dataKey="bankroll" stroke={color} strokeWidth={2.25} fill={`url(#${gradient})`} dot={false}
            activeDot={{ r: 5, stroke: 'rgb(var(--ink))', strokeWidth: 2, fill: 'rgb(var(--mark))' }}
            isAnimationActive={animate} animationDuration={1600} animationEasing="ease-out" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
