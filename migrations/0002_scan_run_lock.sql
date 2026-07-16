-- 同一竞品只允许一个 running 扫描。先收敛历史重复运行记录，保证索引可创建。
UPDATE scan_runs AS current
SET status = 'failed',
    is_complete = 0,
    finished_at = COALESCE(finished_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    error_summary = COALESCE(error_summary, 'Superseded duplicate running scan during migration')
WHERE current.status = 'running'
  AND EXISTS (
    SELECT 1
    FROM scan_runs newer
    WHERE newer.competitor_id = current.competitor_id
      AND newer.status = 'running'
      AND (
        newer.created_at > current.created_at
        OR (newer.created_at = current.created_at AND newer.id > current.id)
      )
  );

CREATE UNIQUE INDEX idx_scan_runs_one_running_per_competitor
  ON scan_runs(competitor_id)
  WHERE status = 'running';
