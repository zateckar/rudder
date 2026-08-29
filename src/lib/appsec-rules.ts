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
