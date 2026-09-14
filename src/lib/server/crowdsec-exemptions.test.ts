/**
 * Worker-level CrowdSec exemptions.
 *
 * The shapes here are copied from a live worker rather than invented, including
 * the two that decide whether the tab tells the truth: a missing allowlist,
 * which is the normal state of a worker nobody has exempted anything on and must
 * read as "none" rather than as a failure, and CrowdSec's zero time, which is how
 * it spells "no expiry" and renders as the year 1 if passed through.
 */
import { describe, expect, test } from 'bun:test';
import {
  EXEMPTION_LIST,
  decisionsLifted,
  exemptionCommands,
  exemptionRefusal,
  exemptionsFromExec,
  listAlreadyExists,
  normaliseComment,
  parseExemptions,
} from './crowdsec-exemptions';

/** `cscli allowlists inspect rudder-exemptions -o json`, as gamma returned it. */
const INSPECT = JSON.stringify({
  created_at: '2026-09-14T18:03:19.842Z',
  description: 'Addresses exempted from CrowdSec decisions, managed by Rudder',
  items: [
    {
      created_at: '2026-09-14T18:03:24.069Z',
      description: 'alpha worker egress (apim-gw)',
      expiration: '0001-01-01T00:00:00.000Z',
      value: '20.166.29.62',
    },
  ],
  name: 'rudder-exemptions',
  updated_at: '2026-09-14T18:03:24.070Z',
});

describe('parseExemptions', () => {
  test('reads the items of an allowlist', () => {
    const rows = parseExemptions(INSPECT, 0)!;
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe('20.166.29.62');
    expect(rows[0].comment).toBe('alpha worker egress (apim-gw)');
    expect(rows[0].createdAt).toBe('2026-09-14T18:03:24.069Z');
  });

  test("CrowdSec's zero time means never, not the year 1", () => {
    // Passed through verbatim this renders as 01/01/0001, which reads as an
    // exemption that lapsed two millennia ago — the opposite of what it means.
    expect(parseExemptions(INSPECT, 0)![0].expiresAt).toBe('');
  });

  test('a real expiry is kept', () => {
    const withExpiry = JSON.stringify({
      items: [{ value: '203.0.113.4', description: '', expiration: '2026-09-15T18:03:24.069Z' }],
    });
    expect(parseExemptions(withExpiry, 0)![0].expiresAt).toBe('2026-09-15T18:03:24.069Z');
  });

  test('an empty list is an answer; a failed command is not', () => {
    expect(parseExemptions(JSON.stringify({ items: [] }), 0)).toEqual([]);
    expect(parseExemptions(INSPECT, 1)).toBeNull();
    expect(parseExemptions('<html>502</html>', 0)).toBeNull();
    // A decisions list where an allowlist was expected: right JSON, wrong shape.
    expect(parseExemptions('[{"id":1}]', 0)).toBeNull();
  });
});

describe('exemptionsFromExec', () => {
  test('a missing allowlist reads as none, not as a failure', () => {
    // The normal state of a worker nobody has exempted anything on. Reported as
    // an error it would put a red box on every untouched worker's tab.
    const read = exemptionsFromExec({
      stdout: '',
      stderr: "Error: cscli allowlists inspect: unable to get allowlist: API error: allowlist 'rudder-exemptions' not found",
      exitCode: 1,
    });
    expect(read.error).toBeNull();
    expect(read.exemptions).toEqual([]);
  });

  test('a real failure keeps cscli own words', () => {
    const read = exemptionsFromExec({
      stdout: '',
      stderr: 'Error: unable to connect to LAPI: connection refused',
      exitCode: 1,
    });
    expect(read.exemptions).toEqual([]);
    expect(read.error).toContain('connection refused');
  });

  test('an unconfirmed exit with no output is not an empty list', () => {
    // Otherwise a worker that never answered reports "nothing is exempt here",
    // which is a claim about its security posture that nobody verified.
    const read = exemptionsFromExec({
      stdout: '',
      stderr: '',
      exitCode: 0,
      exitCodeKnown: false,
      exitCodeError: 'socket hang up',
    });
    expect(read.error).toContain('never confirmed');
  });

  test('the happy path', () => {
    const read = exemptionsFromExec({ stdout: INSPECT, stderr: '', exitCode: 0 });
    expect(read.error).toBeNull();
    expect(read.exemptions[0].value).toBe('20.166.29.62');
  });
});

describe('exemptionRefusal', () => {
  test('accepts an address or a reasonable range', () => {
    expect(exemptionRefusal('20.166.29.62')).toBeNull();
    expect(exemptionRefusal('203.0.113.0/24')).toBeNull();
    expect(exemptionRefusal('10.0.0.0/16')).toBeNull();
    expect(exemptionRefusal('2001:db8::1')).toBeNull();
    expect(exemptionRefusal('2001:db8::/48')).toBeNull();
  });

  test('refuses anything that is not an address', () => {
    expect(exemptionRefusal('')).toContain('needs an address');
    expect(exemptionRefusal('alpha.apps.skoda-api.com')).toContain('not an address');
    expect(exemptionRefusal('20.166.29.62 OR 1=1')).toContain('not an address');
  });

  test('refuses a range wide enough to switch CrowdSec off', () => {
    // The same trap as excluding rule 949110: it looks like one ordinary row in
    // a table and it disables the control for every application on the worker.
    expect(exemptionRefusal('0.0.0.0/0')).toContain('every address on the internet');
    expect(exemptionRefusal('10.0.0.0/8')).toContain('cannot be exempted');
    expect(exemptionRefusal('::/0')).toContain('cannot be exempted');
    expect(exemptionRefusal('2001:db8::/16')).toContain('cannot be exempted');
  });

  test('the refusal says what to do instead', () => {
    expect(exemptionRefusal('10.0.0.0/8')).toContain('/16 or narrower');
  });
});

describe('normaliseComment', () => {
  test('collapses whitespace and bounds the length', () => {
    expect(normaliseComment('  alpha   egress\n(apim-gw) ')).toBe('alpha egress (apim-gw)');
    expect(normaliseComment(null)).toBe('');
    expect(normaliseComment('x'.repeat(500))).toHaveLength(200);
  });
});

describe('exemptionCommands', () => {
  test('every command names the same list', () => {
    for (const cmd of [
      exemptionCommands.read(),
      exemptionCommands.create(),
      exemptionCommands.add('203.0.113.4', 'why'),
      exemptionCommands.remove('203.0.113.4'),
    ]) {
      expect(cmd).toContain(EXEMPTION_LIST);
    }
  });

  test('a blank comment is omitted rather than sent empty', () => {
    // `-d ''` records a blank description, which is indistinguishable from an
    // entry somebody added by hand outside Rudder.
    expect(exemptionCommands.add('203.0.113.4', '')).toEqual([
      'cscli', 'allowlists', 'add', EXEMPTION_LIST, '203.0.113.4',
    ]);
    expect(exemptionCommands.add('203.0.113.4', 'alpha')).toContain('-d');
  });
});

describe('listAlreadyExists', () => {
  test('recognises the normal path of a second add', () => {
    // The list is created on every add, so this failure is expected on all but
    // the first and must not surface as an error.
    expect(
      listAlreadyExists({ stdout: '', stderr: "Error: allowlist 'rudder-exemptions' already exists" }),
    ).toBe(true);
    expect(listAlreadyExists({ stdout: '', stderr: 'Error: unable to connect to LAPI' })).toBe(false);
  });
});

describe('decisionsLifted', () => {
  test('reads how many bans the add cleared', () => {
    // The evidence that the loop has actually stopped: on the worker this came
    // from, one add reported 32.
    expect(decisionsLifted('added 1 values to allowlist rudder-exemptions\n32 decisions deleted by allowlists')).toBe(32);
    expect(decisionsLifted('1 decisions deleted by allowlists')).toBe(1);
    expect(decisionsLifted('added 1 values to allowlist rudder-exemptions')).toBeNull();
  });
});
