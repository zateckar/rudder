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
import {
  firstRuleRefusal,
  isAnomalyGate,
  metaRuleNote,
  ruleExclusionRefusal,
  tagOf,
} from './appsec-rules';

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

describe('tag exclusions', () => {
  test('an attack class is a legitimate thing to exclude', () => {
    // The case this exists for: an upload endpoint whose signed URLs read as
    // path traversal needs the class, not three ids that stop covering it the
    // day CRS adds a fourth rule.
    expect(ruleExclusionRefusal('tag:attack-lfi')).toBeNull();
    expect(ruleExclusionRefusal('tag:attack-sqli')).toBeNull();
    expect(ruleExclusionRefusal('tag:capec/1000/255/153/126')).toBeNull();
  });

  test('refuses the tags every rule carries — the same trap as 949110', () => {
    // Verified against a live worker, where 930100 carries application-multi,
    // language-multi, platform-multi, attack-lfi, paranoia-level/1 and
    // OWASP_CRS. Excluding any of the blanket ones disables CRS for the
    // application while looking like a narrow exclusion.
    for (const tag of [
      'tag:OWASP_CRS',
      'tag:paranoia-level/1',
      'tag:paranoia-level/4',
      'tag:application-multi',
      'tag:language-multi',
      'tag:platform-multi',
    ]) {
      expect(ruleExclusionRefusal(tag), tag).toContain('cannot be excluded');
    }
  });

  test('the refusal is case-insensitive, so the trap cannot be typed around', () => {
    expect(ruleExclusionRefusal('tag:owasp_crs')).not.toBeNull();
    expect(ruleExclusionRefusal('tag:Paranoia-Level/2')).not.toBeNull();
  });

  test('a narrow language or platform tag is still allowed', () => {
    // Only the `-multi` catch-alls are blanket. Turning off the PHP rules for
    // an application that is not PHP is a reasonable, narrow thing to want.
    expect(ruleExclusionRefusal('tag:language-php')).toBeNull();
    expect(ruleExclusionRefusal('tag:platform-windows')).toBeNull();
  });

  test('a tag with nothing after the prefix is refused', () => {
    expect(ruleExclusionRefusal('tag:')).toContain('needs a tag after');
  });

  test('tagOf tells a tag from a rule name that merely looks like one', () => {
    expect(tagOf('tag:attack-lfi')).toBe('attack-lfi');
    // Both contain slashes; only the prefix separates them.
    expect(tagOf('crowdsecurity/vpatch-git-config')).toBeNull();
    expect(tagOf(942100)).toBeNull();
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

  test('catches a blanket tag hidden among good entries', () => {
    expect(firstRuleRefusal([930100, 'tag:attack-lfi', 'tag:OWASP_CRS'])).toContain('OWASP_CRS');
  });

  test('ids and tags together pass when each is narrow', () => {
    expect(firstRuleRefusal([930100, 'tag:attack-lfi', 'crowdsecurity/vpatch-git-config']))
      .toBeNull();
  });
});
