import { expect, test } from 'bun:test';
import { compareLearningEvidence } from '../src/lib/crowdsec-learning-evidence';

const sessionId = '11111111-1111-4111-8111-111111111111';
const requestId = 'rudder-22222222-2222-4222-8222-222222222222';
const otherId = 'rudder-33333333-3333-4333-8333-333333333333';
const rule = 'native_rule:12345';
const clear = { alerted: false, blocked: false, banned: false, rules: [] as string[] };
const alert = { ...clear, alerted: true };
const block = { ...alert, blocked: true };

function fixture() {
  return {
    session: {
      schemaVersion: 1, sessionId, requests: [{ requestId, review: 'expected', rules: [rule, 'native_rule:12346'] }],
    },
    observations: {
      schemaVersion: 1,
      baselineRun: { engineVersion: 'v1.8.2', policyFingerprint: 'sha256:' + 'a'.repeat(64) },
      candidateRun: { engineVersion: 'v1.8.2', policyFingerprint: 'sha256:' + 'b'.repeat(64) },
      change: { kind: 'disable-rule', ruleId: rule },
      legitimate: [{ requestId, baseline: { ...block, rules: [rule] }, candidate: clear }],
      probes: [{ id: 'known-probe', required: ['blocked'], baseline: block, candidate: block }],
    },
  };
}

test('paired evidence can establish benefit for a mixed-rule request and retain probe coverage', () => {
  const { session, observations } = fixture();
  observations.baselineRun.engineVersion = observations.candidateRun.engineVersion = 'v1.8.2-3d369d64';
  const report = compareLearningEvidence([session], observations);
  expect(report.eligibleForReview).toBe(true);
  expect(report.change.ruleId).toEqual(rule);
  expect(report.legitimate[0].improved).toEqual(['alerted', 'blocked']);
  expect(report.probes[0].lost).toEqual([]);
});

test('an alert cannot substitute for an expected block', () => {
  const { session, observations } = fixture();
  observations.probes[0].candidate = alert;
  const report = compareLearningEvidence([session], observations);
  expect(report.eligibleForReview).toBe(false);
  expect(report.probes[0].lost).toEqual(['blocked']);
});

test('missing measurements and baseline failures prevent eligibility', () => {
  const { session, observations } = fixture();
  session.requests.push({ requestId: otherId, review: 'expected', rules: [rule] });
  observations.probes[0].baseline = alert;
  const report = compareLearningEvidence([session], observations);
  expect(report.eligibleForReview).toBe(false);
  expect(report.legitimate[1].baseline).toBeUndefined();
  expect(report.probes[0].baselineMissing).toEqual(['blocked']);
});

test('ambiguous IDs and an unchanged policy fingerprint are rejected', () => {
  const { session, observations } = fixture();
  expect(() => compareLearningEvidence([session, session], observations)).toThrow('Duplicate session');
  expect(() => compareLearningEvidence([session], {
    ...observations, probes: [...observations.probes, ...observations.probes],
  })).toThrow('Duplicate probe');
  expect(() => compareLearningEvidence([session], {
    ...observations, candidateRun: observations.baselineRun,
  })).toThrow('fingerprints must differ');
  expect(() => compareLearningEvidence([session], {
    ...observations, candidateRun: { ...observations.candidateRun, engineVersion: 'v1.9.0' },
  })).toThrow('same engine version');
});

test('unreviewed improvement and regressions on other expected traffic prevent eligibility', () => {
  const { session, observations } = fixture();
  session.requests.push({ requestId: otherId, review: 'expected', rules: [] });
  observations.legitimate.push({ requestId: otherId, baseline: clear, candidate: alert });
  expect(compareLearningEvidence([session], observations).eligibleForReview).toBe(false);
  session.requests[0].review = 'uncertain';
  expect(() => compareLearningEvidence([session], observations)).toThrow('no expected request review');
});

test('paired rules must substantiate the recorded match and the proposed removal', () => {
  const { session, observations } = fixture();
  observations.legitimate[0].baseline.rules = [];
  expect(compareLearningEvidence([session], observations).legitimate[0].matchedRule).toBe(false);
  observations.legitimate[0].baseline.rules = [rule];
  observations.probes[0].candidate = { ...block, rules: [rule] };
  const report = compareLearningEvidence([session], observations);
  expect(report.eligibleForReview).toBe(false);
  expect(report.blockers).toContain('The candidate still reported a match for the rule proposed for removal.');
});
