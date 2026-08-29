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
import { isAnomalyGate, metaRuleNote } from './appsec-rules';

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
