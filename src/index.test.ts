import { describe, it, expect, afterEach } from 'vitest'
import { createHmac } from 'crypto'
import {
  createApproval,
  resolveApproval,
  isAffirmative,
  connect,
  SIGNATURE_HEADER,
} from './index'

interface Recorded {
  readonly url: string
  readonly method: string
  readonly body: Record<string, unknown> | undefined
}

const realFetch = globalThis.fetch
const installFetch = (json: unknown): Recorded[] => {
  const calls: Recorded[] = []
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    })
    return { ok: true, status: 200, json: async () => json } as Response
  }) as typeof fetch
  return calls
}
afterEach(() => {
  globalThis.fetch = realFetch
})

const CONFIG = { apiKey: 'pk_x.sk_y', baseUrl: 'https://pushary.com/api/v1/server' }
const SECRET = 'whsec_test'
const sign = (body: string) => createHmac('sha256', SECRET).update(body).digest('hex')

describe('isAffirmative', () => {
  it('is true only for affirmative confirm answers', () => {
    expect(isAffirmative('yes')).toBe(true)
    expect(isAffirmative('approve')).toBe(true)
    expect(isAffirmative('OK')).toBe(true)
    expect(isAffirmative('no')).toBe(false)
    expect(isAffirmative('Option B')).toBe(false)
    expect(isAffirmative(null)).toBe(false)
    expect(isAffirmative(undefined)).toBe(false)
  })
})

describe('createApproval', () => {
  it('creates a non-waiting decision with the callback and surfaces reachability', async () => {
    const calls = installFetch({
      decisionId: 'd1',
      status: 'pending',
      reachable: true,
      reachableChannels: 2,
      deviceCount: 1,
    })
    const out = await createApproval(CONFIG, {
      externalId: 'user_1',
      question: 'Approve $50 refund?',
      callbackUrl: 'https://app.example.com/webhooks/pushary',
      idempotencyKey: 'run_9:approve',
    })
    expect(calls[0].url).toBe('https://pushary.com/api/v1/server/decisions')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].body?.wait).toBe(false)
    expect(calls[0].body?.callbackUrl).toBe('https://app.example.com/webhooks/pushary')
    expect(calls[0].body?.idempotencyKey).toBe('run_9:approve')
    expect(out.correlationId).toBe('d1')
    expect(out.reachable).toBe(true)
    expect(out.reachableChannels).toBe(2)
  })
})

describe('connect', () => {
  it('enrolls an end-user and returns the universal link', async () => {
    const calls = installFetch({ externalId: 'user_1', universalLink: 'https://pushary.com/e/tok' })
    const res = await connect(CONFIG, 'user_1')
    expect(calls[0].url).toBe('https://pushary.com/api/v1/server/enroll')
    expect(calls[0].body?.externalId).toBe('user_1')
    expect(res.universalLink).toBe('https://pushary.com/e/tok')
  })
})

describe('resolveApproval', () => {
  it('verifies the signature, then parses answer + fail-closed approved', () => {
    const body = JSON.stringify({
      correlationId: 'd1',
      answer: 'yes',
      answeredAt: '2026-07-17T00:00:00Z',
      context: 'run_9',
    })
    const out = resolveApproval(body, sign(body), SECRET)
    expect(out).not.toBeNull()
    expect(out?.correlationId).toBe('d1')
    expect(out?.answer).toBe('yes')
    expect(out?.approved).toBe(true)
    expect(out?.context).toBe('run_9')
  })

  it('rejects a body whose signature does not match', () => {
    const body = JSON.stringify({ correlationId: 'd1', answer: 'yes', answeredAt: '' })
    expect(resolveApproval(body, 'deadbeef', SECRET)).toBeNull()
  })

  it('rejects a validly-signed body that is not a decision callback', () => {
    const body = JSON.stringify({ hello: 'world' })
    expect(resolveApproval(body, sign(body), SECRET)).toBeNull()
  })

  it('marks a decline as not approved but still returns the answer', () => {
    const body = JSON.stringify({ correlationId: 'd2', answer: 'no', answeredAt: '' })
    const out = resolveApproval(body, sign(body), SECRET)
    expect(out?.approved).toBe(false)
    expect(out?.answer).toBe('no')
  })
})

describe('exports', () => {
  it('re-exports the signature header for callback routes', () => {
    expect(SIGNATURE_HEADER).toBe('x-pushary-signature')
  })
})
