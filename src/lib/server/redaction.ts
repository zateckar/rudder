/**
 * Keeping secret material out of places that only need to *describe* it: the
 * copy of container labels Rudder stores, and the provisioning output it logs.
 *
 * Both are pure string transforms with no dependencies, so the patterns are
 * tested directly rather than by deploying something and grepping a log.
 *
 * ── Container labels ───────────────────────────────────────────────────────
 *
 * In `labels` routing mode, per-application OIDC settings are stamped into
 * container labels for Traefik's docker provider — including the plugin's
 * session `Secret` and the IdP `ClientSecret`. Those labels were then stored
 * verbatim in `containers.labels`, putting two credentials in plaintext in
 * Rudder's own database next to their encrypted originals in `applications`.
 *
 * The labels sent to Podman are unchanged: Traefik has to read them for
 * authentication to work at all. What changes is what Rudder keeps. The stored
 * copy exists for display and for the discovery/reconcile paths, none of which
 * need the value — and a redacted marker is more useful there than the secret,
 * because it shows the label exists without publishing it.
 *
 * Worth noting: in `http` routing mode these labels are never created, so the
 * secret is not on the worker's containers either. That is one more reason the
 * routing-mode migration is a security improvement and not only a
 * deploy-ergonomics one.
 */

export const REDACTED = '__redacted__';

/**
 * Label keys whose values are credentials.
 *
 * Matched case-insensitively on the trailing segment, because the plugin's
 * label namespace is capitalised (`…plugin.traefik-oidc-auth.Secret`) while
 * Traefik's own keys are not, and both spellings appear in fixtures.
 */
const SECRET_LEAF_KEYS = new Set([
  'secret',
  'clientsecret',
  'password',
  'apikey',
  'token',
]);

/** Does this label key hold a credential? */
export function isSecretLabel(key: string): boolean {
  const leaf = key.split('.').pop() ?? '';
  return SECRET_LEAF_KEYS.has(leaf.toLowerCase());
}

/**
 * A copy of `labels` with credential values replaced.
 *
 * Returns a new object; the input is never mutated, so the caller can pass the
 * same map to Podman afterwards.
 */
export function redactSecretLabels(labels: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    out[key] = isSecretLabel(key) ? REDACTED : value;
  }
  return out;
}

// ── Provisioning output ──────────────────────────────────────────────────────

/**
 * Lines the provisioning script prints so the control plane can capture them.
 *
 * The script echoes the mTLS client key and the CrowdSec bouncer key to stdout
 * — that is how they reach the database — and the provisioning handler logs the
 * tail of that stdout for diagnostics. Which means a routine provisioning run
 * writes a worker's root-equivalent private key into the application log, where
 * it long outlives the encrypted copy in the database and is readable by
 * anyone with log access.
 *
 * Values are replaced, not lines dropped: seeing that `CLIENT_KEY_B64` was
 * present is the diagnostically useful part, and the value never is.
 */
const SECRET_OUTPUT_KEYS = [
  'CLIENT_KEY_B64',
  'CA_CERT_B64',
  'CLIENT_CERT_B64',
  'BOUNCER_KEY',
  'CONFIG_TOKEN',
];

/**
 * Mask credentials in captured provisioning output before it is logged.
 *
 * Handles the `KEY=value` lines above and any inline PEM private key, which can
 * reach the log through a shell trace or an error message rather than through
 * one of the known markers.
 */
export function redactProvisioningOutput(output: string): string {
  let out = output;

  for (const key of SECRET_OUTPUT_KEYS) {
    out = out.replace(new RegExp(`^(${key}=).+$`, 'gm'), `$1${REDACTED}`);
  }

  // Non-greedy and multiline: several keys in one capture must each collapse,
  // rather than the first BEGIN and last END swallowing everything between.
  out = out.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    `-----BEGIN PRIVATE KEY----- ${REDACTED} -----END PRIVATE KEY-----`,
  );

  return out;
}
