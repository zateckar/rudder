/**
 * Reading CrowdSec's decisions.
 *
 * Two mistakes are recorded here because both shipped. The first: reporting an
 * empty list when the question could not be asked, which the page rendered as
 * "all clear" while three bans were live — one of them on the operator reading
 * it. The second: reading `cscli decisions list -o json` as a flat list of
 * decisions when it is a list of *alerts*, each carrying the decisions it
 * produced. `scenario` exists at both levels, so that version looked half-right —
 * Reason filled in, everything else blank — and the id it took was the alert's,
 * which would have deleted the wrong row.
 */
import { describe, expect, test } from 'bun:test';
import { parseDecisions } from './crowdsec';

/** An alert shaped the way a live worker really emits it. */
const ALERT = {
  id: 10657,
  scenario: 'crowdsecurity/http-probing',
  source: {
    as_name: 'GOOGLE-CLOUD-PLATFORM',
    as_number: '396982',
    cn: 'IT',
    ip: '34.17.159.73',
    scope: 'Ip',
    value: '34.17.159.73',
  },
  decisions: [
    {
      duration: '3h58m7s',
      id: 19998305,
      origin: 'crowdsec',
      scenario: 'crowdsecurity/http-probing',
      scope: 'Ip',
      simulated: false,
      type: 'ban',
      value: '34.17.159.73',
    },
  ],
  events: [{ meta: [{ key: 'http_path', value: '/www/.git/config' }] }],
};

describe('parseDecisions', () => {
  test('fills every column the table shows', () => {
    // The regression this exists for: Reason alone populated, because it is the
    // one field that also exists on the alert.
    expect(parseDecisions(JSON.stringify([ALERT]), 0)).toEqual([
      {
        id: 19998305,
        source: 'crowdsec',
        scope: 'Ip',
        value: '34.17.159.73',
        reason: 'crowdsecurity/http-probing',
        type: 'ban',
        duration: '3h58m7s',
        country: 'IT',
        asName: 'GOOGLE-CLOUD-PLATFORM',
      },
    ]);
  });

  test('takes the decision id, not the alert id', () => {
    // Both are called `id` at different levels of one document. The alert's is a
    // plausible number that `cscli decisions delete --id` will not match.
    const [d] = parseDecisions(JSON.stringify([ALERT]), 0)!;
    expect(d.id).toBe(19998305);
    expect(d.id).not.toBe(ALERT.id);
  });

  test('flattens several decisions from one alert', () => {
    const alert = {
      ...ALERT,
      decisions: [
        { ...ALERT.decisions[0], id: 1, value: '10.0.0.1' },
        { ...ALERT.decisions[0], id: 2, value: '10.0.0.2' },
      ],
    };
    expect(parseDecisions(JSON.stringify([alert]), 0)!.map((d) => [d.id, d.value])).toEqual([
      [1, '10.0.0.1'],
      [2, '10.0.0.2'],
    ]);
  });

  test('an alert that banned nothing contributes no rows', () => {
    expect(parseDecisions(JSON.stringify([{ ...ALERT, decisions: [] }]), 0)).toEqual([]);
  });

  test('falls back to the alert source when a decision omits its own', () => {
    const alert = { ...ALERT, decisions: [{ id: 5, origin: 'cscli', type: 'ban', duration: '1h' }] };
    const [d] = parseDecisions(JSON.stringify([alert]), 0)!;
    expect(d.value).toBe('34.17.159.73');
    expect(d.reason).toBe('crowdsecurity/http-probing');
  });

  test('reads a flat decision list too, recognised by shape not by version', () => {
    // So a cscli upgrade that changes the envelope cannot quietly empty the
    // table — the failure mode this whole file exists because of.
    const flat = [{ id: 42, origin: 'cscli', scope: 'Ip', value: '1.2.3.4', type: 'ban', duration: '4h', scenario: 'manual' }];
    expect(parseDecisions(JSON.stringify(flat), 0)).toEqual([
      {
        id: 42,
        source: 'cscli',
        scope: 'Ip',
        value: '1.2.3.4',
        reason: 'manual',
        type: 'ban',
        duration: '4h',
        country: '',
        asName: '',
      },
    ]);
  });

  test('`null` from cscli is an answer meaning none, not a failure', () => {
    // What an actually-clear worker prints. It has to reach the page as
    // "all clear" rather than as "could not read".
    expect(parseDecisions('null', 0)).toEqual([]);
    expect(parseDecisions('', 0)).toEqual([]);
    expect(parseDecisions('  \n', 0)).toEqual([]);
  });

  test('a non-zero exit is no answer at all, and says so', () => {
    // Distinct from `[]`. The caller turns null into "could not read decisions"
    // and an empty array into "all clear"; collapsing them is the original bug.
    expect(parseDecisions('', 1)).toBeNull();
    expect(parseDecisions(JSON.stringify([ALERT]), 1)).toBeNull();
  });

  test('unparseable or unexpected output is no answer either', () => {
    for (const bad of ['not json', '{"error":"nope"}', '"string"', '42']) {
      expect(parseDecisions(bad, 0), bad).toBeNull();
    }
  });
});
