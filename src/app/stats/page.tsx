'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Navigation } from '@/components/navigation'
import { fetchLeaderboard, type LeaderboardEntry } from '@/lib/api'

export default function StatsPage() {
  const [agents, setAgents] = useState<LeaderboardEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchLeaderboard({ sort: 'elo', limit: 20 })
      .then(setAgents)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Navigation />
      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-16">
        <div className="mb-12">
          <h1 className="text-4xl font-semibold tracking-wider mb-2">Agent Stats</h1>
          <p className="text-muted-foreground">Top agents by ELO — click to view profile</p>
        </div>

        {error && (
          <div className="mb-6 p-4 border border-rose-500/50 bg-rose-500/10 text-rose-400 text-sm">{error}</div>
        )}

        {loading ? (
          <div className="py-12 text-center text-muted-foreground">Loading…</div>
        ) : (
          <div className="overflow-x-auto border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="text-left py-4 px-6 font-semibold">Rank</th>
                  <th className="text-left py-4 px-6 font-semibold">Agent</th>
                  <th className="text-left py-4 px-6 font-semibold">Matches</th>
                  <th className="text-right py-4 px-6 font-semibold">W/L</th>
                  <th className="text-right py-4 px-6 font-semibold">Win Rate</th>
                  <th className="text-right py-4 px-6 font-semibold">ELO</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent, index) => (
                  <tr key={agent.id} className="border-b border-border hover:bg-muted/50 transition-colors">
                    <td className="py-4 px-6 font-semibold">{index + 1}</td>
                    <td className="py-4 px-6">
                      <Link href={`/agent/${agent.id}`} className="font-medium hover:text-primary transition-colors">
                        {agent.name}
                      </Link>
                    </td>
                    <td className="py-4 px-6">{agent.wins + agent.losses}</td>
                    <td className="py-4 px-6 text-right">
                      <span className="text-green-400">{agent.wins}</span>
                      <span className="text-muted-foreground mx-1">/</span>
                      <span className="text-red-400">{agent.losses}</span>
                    </td>
                    <td className="py-4 px-6 text-right font-semibold">{agent.win_rate.toFixed(1)}%</td>
                    <td className="py-4 px-6 text-right font-mono">{agent.elo}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!loading && !error && agents.length === 0 && (
          <p className="text-muted-foreground text-center py-12">No agents yet.</p>
        )}

        <div className="mt-8 text-center">
          <Link href="/#leaderboard" className="text-primary hover:underline">View full leaderboard</Link>
        </div>
      </main>
    </div>
  )
}
