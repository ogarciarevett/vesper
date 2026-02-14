interface StatCardProps {
  label: string;
  value: string;
  trend: string;
  trendUp?: boolean;
}

export function StatCard({ label, value, trend, trendUp = true }: StatCardProps) {
  return (
    <div className="p-5 rounded-xl bg-black/40 border border-white/5">
      <div className="text-sm text-white/40 mb-2">{label}</div>
      <div className="text-3xl font-bold tracking-tight mb-2">{value}</div>
      <div className={`text-xs font-medium ${trendUp ? "text-green-400" : "text-purple-400"}`}>
        {trend}
      </div>
    </div>
  )
}
