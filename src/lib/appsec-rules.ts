/**
 * CRS rules that are not signatures.
 *
 * Most CRS rules only *contribute* to an anomaly score. A handful are the
 * machinery around that score — initialisation, the threshold check, the
 * reporting — and excluding one of those is a categorically different act from
 * excluding a signature:
 *
 *   949110 is the only rule that enforces anything. Every other rule adds
 *   points; 949110 fires when the total crosses the threshold. Excluding it for
 *   a host does not narrow the ruleset for that host, it **turns CRS off** for
 *   it entirely.
 *
 * Verified on alpha: excluding 930100 for one host removed exactly that rule
 * from the match and left the other eight. Excluding 949110 produced no alert
 * at all.
 *
 * This is a real trap because 949110 is the id an operator is *most* likely to
 * reach for — it is the one CrowdSec reports as having fired, since it is the
 * one that did. Shipping a list of identical-looking chips would make the most
 * destructive choice the most obvious one.
 *
 * Shared rather than server-only: the warning belongs in the browser, at the
 * moment of the click.
 */
export const CRS_META_RULES: Record<string, string> = {
  '901340': 'CRS setup, not a signature — excluding it does nothing useful',
  '949110': 'the anomaly-score threshold — excluding it disables CRS for this application',
  '949111': 'the anomaly-score threshold — excluding it disables CRS for this application',
  '959100': 'the outbound anomaly-score threshold, not a signature',
  '980170': 'score reporting, not a signature — excluding it does nothing useful',
  '980130': 'score reporting, not a signature — excluding it does nothing useful',
};

/**
 * How a tag is written in the exclusion list: `tag:attack-lfi`.
 *
 * Explicit rather than inferred. A tag and a CrowdSec rule name are both plain
 * strings, and no heuristic separates them — `crowdsecurity/vpatch-git-config`
 * is a name, `capec/1000/255/153/126` is a tag, and both contain slashes.
 */
export const TAG_PREFIX = 'tag:';

/** The tag in `tag:attack-lfi`, or null when this entry is not a tag. */
export function tagOf(entry: string | number): string | null {
  const s = String(entry);
  return s.startsWith(TAG_PREFIX) ? s.slice(TAG_PREFIX.length) : null;
}

/**
 * Separates a rule from the source address it is excluded for:
 * `930100@178.209.129.231`.
 *
 * Safe as a separator because `@` appears in no CRS id, no CrowdSec rule name
 * and no CRS tag — the character set for all three is letters, digits and
 * `._/-`.
 */
export const SOURCE_SEPARATOR = '@';

/**
 * An IPv4 or IPv6 address, or a CIDR range. Nothing else.
 *
 * This value is interpolated into a single-quoted expr string in the generated
 * AppSec configuration, so the validation is what keeps a quote out of it. Only
 * hex digits, dots, colons and one slash can pass, none of which can end the
 * string early.
 */
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6 = /^[0-9A-Fa-f:]+$/;

export function isValidSource(value: string): boolean {
  const [addr, ...rest] = value.split('/');
  if (rest.length > 1) return false;

  const v4 = IPV4.exec(addr);
  if (v4) {
    if (v4.slice(1).some((o) => Number(o) > 255 || (o.length > 1 && o.startsWith('0')))) {
      return false;
    }
    if (rest.length === 1) {
      const bits = Number(rest[0]);
      if (!/^\d{1,2}$/.test(rest[0]) || bits > 32) return false;
    }
    return true;
  }

  // Loose on IPv6 shape and strict on its alphabet: an address CrowdSec
  // reported is one the engine will match, and the point of the check here is
  // that nothing which could break out of the quoting gets through.
  if (addr.includes(':') && IPV6.test(addr)) {
    if (rest.length === 1) {
      const bits = Number(rest[0]);
      if (!/^\d{1,3}$/.test(rest[0]) || bits > 128) return false;
    }
    return true;
  }

  return false;
}

/** Whether this source is a range rather than a single address. */
export function isSourceRange(source: string): boolean {
  return source.includes('/');
}

/**
 * `930100@1.2.3.4` → the rule and the address it is scoped to.
 *
 * `source` is null for the common case: the rule is excluded for this
 * application whoever sends the request.
 */
export function splitRuleSource(entry: string | number): { rule: string; source: string | null } {
  const s = String(entry);
  const at = s.indexOf(SOURCE_SEPARATOR);
  if (at === -1) return { rule: s, source: null };
  return { rule: s.slice(0, at), source: s.slice(at + 1) };
}

/** `930100` + `1.2.3.4` → `930100@1.2.3.4`; a null source gives the rule alone. */
export function joinRuleSource(rule: string | number, source?: string | null): string {
  return source ? `${rule}${SOURCE_SEPARATOR}${source}` : String(rule);
}

/**
 * Tags carried by every rule, or near enough.
 *
 * These are bookkeeping, not attack classes. Every CRS rule carries `OWASP_CRS`
 * and a `paranoia-level/N`, and the `-multi` tags are on almost all of them —
 * verified against the rules on a live worker, where `930100` carries
 * `application-multi`, `language-multi`, `platform-multi`, `attack-lfi`,
 * `paranoia-level/1` and `OWASP_CRS`.
 *
 * Excluding one of these disables CRS for an application wholesale while looking
 * like a narrow exclusion — the same trap as 949110, spelled differently. The
 * useful tags are the attack classes: `attack-lfi`, `attack-sqli`, `attack-rce`.
 */
function isBlanketTag(tag: string): boolean {
  const t = tag.toLowerCase();
  return (
    t === 'owasp_crs' ||
    t.startsWith('paranoia-level/') ||
    t === 'application-multi' ||
    t === 'language-multi' ||
    t === 'platform-multi'
  );
}

/** Whether excluding this rule switches CRS off for the host rather than narrowing it. */
export function isAnomalyGate(ruleId: string | number): boolean {
  const id = String(ruleId);
  return id === '949110' || id === '949111' || id === '959100';
}

/** Why this rule is not an ordinary signature, or null when it is one. */
export function metaRuleNote(ruleId: string | number): string | null {
  return CRS_META_RULES[String(ruleId)] ?? null;
}

/**
 * Why this rule may not be excluded, or null when it may.
 *
 * Refused rather than warned about. The point of per-application exclusions is
 * to give up the least protection that solves the problem — and excluding the
 * anomaly gate gives up all of it, for that application, in a form that looks
 * identical to giving up one signature. A confirmation dialog is not enough of
 * a control for that: 949110 is the id an operator is most likely to reach for,
 * because it is the one CrowdSec reports as having fired, and a dialog standing
 * between someone and the thing they came to click is a dialog they dismiss.
 *
 * The setup and reporting rules are refused for a plainer reason: excluding them
 * does not stop anything firing, so accepting one would leave someone believing
 * they had fixed something. 901340 in particular is what a *decision* reports as
 * `rule_name`, which makes it the most likely thing to be copied in by hand.
 *
 * An application that genuinely cannot live with CRS is a different decision,
 * deliberately not expressible as a rule id.
 */
export function ruleExclusionRefusal(ruleId: string | number): string | null {
  const { rule, source } = splitRuleSource(ruleId);

  if (source !== null) {
    if (!isValidSource(source)) {
      return (
        `"${source}" is not an address or range. Scope a rule to a source with ` +
        `930100@203.0.113.4 or 930100@203.0.113.0/24.`
      );
    }
    // The rule half is judged on its own terms. Narrowing an exclusion to one
    // address does not make the anomaly gate safe to exclude — it still means
    // "no CRS for this source", which is an allowlist entry wearing a rule id.
    return ruleExclusionRefusal(rule);
  }

  const id = rule;

  const tag = tagOf(id);
  if (tag !== null) {
    if (tag === '') return 'A tag exclusion needs a tag after "tag:", for example tag:attack-lfi.';
    if (isBlanketTag(tag)) {
      return (
        `Tag "${tag}" cannot be excluded: every CRS rule carries it, so excluding it would ` +
        `switch the ruleset off for this application rather than narrow it. Exclude an attack ` +
        `class instead — the tags that name one, such as attack-lfi or attack-sqli.`
      );
    }
    return null;
  }

  if (isAnomalyGate(id)) {
    return (
      `Rule ${id} cannot be excluded. It is not a signature — it is the anomaly-score ` +
      `threshold, and the only CRS rule that enforces anything, so excluding it would switch ` +
      `the OWASP ruleset off for this application entirely. Exclude the signatures that pushed ` +
      `the score over the threshold instead; they are listed alongside it on the worker's ` +
      `CrowdSec tab.`
    );
  }
  if (metaRuleNote(id)) {
    return (
      `Rule ${id} cannot be excluded: it is CRS ${id === '901340' ? 'setup' : 'score reporting'}, ` +
      `not a signature, so excluding it would not stop anything firing. The rules you want are ` +
      `the signatures listed alongside it on the worker's CrowdSec tab.`
    );
  }
  return null;
}

/** The first refusal among these rules, or null when every one is excludable. */
export function firstRuleRefusal(ruleIds: Array<string | number>): string | null {
  for (const id of ruleIds) {
    const refusal = ruleExclusionRefusal(id);
    if (refusal) return refusal;
  }
  return null;
}
