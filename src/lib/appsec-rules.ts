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
  const id = String(ruleId);
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
