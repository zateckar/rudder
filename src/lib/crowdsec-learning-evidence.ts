import { z } from 'zod';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const requestId = z.string().refine((id) => id.startsWith('rudder-') && uuid.test(id.slice(7)));
const ruleId = z.string().regex(/^(?:native_rule:[0-9]+|[a-z0-9-]+\/[a-z0-9-]+)$/);
const reviewLabels = ['expected', 'unexpected', 'uncertain'] as const;
export type LearningReview = typeof reviewLabels[number];

const reviewedSession = z.strictObject({
  schemaVersion: z.literal(1),
  sessionId: z.string().regex(uuid),
  requests: z.array(z.strictObject({
    requestId,
    review: z.enum(reviewLabels),
    rules: z.array(ruleId),
  })).min(1).max(500),
});

const observedOutcome = z.strictObject({
  alerted: z.boolean(),
  blocked: z.boolean(),
  banned: z.boolean(),
  rules: z.array(ruleId),
});
const fingerprint = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const policyRun = z.strictObject({
  engineVersion: z.string().regex(/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?(?:\+[a-z0-9.-]+)?$/i),
  policyFingerprint: fingerprint,
});

const candidateObservations = z.strictObject({
  schemaVersion: z.literal(1),
  baselineRun: policyRun,
  candidateRun: policyRun,
  change: z.strictObject({ kind: z.literal('disable-rule'), ruleId }),
  legitimate: z.array(z.strictObject({
    requestId,
    baseline: observedOutcome,
    candidate: observedOutcome,
  })),
  probes: z.array(z.strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,79}$/i),
    required: z.array(z.enum(['alerted', 'blocked', 'banned'])).min(1),
    baseline: observedOutcome,
    candidate: observedOutcome,
  })),
}).refine((item) => item.baselineRun.policyFingerprint !== item.candidateRun.policyFingerprint, {
  message: 'The baseline and candidate policy fingerprints must differ',
}).refine((item) => item.baselineRun.engineVersion === item.candidateRun.engineVersion, {
  message: 'The baseline and candidate must use the same engine version',
});

function uniqueById<T>(rows: T[], keyFor: (row: T) => string, label: string) {
  const byId = new Map<string, T>();
  for (const row of rows) {
    const id = keyFor(row);
    if (byId.has(id)) throw new Error(`Duplicate ${label} ID: ${id}`);
    byId.set(id, row);
  }
  return byId;
}

const signals = ['alerted', 'blocked', 'banned'] as const;

export function compareLearningEvidence(exports: unknown[], observations: unknown) {
  const sessions = uniqueById(exports.map((value) => reviewedSession.parse(value)), (row) => row.sessionId, 'session');
  const requests = uniqueById([...sessions.values()].flatMap((row) => row.requests), (row) => row.requestId, 'request');
  const { legitimate, probes, ...policy } = candidateObservations.parse(observations);
  const measured = uniqueById(legitimate, (row) => row.requestId, 'legitimate observation');
  const measuredProbes = uniqueById(probes, (row) => row.id, 'probe observation');
  for (const id of measured.keys()) {
    if (requests.get(id)?.review !== 'expected') throw new Error(`Observation has no expected request review: ${id}`);
  }

  const legitimateResults = [...requests.values()].filter((row) => row.review === 'expected').map((row) => {
    const observed = measured.get(row.requestId);
    const baseline = observed?.baseline;
    const candidate = observed?.candidate;
    const matchedRule = row.rules.includes(policy.change.ruleId) && baseline?.rules.includes(policy.change.ruleId) === true;
    const improved = signals.filter((signal) => baseline?.[signal] === true && candidate?.[signal] === false);
    const regressed = signals.filter((signal) => baseline?.[signal] === false && candidate?.[signal] === true);
    return { requestId: row.requestId, matchedRule, baseline, candidate, improved, regressed };
  });

  const probeResults = [...measuredProbes.values()].map((probe) => {
    const required = new Set(probe.required);
    const baselineMissing = signals.filter((signal) => required.has(signal) && !probe.baseline[signal]);
    const lost = signals.filter((signal) => (required.has(signal) || probe.baseline[signal]) && !probe.candidate[signal]);
    return { ...probe, baselineMissing, lost };
  });
  const blockers: string[] = [];
  if (!legitimateResults.some((row) => row.matchedRule && row.improved.length)) {
    blockers.push('No measured benefit for a reviewed expected request that matched the proposed rule.');
  }
  if (legitimateResults.some((row) => !row.baseline)) blockers.push('Some reviewed expected requests lack paired outcomes.');
  if (legitimateResults.some((row) => row.regressed.length)) blockers.push('A reviewed expected request gained a new enforcement outcome.');
  if (!probeResults.length) blockers.push('No paired known probe outcomes were supplied.');
  if (probeResults.some((row) => row.baselineMissing.length)) blockers.push('The baseline failed to meet a known probe expectation.');
  if (probeResults.some((row) => row.lost.length)) blockers.push('The candidate lost a baseline or required probe outcome.');
  if ([...legitimate, ...probes].some((row) => row.candidate.rules.includes(policy.change.ruleId))) {
    blockers.push('The candidate still reported a match for the rule proposed for removal.');
  }

  return {
    ...policy,
    eligibleForReview: blockers.length === 0,
    blockers,
    operatorChecks: [
      'Verify the policy fingerprints and confirm the candidate differs only by the proposed rule removal.',
      'Verify that the paired observations use the same fixtures and that the known probes cover the affected controls.',
    ],
    legitimate: legitimateResults,
    probes: probeResults,
  };
}
