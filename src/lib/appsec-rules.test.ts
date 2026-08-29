/**
 * Telling CRS machinery apart from CRS signatures.
 *
 * Verified against alpha: excluding `930100` for one host removed exactly that
 * rule from the match and left the other eight; excluding `949110` produced no
 * alert at all. The second is not a narrower ruleset, it is no ruleset — and
 * `949110` is the id an operator is most likely to reach for, because it is the
 * one CrowdSec reports as having fired.
 */
import { describe, expect, test } from 'bun:test';
import { firstRuleRefusal, isAnomalyGate, metaRuleNote, ruleExclusionRefusal } from './appsec-rules';

describe('isAnomalyGate', () => {
  test('names the thresholds that switch CRS off wholesale', () => {
    expect(isAnomalyGate(949110)).toBe(true);
    expect(isAnomalyGate('949110')).toBe(true);
    expect(isAnomalyGate(959100)).toBe(true);
  });

  test('an ordinary signature is not a gate', () => {
    // These are the ones an exclusion is actually for.
    for (const id of [930100, 942100, 932130, 921150]) {
      expect(isAnomalyGate(id), String(id)).toBe(false);
    }
  });
});

describe('metaRuleNote', () => {
  test('explains why the gate is different, in the words shown on the chip', () => {
    expect(metaRuleNote(949110)).toContain('disables CRS');
  });

  test('covers setup and reporting rules, which are simply useless to exclude', () => {
    // 901340 is what a decision reports as `rule_name`, so it is the other id
    // people reach for by mistake.
    expect(metaRuleNote(901340)).toContain('not a signature');
    expect(metaRuleNote(980170)).toContain('not a signature');
  });

  test('says nothing about a real signature, so only the traps are flagged', () => {
    expect(metaRuleNote(930100)).toBeNull();
    expect(metaRuleNote(942100)).toBeNull();
  });
});

describe('ruleExclusionRefusal', () => {
  test('refuses the anomaly gate outright rather than warning about it', () => {
    // Not a confirmation dialog. Excluding 949110 gives up all protection for
    // an application in a form indistinguishable from giving up one signature,
    // and it is the id most likely to be reached for. The point of the whole
    // feature is to give up the least protection that solves the problem.
    const refusal = ruleExclusionRefusal(949110);
    expect(refusal).toContain('cannot be excluded');
    expect(refusal).toContain('switch the OWASP ruleset off');
  });

  test('tells the operator what to exclude instead', () => {
    // A refusal that does not name the alternative just moves the problem.
    expect(ruleExclusionRefusal(949110)).toContain('signatures that pushed the score over');
    expect(ruleExclusionRefusal(901340)).toContain('signatures listed alongside it');
  });

  test('refuses setup and reporting rules for the plainer reason', () => {
    expect(ruleExclusionRefusal(901340)).toContain('setup');
    expect(ruleExclusionRefusal(980170)).toContain('score reporting');
  });

  test('permits every ordinary signature', () => {
    for (const id of [930100, 930110, 930120, 932160, 932230, 942100]) {
      expect(ruleExclusionRefusal(id), String(id)).toBeNull();
    }
    // Named vpatch rules are signatures too.
    expect(ruleExclusionRefusal('crowdsecurity/vpatch-git-config')).toBeNull();
  });
});

describe('firstRuleRefusal', () => {
  test('catches a gate hidden among signatures', () => {
    // The realistic case: someone pastes the whole rule list off an alert.
    expect(firstRuleRefusal([930100, 942100, 949110])).toContain('949110');
  });

  test('a list of signatures passes', () => {
    expect(firstRuleRefusal([930100, 942100, 932130])).toBeNull();
    expect(firstRuleRefusal([])).toBeNull();
  });
});
