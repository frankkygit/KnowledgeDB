export async function runCommentSessionStep<T>(assertCurrent: () => void, step: () => Promise<T>): Promise<T> {
  assertCurrent()
  const result = await step()
  assertCurrent()
  return result
}
