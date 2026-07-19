import {
  createPusharyServer,
  deterministicKey,
  isApproved,
  parseDecisionCallback,
  verifyWebhookSignature,
  SIGNATURE_HEADER,
  type DecisionType,
  type EnrollResult,
} from '@pushary/server'

// Re-exported so a callback route needs one import from this package.
export { SIGNATURE_HEADER, verifyWebhookSignature, parseDecisionCallback, deterministicKey }

export interface PusharyDurableConfig {
  /** Your Pushary API key (pk_xxx.sk_xxx). Defaults to `process.env.PUSHARY_API_KEY`. */
  readonly apiKey?: string
  /** Shown on the approval so the human knows which agent is asking. */
  readonly agentName?: string
  /** Override the API base URL (tests / self-host). */
  readonly baseUrl?: string
}

export interface CreateApprovalInput {
  /** Your own stable id for the end-user who decides. Enroll their phone once with `connect`. */
  readonly externalId: string
  readonly question: string
  /**
   * Where Pushary POSTs the signed callback when the human answers. Your workflow
   * parks until a request hits this URL (an Inngest event, a Temporal signal route,
   * a Vercel Workflow webhook), then resumes.
   */
  readonly callbackUrl: string
  /**
   * REQUIRED and STABLE across retries/replays. A durable step re-runs on resume, so
   * a per-attempt key would page the human twice. Tie it to your run + step id, e.g.
   * `deterministicKey([runId, 'approve-transfer'])`.
   */
  readonly idempotencyKey: string
  readonly type?: DecisionType
  readonly options?: readonly string[]
  /** Free-text context. Echoed back on the callback, so you can carry your resume key here. */
  readonly context?: string
  /** Approver email; DMs that person if you have Slack connected. */
  readonly email?: string
  readonly expiresInSeconds?: number
  /** Refuse (throw) instead of opening a decision the end-user cannot receive. */
  readonly requireReachable?: boolean
}

export interface CreatedApproval {
  readonly decisionId: string
  /** Same value as decisionId; the callback echoes it as `correlationId`. */
  readonly correlationId: string
  readonly status: string
  /** Whether the decision could reach the end-user at create time (needs a specific externalId). */
  readonly reachable?: boolean
  readonly reachableChannels?: number
  readonly deviceCount?: number
}

// The verified, parsed callback. Look up your parked run by `correlationId` (or read
// `context` if you carried your resume key there), then resume it with `answer`.
export interface PusharyApproval {
  readonly correlationId: string
  /** Canonical answer. For a confirm it is "yes"/"no"; for select/input it is the value. */
  readonly answer: string
  /** Alias of `answer`. */
  readonly value: string
  /** Fail-closed: true only when `answer` is affirmative (yes/approve/ok/...). */
  readonly approved: boolean
  /** Whatever you passed as `context` at create time, if any. */
  readonly context?: string
  readonly answeredAt: string
}

const resolveApiKey = (config: PusharyDurableConfig): string => {
  const key = config.apiKey ?? process.env.PUSHARY_API_KEY
  if (!key) {
    throw new Error('Pushary: set PUSHARY_API_KEY or pass { apiKey } to the durable helpers.')
  }
  return key
}

/**
 * Fail-closed approval check for a callback answer. True only for an affirmative
 * confirm ("yes", "approve", "ok", ...); a decline, a select value, or free text is
 * false. For select/input decisions read `answer` directly instead.
 */
export const isAffirmative = (answer: string | null | undefined): boolean =>
  isApproved({ status: 'answered', type: 'confirm', value: answer ?? null })

/**
 * Connect one end-user's phone (keyless). Returns a single-use link to show them;
 * one tap turns on approvals. Call once per end-user and cache the enrollment.
 */
export const connect = (config: PusharyDurableConfig, externalId: string): Promise<EnrollResult> =>
  createPusharyServer({ apiKey: resolveApiKey(config), baseUrl: config.baseUrl }).enroll(externalId)

/**
 * Open a durable decision addressed to one end-user and return immediately (no wait).
 * Persist the returned `correlationId` against your run/step, then park the workflow.
 * When the human answers, Pushary POSTs your `callbackUrl`; resolve it with
 * `resolveApproval` and resume.
 */
export const createApproval = async (
  config: PusharyDurableConfig,
  input: CreateApprovalInput,
): Promise<CreatedApproval> => {
  const client = createPusharyServer({ apiKey: resolveApiKey(config), baseUrl: config.baseUrl })
  const created = await client.decisions.create({
    externalId: input.externalId,
    question: input.question,
    type: input.type,
    options: input.options,
    context: input.context,
    email: input.email,
    callbackUrl: input.callbackUrl,
    idempotencyKey: input.idempotencyKey,
    expiresInSeconds: input.expiresInSeconds,
    requireReachable: input.requireReachable,
    agentName: config.agentName,
    wait: false,
  })
  return {
    decisionId: created.decisionId,
    correlationId: created.decisionId,
    status: created.status,
    reachable: created.reachable,
    reachableChannels: created.reachableChannels,
    deviceCount: created.deviceCount,
  }
}

/**
 * Verify a callback's signature and parse it into a typed approval. Returns null if
 * the signature is invalid or the body is not a decision callback, so a spoofed or
 * malformed request never resumes your workflow. Verify happens FIRST; only a valid
 * signature is parsed.
 */
export const resolveApproval = (
  rawBody: string,
  signature: string | null | undefined,
  secret: string,
): PusharyApproval | null => {
  if (!verifyWebhookSignature(rawBody, signature, secret)) return null
  const cb = parseDecisionCallback(rawBody)
  if (!cb) return null
  return {
    correlationId: cb.correlationId,
    answer: cb.answer,
    value: cb.value,
    approved: isAffirmative(cb.answer),
    context: cb.context,
    answeredAt: cb.answeredAt,
  }
}
