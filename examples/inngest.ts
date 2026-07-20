/**
 * Minimal durable example (Inngest): park a workflow on a human approval and resume
 * on the signed webhook. Zero idle compute during the wait.
 *
 * Prereqs: npm i @pushary/durable inngest
 * Env:     PUSHARY_API_KEY, PUSHARY_WEBHOOK_SECRET, PUBLIC_URL
 *
 * The Pushary calls (createApproval / resolveApproval / deterministicKey) are the
 * point of this file. saveCorrelation / lookupCorrelation / resumeRun are your own
 * glue: map Pushary's correlationId to your run, then continue it.
 */
import { Inngest } from 'inngest'
import { createApproval, resolveApproval, deterministicKey } from '@pushary/durable'

const inngest = new Inngest({ id: 'refunds' })
const config = { apiKey: process.env.PUSHARY_API_KEY! }

// Open a durable decision inside a step, then let the function end. Nothing runs
// while the human decides.
export const refund = inngest.createFunction(
  { id: 'refund', triggers: { event: 'app/refund.requested' } },
  async ({ event, step }) => {
    const { correlationId } = await step.run('ask-human', () =>
      createApproval(config, {
        externalId: event.data.userId,
        question: `Approve a $${event.data.amount} refund?`,
        callbackUrl: `${process.env.PUBLIC_URL}/api/inngest/pushary`,
        idempotencyKey: deterministicKey([event.id, 'refund-approval']),
      }),
    )
    await saveCorrelation(correlationId, event.id) // your run <-> correlationId map
  },
)

// POST /api/inngest/pushary  — verify the signature, then resume the parked run.
export async function POST(req: Request) {
  const raw = await req.text()
  const cb = resolveApproval(raw, req.headers.get('x-pushary-signature'), process.env.PUSHARY_WEBHOOK_SECRET!)
  if (!cb) return new Response('bad signature', { status: 401 })
  const eventId = await lookupCorrelation(cb.correlationId)
  await resumeRun(eventId, cb.approved)
  return new Response('ok')
}

// --- your own glue (stub signatures) ---
declare function saveCorrelation(correlationId: string, runId: string): Promise<void>
declare function lookupCorrelation(correlationId: string): Promise<string>
declare function resumeRun(runId: string, approved: boolean): Promise<void>
