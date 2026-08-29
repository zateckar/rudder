/**
 * Reading CrowdSec's decisions, and the distinction the panel got wrong.
 *
 * "No decisions" and "could not ask" look identical once both are an empty
 * array, and the page rendered that as "all clear". A worker with three live
 * bans — one of them on the operator reading the page — reported itself clear,
 * which is the one answer that stops someone from looking further.
 */
import { describe, expect, test } from 'bun:test';
import { parseDecisions } from './crowdsec';

/** A row shaped like `cscli decisions list -o json` really emits. */
const ROW = {
  id: 19983302,
  origin: 'crowdsec',
  scope: 'Ip',
  value: '178.209.129.231',
  scenario: 'crowdsecurity/crowdsec-appsec-outofband',
  type: 'ban',
  duration: '3h42m58s',
};

describe('parseDecisions', () => {
  test('maps a decision onto what the table renders', () => {
    expect(parseDecisions(JSON.stringify([ROW]), 0)).toEqual([
      {
        id: 19983302,
        source: 'crowdsec',
        scope: 'Ip',
        value: '178.209.129.231',
        reason: 'crowdsecurity/crowdsec-appsec-outofband',
        type: 'ban',
        duration: '3h42m58s',
      },
    ]);
  });

  test('keeps the id, because it is what lifts the ban', () => {
    expect(parseDecisions(JSON.stringify([ROW]), 0)![0].id).toBe(19983302);
  });

  test('`null` from cscli is an answer meaning none, not a failure', () => {
    // This is what an actually-clear worker prints, and it has to reach the page
    // as "all clear" rather than as "could not read".
    expect(parseDecisions('null', 0)).toEqual([]);
    expect(parseDecisions('', 0)).toEqual([]);
    expect(parseDecisions('  \n', 0)).toEqual([]);
  });

  test('a non-zero exit is no answer at all, and says so', () => {
    // Distinct from `[]`. The caller turns null into "could not read decisions"
    // and an empty array into "all clear"; collapsing them is the bug.
    expect(parseDecisions('', 1)).toBeNull();
    expect(parseDecisions(JSON.stringify([ROW]), 1)).toBeNull();
  });

  test('unparseable or unexpected output is no answer either', () => {
    for (const bad of ['not json', '{"error":"nope"}', '"string"', '42']) {
      expect(parseDecisions(bad, 0), bad).toBeNull();
    }
  });

  test('a row missing fields degrades to blanks rather than losing the row', () => {
    // A decision that renders oddly is still a decision someone has to see.
    const [d] = parseDecisions(JSON.stringify([{ id: 7 }]), 0)!;
    expect(d.id).toBe(7);
    expect(d.value).toBe('');
    expect(d.reason).toBe('');
  });

  test('several decisions all survive', () => {
    const rows = [ROW, { ...ROW, id: 2, value: '10.0.0.1' }, { ...ROW, id: 3, value: '10.0.0.2' }];
    expect(parseDecisions(JSON.stringify(rows), 0)!.map((d) => d.id)).toEqual([19983302, 2, 3]);
  });
});
