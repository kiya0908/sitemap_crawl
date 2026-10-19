export function validatePathPrefix(value: string): string {
  if (!/^\/(?:[A-Za-z0-9_-]+\/)+$/.test(value) || value.length > 200) {
    throw new Error('Path prefix must use literal path segments and end with /')
  }
  return value
}

export function matchesMonitorPath(url: string, prefix: string | null): boolean {
  if (prefix === null) return true
  validatePathPrefix(prefix)
  try {
    const path = new URL(url).pathname
    return path.startsWith(prefix) && path.length > prefix.length
  } catch {
    return false
  }
}

// Only applied to validated, normalized HTTP(S) URLs stored by the scanner.
export const normalizedPathSql = (() => {
  const authorityAndPath = "substr(p.normalized_url, instr(p.normalized_url, '://') + 3)"
  const pathAndQuery = `substr(${authorityAndPath}, instr(${authorityAndPath}, '/'))`
  return `substr(${pathAndQuery}, 1, instr(${pathAndQuery} || '?', '?') - 1)`
})()

export function inferSlugKeyword(url: string): string | null {
  try {
    const slug = new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? ''
    return decodeURIComponent(slug).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) || null
  } catch {
    return null
  }
}
