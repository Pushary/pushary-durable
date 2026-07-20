# @pushary/durable

[![CI](https://github.com/Pushary/pushary-durable/actions/workflows/ci.yml/badge.svg)](https://github.com/Pushary/pushary-durable/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@pushary/durable)](https://www.npmjs.com/package/@pushary/durable)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Full walkthrough: [Human-in-the-loop for durable orchestrators (Inngest, Temporal, Vercel Workflow)](https://pushary.com/human-in-the-loop?utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-durable&utm_content=readme). Reaching your own end-users on their phones is the Pushary [Partner plan](https://pushary.com/human-in-the-loop?utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-durable&utm_content=readme).

Durable human-in-the-loop for step orchestrators. Park your workflow until a real
human approves on their phone, and resume on a signed webhook, with zero idle
compute during the wait.

Works with [Inngest](https://www.inngest.com), [Temporal](https://temporal.io), and
[Vercel Workflow](https://vercel.com/docs/workflows), or any runner that can wait on
an external event. It adds no framework dependency of its own, so it drops into
whichever one you already run.

Requires the Pushary [Partner plan](https://pushary.com/agent-notifications-integration?utm_source=github&utm_medium=oss-adapter&utm_campaign=pushary-durable&utm_content=readme).

## Install

```bash
npm i @pushary/durable
```

Set `PUSHARY_API_KEY` (get it in your [dashboard](https://pushary.com/dashboard/settings))
and `PUSHARY_WEBHOOK_SECRET` (from `decisions.getWebhookSecret()`).

## The shape

1. `connect(config, externalId)` once per end-user. Show them the link, they tap to
   connect their phone.
2. `createApproval(config, { callbackUrl, idempotencyKey, ... })` opens a durable
   decision and returns immediately. Store the `correlationId` against your run and
   park the workflow.
3. When the human answers, Pushary POSTs your `callbackUrl`. `resolveApproval(raw,
   signature, secret)` verifies the signature and hands you `{ approved, answer }`.
   Look up the parked run by `correlationId` and resume it.

The wait is durable on Pushary's side (a decisions ledger) and on yours (the
orchestrator's snapshot), so nothing is lost across a restart.

## Inngest

```ts
import { createApproval, resolveApproval, deterministicKey } from '@pushary/durable'

export const refund = inngest.createFunction(
  { id: 'refund', triggers: { event: 'app/refund.requested' } },
  async ({ event, step }) => {
    const { correlationId } = await step.run('ask-human', () =>
      createApproval(
        { apiKey: process.env.PUSHARY_API_KEY! },
        {
          externalId: event.data.userId,
          question: `Approve a $${event.data.amount} refund?`,
          callbackUrl: `${process.env.PUBLIC_URL}/api/inngest/pushary`,
          idempotencyKey: deterministicKey([event.id, 'refund-approval']),
        },
      ),
    )

    const answered = await step.waitForEvent('wait-for-answer', {
      event: 'pushary/decision.resolved',
      timeout: '1d',
      // the correlationId is generated inside the step, so match on it with `if`
      if: `async.data.correlationId == "${correlationId}"`,
    })

    if (answered?.data.approved) await step.run('refund', () => issueRefund(event.data))
  },
)

// mount one route that turns Pushary callbacks into Inngest events:
export async function POST(req: Request) {
  const raw = await req.text()
  const approval = resolveApproval(raw, req.headers.get('x-pushary-signature'), process.env.PUSHARY_WEBHOOK_SECRET!)
  if (!approval) return new Response('bad signature', { status: 401 })
  await inngest.send({ name: 'pushary/decision.resolved', data: { ...approval } })
  return new Response('ok')
}
```

## Temporal

```ts
// activity
export async function askHuman(userId: string, amount: number, runId: string) {
  return createApproval(
    { apiKey: process.env.PUSHARY_API_KEY! },
    {
      externalId: userId,
      question: `Approve a $${amount} refund?`,
      callbackUrl: `${process.env.PUBLIC_URL}/api/temporal/pushary`,
      idempotencyKey: deterministicKey([runId, 'refund-approval']),
    },
  )
}

// workflow: create in an activity, then wait for a signal
export async function refundWorkflow(userId: string, amount: number) {
  const approve = defineSignal<[{ answer: string; approved: boolean }]>('pushary_answer')
  let result: { approved: boolean } | null = null
  setHandler(approve, (a) => { result = a })
  await askHuman(userId, amount, workflowInfo().workflowId)
  await condition(() => result !== null, '1 day')
  if (result?.approved) await issueRefund(userId, amount)
}

// callback route signals the workflow (map correlationId -> workflowId in your store)
```

## Vercel Workflow

```ts
import { createWebhook } from 'workflow'
import { createApproval, resolveApproval, deterministicKey } from '@pushary/durable'

export async function refundWorkflow(userId: string, amount: number, runId: string) {
  'use workflow'
  using webhook = createWebhook()
  await createApproval(
    { apiKey: process.env.PUSHARY_API_KEY! },
    {
      externalId: userId,
      question: `Approve a $${amount} refund?`,
      callbackUrl: webhook.url, // Pushary posts straight to the run's resume URL
      idempotencyKey: deterministicKey([runId, 'refund-approval']),
    },
  )
  const request = await webhook // parks here until the callback arrives
  const approval = resolveApproval(
    await request.text(),
    request.headers.get('x-pushary-signature'),
    process.env.PUSHARY_WEBHOOK_SECRET!,
  )
  if (approval?.approved) await issueRefund(userId, amount)
}
```

The resume URL is not authentication on its own, so always `resolveApproval` (which
verifies the HMAC signature) before you act.

## API

- `connect(config, externalId)` — enroll an end-user's phone, returns `EnrollResult`.
- `createApproval(config, input)` — open a durable decision, returns `{ decisionId, correlationId, reachable, ... }`.
- `resolveApproval(rawBody, signature, secret)` — verify + parse a callback into `{ correlationId, answer, value, approved, context? }`, or `null` if invalid.
- `isAffirmative(answer)` — fail-closed yes/no check for a confirm answer.
- `deterministicKey(parts)` — a stable idempotency key from your run + step ids.
- Re-exports: `verifyWebhookSignature`, `parseDecisionCallback`, `SIGNATURE_HEADER`.

## Example

A runnable example is in [`examples/`](examples).

## License

MIT
