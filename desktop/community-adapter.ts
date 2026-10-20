import { randomUUID } from 'node:crypto'

/** Typed process-local hooks used only by this distribution's bootstrap. */
export type CommunityRecoveryAction = 'retry' | 'disable-plugins' | 'fallback' | 'manual'

declare global {
  namespace NodeJS {
    interface Process {
      emit(event: 'community:pending'): boolean
      emit(event: 'community:scheme-registered', acknowledge: () => void): boolean
      emit(event: 'community:ready', probe: () => Promise<boolean>, unhealthy: () => void): boolean
      emit(event: 'community:recover', resolve: (action: CommunityRecoveryAction) => void): boolean
    }
  }
}

/** Only the same-process bootstrap that already registered the scheme may suppress official registration. */
export function communitySchemeRegistered(): boolean {
  let registered = false
  process.emit('community:scheme-registered', () => { registered = true })
  return registered
}

/** Notify the bootstrap after the official Host reaches ready. */
export function communityReady(probe: () => Promise<boolean>, unhealthy: () => void): void {
  process.emit('community:ready', probe, unhealthy)
}

/** A side-effect-free authenticated RPC verifies HTTP and Host dispatch, without model calls. */
export function communityHealthProbe(host: string | undefined, cookie: string | undefined): () => Promise<boolean> {
  let target: string
  try {
    const url = new URL(host ?? '')
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      || url.username || url.password || !url.port || !cookie || cookie.length > 8192 || /[\r\n]/u.test(cookie)) {
      return async () => false
    }
    target = new URL('/api/productAnalytics/enabled', url.origin).href
  } catch { return async () => false }
  return async () => {
    try {
      const rpcId = randomUUID()
      const response = await fetch(target, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000),
        headers: { cookie: cookie!, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method: 'productAnalytics/enabled', payload: { args: {} } }),
      })
      if (!response.ok) { await response.body?.cancel(); return false }
      const result = await response.json()
      return result?.type === 'server-response' && result.rpcId === rpcId
        && result.result?.ok === true && typeof result.result.value === 'boolean'
    } catch { return false } // Never log the authenticated URL or cookie.
  }
}

/** Cancel community probation whenever the official backend is not ready. */
export function communityPending(): void {
  process.emit('community:pending')
}

/** Ask the bootstrap for a persisted, bounded recovery action. */
export function communityRecover(): Promise<CommunityRecoveryAction> {
  if (process.listenerCount('community:recover') === 0) return Promise.resolve('manual')
  return new Promise(resolve => { process.emit('community:recover', resolve) })
}
