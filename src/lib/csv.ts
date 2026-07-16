const SPREADSHEET_FORMULA_PREFIX = /^\s*[=+\-@]/

export function csvCell(value: string): string {
  const safeValue = SPREADSHEET_FORMULA_PREFIX.test(value) ? `'${value}` : value
  return `"${safeValue.replaceAll('"', '""')}"`
}
