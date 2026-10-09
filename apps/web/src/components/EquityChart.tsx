import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { yen } from '../lib/format'

export function EquityChart({ data, base }: { data: { at: string; bankroll: number }[]; base: number }) {
  const last = data.at(-1)?.bankroll ?? base
  const up = last >= base
  const color = up ? 'rgb(var(--pos))' : 'rgb(var(--neg))'
  return (
    <div className="h-[240px] w-full">
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.22} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="rgb(var(--line))" />
          <XAxis dataKey="at" tickFormatter={(v: string) => v.slice(5, 10).replace('-', '/')} tick={{ fontSize: 11, fill: 'rgb(var(--faint))' }} tickLine={false} axisLine={false} minTickGap={32} />
          <YAxis tickFormatter={(v: number) => `${Math.round(v / 1000)}k`} tick={{ fontSize: 11, fill: 'rgb(var(--faint))' }} tickLine={false} axisLine={false} width={40} domain={['auto', 'auto']} />
          <ReferenceLine y={base} stroke="rgb(var(--faint))" strokeDasharray="3 3" />
          <Tooltip
            contentStyle={{ background: 'rgb(var(--surface))', border: '1px solid rgb(var(--line))', borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: 'rgb(var(--muted))' }}
            formatter={(v) => [yen(Number(v)), '仮想資産']}
            labelFormatter={(v) => String(v).slice(0, 16).replace('T', ' ')}
          />
          <Area type="monotone" dataKey="bankroll" stroke={color} strokeWidth={2} fill="url(#eq)" dot={false} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
