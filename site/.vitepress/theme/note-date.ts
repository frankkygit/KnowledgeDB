/** Format legacy date-only note timestamps without inventing a time of day. */
export function formatNoteDate(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  return new Date(value).toLocaleString()
}
