/** Small per-client LRU cache with request coalescing and generation fencing. */
export class SessionCache<K, V> {
  #values = new Map<K, V>()
  #weights = new Map<K, number>()
  #weight = 0
  #pending = new Map<K, Promise<V>>()
  #generation = 0
  constructor(readonly limit = 64, readonly maxWeight = Number.POSITIVE_INFINITY, readonly weigh: (value: V) => number = () => 1) {}

  get(key: K): V | undefined {
    if (!this.#values.has(key)) return undefined
    const value = this.#values.get(key)!
    this.#values.delete(key)
    const weight = this.#weights.get(key)!
    this.#weights.delete(key)
    this.#values.set(key, value)
    this.#weights.set(key, weight)
    return value
  }

  async getOrLoad(key: K, load: () => Promise<V>): Promise<V> {
    const hit = this.get(key)
    if (hit !== undefined) return hit
    const existing = this.#pending.get(key)
    if (existing) return existing
    const generation = this.#generation
    const request = load().then(value => {
      if (generation === this.#generation) this.set(key, value)
      return value
    }).finally(() => {
      if (this.#pending.get(key) === request) this.#pending.delete(key)
    })
    this.#pending.set(key, request)
    return request
  }

  async coalesce(key: K, load: () => Promise<V>): Promise<V> {
    const existing = this.#pending.get(key)
    if (existing) return existing
    const generation = this.#generation
    const request = load().finally(() => {
      if (generation === this.#generation && this.#pending.get(key) === request) this.#pending.delete(key)
    })
    this.#pending.set(key, request)
    return request
  }

  set(key: K, value: V) {
    const weight = Math.max(0, this.weigh(value))
    if (this.limit <= 0 || weight > this.maxWeight) return
    if (this.#values.has(key)) {
      this.#weight -= this.#weights.get(key) || 0
      this.#weights.delete(key)
      this.#values.delete(key)
    }
    this.#values.set(key, value)
    this.#weights.set(key, weight)
    this.#weight += weight
    while (this.#values.size > this.limit || this.#weight > this.maxWeight) {
      const oldest = this.#values.keys().next().value!
      this.#weight -= this.#weights.get(oldest) || 0
      this.#weights.delete(oldest)
      this.#values.delete(oldest)
    }
  }

  clear() {
    this.#generation++
    this.#values.clear()
    this.#weights.clear()
    this.#weight = 0
    this.#pending.clear()
  }
}

/** Keep independent GitHub requests moving while bounding load on the API. */
export function createLimiter(max = 4) {
  let running = 0
  const queue: (() => void)[] = []
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running >= max) await new Promise<void>(resolve => queue.push(resolve))
    else running++
    try { return await task() }
    finally {
      const next = queue.shift()
      if (next) next()
      else running--
    }
  }
}
