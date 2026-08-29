/**
 * Per-application AppSec rule exclusions.
 *
 * The failure these prevent is not a crash. A generated config that silently
 * excludes nothing leaves an operator believing they switched a rule off, and a
 * generated config that excludes too much turns the WAF off for an application
 * nobody meant to expose. Both are quiet, so they are what these assert on.
 */
import { describe, expect, test } from 'bun:test';
import {
  APPSEC_CONFIG_NAME,
  generateAppsecConfig,
  parseAppsecRules,
  parseRuleList,
  serializeAppsecRules,
} from './appsec';

describe('parseRuleList', () => {
  test('reads CRS numbers and hub rule names, in the order given', () => {
    expect(parseRuleList('942100, crowdsecurity/vpatch-git-config, 933180')).toEqual([
      942100,
      'crowdsecurity/vpatch-git-config',
      933180,
    ]);
  });

  test('an empty field excludes nothing', () => {
    expect(parseRuleList('')).toEqual([]);
    expect(parseRuleList('   ')).toEqual([]);
  });

  test('de-duplicates without reordering', () => {
    expect(parseRuleList('942100, 942100, 933180')).toEqual([942100, 933180]);
  });

  test('reads a tag, and keeps it marked as one', () => {
    // A tag and a rule name are both plain strings and no heuristic separates
    // them: `crowdsecurity/vpatch-git-config` is a name, `capec/1000/255` is a
    // tag, and both contain slashes. Hence the explicit prefix.
    expect(parseRuleList('tag:attack-lfi, 942100')).toEqual(['tag:attack-lfi', 942100]);
  });

  test('tolerates spacing around the prefix', () => {
    expect(parseRuleList('tag:attack-sqli')).toEqual(['tag:attack-sqli']);
    expect(parseRuleList('  tag:attack-sqli  ')).toEqual(['tag:attack-sqli']);
  });

  test('a tag with no value is rejected outright', () => {
    // `RemoveOutBandRuleByTag("")` would match nothing or everything depending
    // on the engine, and neither is what anybody meant to type. Rejected here
    // rather than reaching the refusal layer, so the field reports it as the
    // typo it is.
    expect(parseRuleList('tag:')).toBeNull();
    expect(parseRuleList('942100, tag:')).toBeNull();
  });

  test('rejects rather than silently dropping a malformed entry', () => {
    // The whole point: a typo must be reported, not read as "exclude nothing".
    // Someone who mistypes a rule id and is told nothing will believe the rule
    // is off and go on being banned by it.
    for (const bad of ['942100; 933180', 'rule 942100', '<script>', '942100,,,x!']) {
      expect(parseRuleList(bad), bad).toBeNull();
    }
  });

  test('rejects a number outside any plausible rule id', () => {
    expect(parseRuleList('0')).toBeNull();
    expect(parseRuleList('99999999999')).toBeNull();
  });
});

describe('parseAppsecRules / serializeAppsecRules', () => {
  test('round-trips', () => {
    const rules = [942100, 'crowdsecurity/vpatch-git-config'];
    expect(parseAppsecRules(serializeAppsecRules(rules))).toEqual(rules);
  });

  test('nothing excluded stores as null, not as "[]"', () => {
    expect(serializeAppsecRules([])).toBeNull();
    expect(serializeAppsecRules(null)).toBeNull();
    expect(serializeAppsecRules(undefined)).toBeNull();
  });

  test('a malformed row degrades to full protection, never to none', () => {
    // Failing open here would mean one bad row disables the WAF for an
    // application — the opposite of what the column is for.
    for (const bad of ['not json', '{"a":1}', '"942100"', 'null', '']) {
      expect(parseAppsecRules(bad), bad).toEqual([]);
    }
  });

  test('drops entries it cannot trust but keeps the ones it can', () => {
    expect(parseAppsecRules(JSON.stringify([942100, '', null, 'ok/rule', -5, '../etc/passwd']))).toEqual([
      942100,
      'ok/rule',
    ]);
  });
});

describe('generateAppsecConfig', () => {
  const one = { host: 'projectsend.gamma.apps.skoda-api.com', rules: [942100] };

  test('is a loadable config even when nothing is excluded', () => {
    // The acquisition references this config by name. If it vanished when the
    // last exclusion was removed, AppSec would fail to start at all.
    const yaml = generateAppsecConfig([]);
    expect(yaml).toContain(`name: ${APPSEC_CONFIG_NAME}`);
    expect(yaml).not.toContain('pre_eval:');
  });

  test('matches the host with and without a port', () => {
    // Requests on entryPoints 1443-4443 carry the port in the Host header, and
    // that is exactly where the API traffic needing exclusions lives. Matching
    // only the bare name would exclude nothing on those ports.
    const yaml = generateAppsecConfig([one]);
    expect(yaml).toContain("req.Host == 'projectsend.gamma.apps.skoda-api.com'");
    expect(yaml).toContain("req.Host startsWith 'projectsend.gamma.apps.skoda-api.com:'");
  });

  test('removes a numeric rule from both engines', () => {
    const yaml = generateAppsecConfig([one]);
    expect(yaml).toContain('RemoveInBandRuleByID(942100)');
    expect(yaml).toContain('RemoveOutBandRuleByID(942100)');
  });

  test('removes a named rule by name, not by id', () => {
    const yaml = generateAppsecConfig([
      { host: 'app.example.com', rules: ['crowdsecurity/vpatch-git-config'] },
    ]);
    expect(yaml).toContain('RemoveInBandRuleByName("crowdsecurity/vpatch-git-config")');
    expect(yaml).not.toContain('ByID');
  });

  test('one application excluding a rule does not exclude it for another', () => {
    const yaml = generateAppsecConfig([
      { host: 'a.example.com', rules: [942100] },
      { host: 'b.example.com', rules: [933180] },
    ]);
    // Each removal sits under its own host filter, so `b` keeps 942100.
    const aBlock = yaml.slice(yaml.indexOf("'a.example.com'"), yaml.indexOf("'b.example.com'"));
    expect(aBlock).toContain('942100');
    expect(aBlock).not.toContain('933180');
  });

  test('an application with no rules contributes no filter', () => {
    expect(generateAppsecConfig([{ host: 'a.example.com', rules: [] }])).not.toContain('pre_eval:');
  });

  test('removes a tag by tag, which is a different CrowdSec helper', () => {
    // Verified on a live worker: with this hook in place, a payload that
    // normally trips 930100, 930110, 930120, 932160, 932230 and 942100 came
    // back having tripped only the RCE and SQLi ones — the three LFI rules
    // were gone and nothing else was.
    const yaml = generateAppsecConfig([{ host: 'app.example.com', rules: ['tag:attack-lfi'] }]);
    expect(yaml).toContain('RemoveInBandRuleByTag("attack-lfi")');
    expect(yaml).toContain('RemoveOutBandRuleByTag("attack-lfi")');
    // Not ByName, which is what a rule name gets and would match nothing here.
    expect(yaml).not.toContain('ByName');
  });

  test('the prefix does not leak into the emitted tag', () => {
    const yaml = generateAppsecConfig([{ host: 'app.example.com', rules: ['tag:attack-sqli'] }]);
    expect(yaml).not.toContain('"tag:attack-sqli"');
  });

  test('mixes ids, tags and names in one filter', () => {
    const yaml = generateAppsecConfig([
      {
        host: 'app.example.com',
        rules: [942100, 'tag:attack-lfi', 'crowdsecurity/vpatch-git-config'],
      },
    ]);
    expect(yaml).toContain('RemoveOutBandRuleByID(942100)');
    expect(yaml).toContain('RemoveOutBandRuleByTag("attack-lfi")');
    expect(yaml).toContain('RemoveOutBandRuleByName("crowdsecurity/vpatch-git-config")');
  });

  test('never emits a hook for the anomaly gate, whatever the row says', () => {
    // Refused at every write path, and dropped again here. This function
    // decides what the WAF actually does, and one row holding 949110 — restored
    // from a backup, hand-edited, written by a caller that forgot to validate —
    // would silently disable CRS for that application. Verified on alpha:
    // excluding 949110 produced no alert at all, where excluding one signature
    // removed exactly that rule and left the other eight.
    const yaml = generateAppsecConfig([
      { host: 'app.example.com', rules: [949110, 901340, 980170, 930100] },
    ]);
    expect(yaml).not.toContain('949110');
    expect(yaml).not.toContain('901340');
    expect(yaml).not.toContain('980170');
    expect(yaml).toContain('RemoveOutBandRuleByID(930100)');
  });

  test('an application excluding only meta rules gets no filter at all', () => {
    // Not an empty `apply:` block, which would be invalid — and not a filter
    // that matches the host and removes nothing, which would be a lie.
    expect(generateAppsecConfig([{ host: 'app.example.com', rules: [949110] }]))
      .not.toContain('pre_eval:');
  });

  test('a host that is not a hostname is dropped, not interpolated', () => {
    // The filter is a quoted expr string. Nothing that reaches it is
    // user-controlled today, and this keeps it that way if that ever changes.
    const yaml = generateAppsecConfig([
      { host: "evil' || true || '", rules: [942100] },
      { host: 'good.example.com', rules: [942100] },
    ]);
    expect(yaml).not.toContain('evil');
    expect(yaml).toContain('good.example.com');
  });
});
