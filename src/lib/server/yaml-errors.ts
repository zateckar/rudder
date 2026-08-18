/**
 * Turning a YAML failure into something a person can act on.
 *
 * `Bun.YAML.parse` throws a `SyntaxError` whose message is already prefixed
 * ("YAML Parse error: Unexpected token") and whose `line`/`column` refer to the
 * call site in the compiled JavaScript, not to a position in the document. A
 * caller that prefixed it again produced
 *
 *     YAML parse error: YAML Parse error: Unexpected token
 *
 * which says the same thing twice and does not say where. Since the parser will
 * not tell us where, we find out by asking it: feed it one line more at a time
 * and note the first line whose addition breaks it.
 */

/**
 * A first, cheap cut, before the document's width is even looked at.
 *
 * Rarely the binding limit — `MAX_LOCATE_CHARS` below bites first for anything
 * but a document of thousands of near-empty lines — but it costs one comparison
 * and bounds the *number* of parser calls, which the character budget only
 * bounds indirectly. Call count matters on its own: 1000 parses of a 40 kB
 * document measured slower than 500 parses of a 100 kB one.
 */
const MAX_LINES_TO_LOCATE = 2000;

/**
 * How many characters the scan below may hand to the parser in total.
 *
 * The search is quadratic: one parse per line, over a prefix that grows each
 * time, so the work is roughly `lines × length / 2` — not `length`. A line cap
 * alone does not bound that, because a document under it can still be wide: a
 * 2000-line manifest failing only on its last line measured just over a second
 * of synchronous parsing, and Bun serves every other request on the same thread.
 *
 * 4 M measures around 50 ms, and still locates the failure in any manifest a
 * person wrote by hand — roughly 500 lines of ordinary width, or a much wider
 * document with fewer. Past that the message says what went wrong without saying
 * where, which is what it did before this module existed.
 */
const MAX_LOCATE_CHARS = 4_000_000;

/** Strip the parser's own prefix so a caller can add its own context once. */
export function bareYamlMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^YAML\s+Parse\s+error:\s*/i, '').trim() || 'invalid YAML';
}

/**
 * The 1-based line the document first stops parsing at, or null if that cannot
 * be narrowed down.
 *
 * Approximate by construction: a failure inside a construct that spans several
 * lines — an unclosed flow sequence, say — is reported at the line the construct
 * opens on, not the line the author would have called wrong. That is still the
 * right place to look, which is why the wording below says "near".
 */
export function firstFailingLine(manifest: string): number | null {
  const lines = manifest.split('\n');
  if (lines.length > MAX_LINES_TO_LOCATE) return null;
  // Worst case is every line parsed against a prefix averaging half the
  // document, which is what this bounds.
  if ((lines.length * manifest.length) / 2 > MAX_LOCATE_CHARS) return null;

  for (let i = 0; i < lines.length; i++) {
    const prefix = lines.slice(0, i + 1).join('\n');
    try {
      Bun.YAML.parse(prefix);
    } catch {
      return i + 1;
    }
  }
  return null;
}

/**
 * A hint about what tends to cause this, when the text of the line gives it
 * away. Only for mistakes that are both common and invisible on screen.
 */
function hintFor(line: string | undefined): string | null {
  if (!line) return null;
  if (/^\s*\t/.test(line) || /\t/.test(line.slice(0, line.search(/\S/) + 1))) {
    return 'YAML does not allow tab characters for indentation — use spaces.';
  }
  const quotes = (line.match(/"/g) ?? []).length;
  if (quotes % 2 === 1) return 'There is an unclosed double quote on this line.';
  const singles = (line.match(/'/g) ?? []).length;
  if (singles % 2 === 1) return 'There is an unclosed single quote on this line.';
  return null;
}

/**
 * One sentence naming what went wrong and where, for showing to whoever wrote
 * the manifest.
 *
 * `lineOffset` shifts the reported line, for callers that split a multi-document
 * manifest on `---` and parse the fragments: the author counts lines from the
 * top of the file they wrote, not from the top of the fragment.
 */
export function describeYamlError(manifest: string, error: unknown, lineOffset = 0): string {
  const what = bareYamlMessage(error);
  const line = firstFailingLine(manifest);
  if (line === null) return `YAML parse error: ${what}`;

  const text = manifest.split('\n')[line - 1];
  const hint = hintFor(text);
  const excerpt = text?.trim();

  return (
    `YAML parse error near line ${line + lineOffset}: ${what}.` +
    (excerpt ? ` The line reads: ${excerpt}` : '') +
    (hint ? ` ${hint}` : '')
  );
}

/**
 * Parse a manifest that may hold several documents separated by `---`.
 *
 * Throws a plain `Error` whose message locates the failure in the whole file.
 * Callers that need a `ManifestError` should wrap it — this module deliberately
 * knows nothing about the deployment layer.
 */
export function parseYamlDocuments(manifest: string): unknown[] {
  const docs: unknown[] = [];
  let lineOffset = 0;

  for (const fragment of manifest.split('---')) {
    try {
      const parsed = Bun.YAML.parse(fragment);
      if (parsed) docs.push(parsed);
    } catch (e) {
      throw new Error(describeYamlError(fragment, e, lineOffset));
    }
    // The separator itself sits between fragments and consumes no newline.
    lineOffset += fragment.split('\n').length - 1;
  }

  return docs;
}
