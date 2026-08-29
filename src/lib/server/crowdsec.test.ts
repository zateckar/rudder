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
import { decisionsFromExec, parseAppsecAlerts, parseDecisions } from './crowdsec';

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

/**
 * Judging a whole `cscli` run, not just its stdout.
 *
 * The tab reported "could not read decisions" on an occasional refresh with no
 * further detail, because a failed exec, a refusing cscli and unreadable output
 * all collapsed into one null. Two things came out of that: the reason now
 * travels to the page, and `exitCodeKnown` distinguishes a command that
 * succeeded from one whose status was never read back — the exec output and the
 * exit code come over two separate connections, and the second can fail alone.
 */
describe('decisionsFromExec', () => {
  const ok = { stdout: JSON.stringify([ALERT]), stderr: '', exitCode: 0, exitCodeKnown: true };

  test('a good run yields decisions and no error', () => {
    const read = decisionsFromExec(ok);
    expect(read.error).toBeNull();
    expect(read.decisions).toHaveLength(1);
  });

  test('output stands even when the exit code was never read back', () => {
    // The regression this exists for. `/exec/{id}/start` hijacks the
    // connection, so the follow-up status GET can lose a race with the worker
    // closing it — while 77KB of perfectly good JSON is already in hand.
    const read = decisionsFromExec({ ...ok, exitCodeKnown: false, exitCodeError: 'ECONNRESET' });
    expect(read.error).toBeNull();
    expect(read.decisions).toHaveLength(1);
  });

  test('but an unconfirmed empty result is not "all clear"', () => {
    // Nothing printed and no status: nothing was learned. Rendering this as an
    // empty list is the reassurance-without-an-answer bug returning.
    const read = decisionsFromExec({
      stdout: '',
      stderr: '',
      exitCode: 0,
      exitCodeKnown: false,
      exitCodeError: 'socket hang up',
    });
    expect(read.decisions).toEqual([]);
    expect(read.error).toContain('never confirmed');
    expect(read.error).toContain('socket hang up');
  });

  test('a confirmed empty result is "all clear"', () => {
    expect(decisionsFromExec({ stdout: 'null', stderr: '', exitCode: 0, exitCodeKnown: true }))
      .toEqual({ decisions: [], error: null });
  });

  test("cscli's own complaint is what the operator gets to read", () => {
    const read = decisionsFromExec({
      stdout: '',
      stderr: 'level=fatal msg="unable to query decisions: dial tcp 127.0.0.1:8080: connect: connection refused"',
      exitCode: 1,
      exitCodeKnown: true,
    });
    expect(read.decisions).toEqual([]);
    expect(read.error).toContain('connection refused');
  });

  test('a silent failure still says something', () => {
    const read = decisionsFromExec({ stdout: '', stderr: '', exitCode: 2, exitCodeKnown: true });
    expect(read.error).toContain('2');
  });

  test('output it cannot parse is named as such, not as a read failure', () => {
    const read = decisionsFromExec({
      stdout: '{"unexpected":"envelope"}',
      stderr: '',
      exitCode: 0,
      exitCodeKnown: true,
    });
    expect(read.decisions).toEqual([]);
    expect(read.error).toContain('could not parse');
  });

  test('treats a missing exitCodeKnown as known, for callers not passing it', () => {
    expect(decisionsFromExec({ stdout: 'null', stderr: '', exitCode: 0 }).error).toBeNull();
    expect(decisionsFromExec({ stdout: '', stderr: '', exitCode: 1 }).error).not.toBeNull();
  });
});

/**
 * Which rules actually fired.
 *
 * A decision cannot answer this. Its `rule_name` is the first id in the chain —
 * on a live worker, `native_rule:901340`, a CRS *initialisation* rule that does
 * nothing when disabled. Every fixture here is shaped from real production
 * output for that reason: the whole feature is worthless if it surfaces the
 * same misleading field the decisions table already did.
 */
const APPSEC_ALERT = {
  id: 10683,
  scenario: 'crowdsecurity/crowdsec-appsec-outofband',
  source: { scope: 'Ip', value: '178.209.129.231', cn: 'CZ' },
  events: [
    {
      meta: [
        { key: 'datasource_type', value: 'appsec' },
        { key: 'service', value: 'appsec' },
        { key: 'rule_ids', value: '[901340 911100 932130 942100 949110 980170]' },
        { key: 'rule_name', value: 'native_rule:901340' },
        { key: 'source_ip', value: '178.209.129.231' },
        { key: 'target_host', value: 'projectsend.gamma.apps.skoda-api.com' },
        { key: 'target_uri', value: '/uploads/01a04d01/parts/1?expires=1788000107&signature=5b3b' },
      ],
    },
  ],
};

/**
 * The *other* shape, and the more common one — copied from a live alert on
 * alpha. One event per rule, `target_fqdn` instead of `target_host`, a human
 * `message`, and **no `datasource_type` at all**, which is what the first
 * version of the parser filtered on. Gamma held 5 alerts of the shape above
 * and 350+ of this one, so that filter hid almost everything.
 */
const SCORED_ALERT = {
  scenario: 'anomaly score out-of-band: sql_injection: 10, lfi: 70, rce: 30, anomaly: 110, ',
  source: { scope: 'Ip', value: '20.166.29.62', cn: 'IE' },
  events: [
    {
      meta: [
        { key: 'rule_name', value: 'native_rule:901340' },
        { key: 'message', value: 'Enabling body inspection' },
        { key: 'uri', value: '/?id=1%27+OR+%271%27%3D%271&f=../../../etc/passwd' },
        { key: 'target_fqdn', value: 'routecheck.alpha.apps.skoda-api.com' },
      ],
    },
    {
      meta: [
        { key: 'rule_name', value: 'native_rule:930100' },
        { key: 'message', value: 'Path Traversal Attack (/../) or (/.../)' },
        { key: 'uri', value: '/?id=1%27+OR+%271%27%3D%271&f=../../../etc/passwd' },
        { key: 'target_fqdn', value: 'routecheck.alpha.apps.skoda-api.com' },
      ],
    },
    {
      meta: [
        { key: 'rule_name', value: 'native_rule:949110' },
        { key: 'message', value: 'Inbound Anomaly Score Exceeded' },
        { key: 'uri', value: '/?id=1%27+OR+%271%27%3D%271&f=../../../etc/passwd' },
        { key: 'target_fqdn', value: 'routecheck.alpha.apps.skoda-api.com' },
      ],
    },
  ],
};

describe('parseAppsecAlerts', () => {
  test('surfaces every rule that scored, not just the one CrowdSec names', () => {
    const [a] = parseAppsecAlerts(JSON.stringify([APPSEC_ALERT]), 0)!;
    expect(a.ruleIds).toEqual([901340, 911100, 932130, 942100, 949110, 980170]);
    // 949110 is "Inbound Anomaly Score Exceeded" — the one that actually fires.
    // It is reachable here and is not reachable from a decision at all.
    expect(a.ruleIds).toContain(949110);
  });

  test('carries the host and path that make a match judgeable', () => {
    const [a] = parseAppsecAlerts(JSON.stringify([APPSEC_ALERT]), 0)!;
    expect(a.host).toBe('projectsend.gamma.apps.skoda-api.com');
    expect(a.uri).toStartWith('/uploads/');
    expect(a.sourceIp).toBe('178.209.129.231');
  });

  test('collapses repeats of the same match', () => {
    // The same false positive fires on every request of its shape. Forty
    // identical rows would bury the one other thing that is happening.
    const many = [APPSEC_ALERT, APPSEC_ALERT, APPSEC_ALERT];
    expect(parseAppsecAlerts(JSON.stringify(many), 0)).toHaveLength(1);
  });

  test('ignores log-derived alerts, which have no rule to disable', () => {
    const probing = {
      scenario: 'crowdsecurity/http-probing',
      source: { value: '1.2.3.4' },
      events: [{ meta: [{ key: 'http_path', value: '/.env' }] }],
    };
    expect(parseAppsecAlerts(JSON.stringify([probing]), 0)).toEqual([]);
  });

  test('keeps a named rule when there are no numeric ids', () => {
    const vpatch = {
      events: [
        {
          meta: [
            { key: 'datasource_type', value: 'appsec' },
            { key: 'rule_name', value: 'crowdsecurity/vpatch-git-config' },
            { key: 'target_host', value: 'app.example.com' },
          ],
        },
      ],
    };
    const [a] = parseAppsecAlerts(JSON.stringify([vpatch]), 0)!;
    expect(a.ruleName).toBe('crowdsecurity/vpatch-git-config');
    expect(a.ruleIds).toEqual([]);
  });

  test('no answer stays distinct from no alerts', () => {
    expect(parseAppsecAlerts('', 1)).toBeNull();
    expect(parseAppsecAlerts('not json', 0)).toBeNull();
    expect(parseAppsecAlerts('null', 0)).toEqual([]);
  });

  describe('the one-event-per-rule shape', () => {
    test('is recognised at all, despite carrying no datasource_type', () => {
      // The regression. Filtering on `datasource_type === "appsec"` dropped
      // every alert of this shape, which on a live worker was 350 of 355.
      expect(parseAppsecAlerts(JSON.stringify([SCORED_ALERT]), 0)).toHaveLength(1);
    });

    test('folds nine events for one request into one row', () => {
      const [a] = parseAppsecAlerts(JSON.stringify([SCORED_ALERT]), 0)!;
      expect(a.host).toBe('routecheck.alpha.apps.skoda-api.com');
      expect(a.ruleIds).toEqual([901340, 930100, 949110]);
    });

    test('keeps what each rule is for, which is the whole point of showing it', () => {
      // "930100" is a number to look up. "Path Traversal Attack" is a decision
      // someone can actually make about their own application.
      const [a] = parseAppsecAlerts(JSON.stringify([SCORED_ALERT]), 0)!;
      expect(a.ruleMessages['930100']).toBe('Path Traversal Attack (/../) or (/.../)');
      expect(a.ruleMessages['949110']).toBe('Inbound Anomaly Score Exceeded');
    });

    test('falls back to the alert source for the address', () => {
      const [a] = parseAppsecAlerts(JSON.stringify([SCORED_ALERT]), 0)!;
      expect(a.sourceIp).toBe('20.166.29.62');
    });

    test('separates two hosts inside one alert', () => {
      const mixed = {
        ...SCORED_ALERT,
        events: [
          SCORED_ALERT.events[1],
          {
            meta: [
              { key: 'rule_name', value: 'native_rule:942100' },
              { key: 'target_fqdn', value: 'other.example.com' },
            ],
          },
        ],
      };
      const rows = parseAppsecAlerts(JSON.stringify([mixed]), 0)!;
      expect(rows.map((r) => [r.host, r.ruleIds])).toEqual([
        ['routecheck.alpha.apps.skoda-api.com', [930100]],
        ['other.example.com', [942100]],
      ]);
    });
  });
});
