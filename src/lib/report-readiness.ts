interface MonitorState {
  is_enabled: number; baseline_established: number; status: string | null
  is_complete: number | null; started_at: string | null; finished_at: string | null
}

// Evaluate the latest attempt only. An earlier success never hides a failed/running attempt.
export function reportReadiness(monitor: MonitorState | null, from?: string, before?: string, now = Date.now()) {
  if (!from || !before) return 'not_requested'
  if (!monitor) return 'no_scan'
  if (!monitor.is_enabled || !monitor.baseline_established) return 'not_enabled_or_baselined'
  if (monitor.status !== 'success') return monitor.status ?? 'no_scan'
  if (monitor.is_complete !== 1) return 'incomplete'
  const start = Date.parse(monitor.started_at ?? '')
  const end = Date.parse(monitor.finished_at ?? '')
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end > now) return 'invalid_time'
  if (now - start > 20 * 60 * 1_000) return 'stale_or_outside_window'
  if (start < Date.parse(from) || start >= Date.parse(before) || end > Date.parse(before)) return 'stale_or_outside_window'
  return 'ready'
}
