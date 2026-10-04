/**
 * Small, line-based edits to a manifest, so the New Application page can wire
 * an existing volume into it with one click.
 *
 * Line-based on purpose. The browser has no YAML library, and parsing then
 * re-serialising would throw away every comment and the user's formatting —
 * the example manifests are mostly comments. These functions understand just
 * enough block-style YAML to find a compose service and its `volumes:` list,
 * and return null for anything they do not recognise (flow style, anchors,
 * long-syntax lists they would have to rewrite), so the caller can fall back
 * to showing a snippet instead of mangling the file.
 */

interface Line {
  text: string;
  indent: number;
  /** Blank, or nothing but a comment. Never ends a block. */
  empty: boolean;
}

function lines(manifest: string): Line[] {
  return manifest.split('\n').map((text) => {
    const trimmed = text.trim();
    return {
      text,
      indent: text.length - text.trimStart().length,
      empty: trimmed === '' || trimmed.startsWith('#'),
    };
  });
}

const KEY = /^\s*("[^"]+"|'[^']+'|[A-Za-z0-9._-]+)\s*:\s*(#.*)?$/;

function keyOf(text: string): string | null {
  const m = KEY.exec(text);
  return m ? m[1].replace(/^["']|["']$/g, '') : null;
}

/** The index just past the last content line of the block that starts at `start`. */
function blockEnd(all: Line[], start: number, parentIndent: number): number {
  let end = start + 1;
  for (let i = start + 1; i < all.length; i++) {
    if (all[i].empty) continue;
    if (all[i].indent <= parentIndent) break;
    end = i + 1;
  }
  return end;
}

/**
 * The index just past a list that belongs to the key at `keyLine`. YAML allows
 * the items at the key's own indent (`volumes:\n- a:/b`), so a line at that
 * indent continues the list if it is an item and ends it if it is a sibling key.
 */
function listEnd(all: Line[], keyLine: number): number {
  const keyIndent = all[keyLine].indent;
  let end = keyLine + 1;
  for (let i = keyLine + 1; i < all.length; i++) {
    const l = all[i];
    if (l.empty) continue;
    if (l.indent > keyIndent || (l.indent === keyIndent && l.text.trimStart().startsWith('-'))) {
      end = i + 1;
      continue;
    }
    break;
  }
  return end;
}

interface ComposeService {
  name: string;
  line: number;
  indent: number;
  end: number;
}

function composeServices(all: Line[]): ComposeService[] {
  const at = all.findIndex((l) => l.indent === 0 && keyOf(l.text) === 'services');
  if (at === -1) return [];
  const end = blockEnd(all, at, 0);

  const first = all.slice(at + 1, end).find((l) => !l.empty);
  if (!first) return [];
  const indent = first.indent;

  const services: ComposeService[] = [];
  for (let i = at + 1; i < end; i++) {
    const l = all[i];
    if (l.empty || l.indent !== indent) continue;
    const name = keyOf(l.text);
    if (name) services.push({ name, line: i, indent, end: blockEnd(all, i, indent) });
  }
  return services;
}

/** The service names in a compose file, in declaration order. */
export function composeServiceNames(manifest: string): string[] {
  return composeServices(lines(manifest)).map((s) => s.name);
}

/** A short-syntax `- source:target[:mode]` entry, quoted or not. */
function shortVolume(text: string): { source: string; target: string; mode: string | null } | null {
  const m = /^\s*-\s*(["']?)([^"'#\s]+)\1\s*(#.*)?$/.exec(text);
  if (!m) return null;
  const [source, target, mode] = m[2].split(':');
  if (!target) return null;
  return { source, target, mode: mode ?? null };
}

/** Every short-syntax volume entry, so the page can spot a path a suggestion already fits. */
export function composeMounts(manifest: string): { service: string; source: string; target: string }[] {
  const all = lines(manifest);
  const out: { service: string; source: string; target: string }[] = [];
  for (const svc of composeServices(all)) {
    for (let i = svc.line + 1; i < svc.end; i++) {
      if (keyOf(all[i].text) !== 'volumes') continue;
      for (let j = i + 1; j < listEnd(all, i); j++) {
        const v = shortVolume(all[j].text);
        if (v) out.push({ service: svc.name, source: v.source, target: v.target });
      }
    }
  }
  return out;
}

/**
 * Mount `volume` at `target` in `service`, and declare it as external.
 *
 * An entry already mounting something at `target` is replaced — that is the
 * usual case, swapping the `./models` a template ships with for the volume
 * that already holds the models — and otherwise one is added. Returns null
 * when the file is not shaped in a way this can edit safely.
 */
export function useVolumeInCompose(
  manifest: string,
  service: string,
  volume: string,
  target: string,
  readOnly = false,
): string | null {
  const all = lines(manifest);
  const svc = composeServices(all).find((s) => s.name === service);
  if (!svc) return null;

  const firstProp = all.slice(svc.line + 1, svc.end).find((l) => !l.empty);
  const propIndent = firstProp ? firstProp.indent : svc.indent + 2;
  const entry = (indent: number, mode: string | null) =>
    `${' '.repeat(indent)}- ${volume}:${target}${readOnly ? ':ro' : mode ? `:${mode}` : ''}`;

  const out = all.map((l) => l.text);
  const volumesAt = all.findIndex(
    (l, i) => i > svc.line && i < svc.end && l.indent === propIndent && /^\s*volumes\s*:/.test(l.text),
  );

  if (volumesAt === -1) {
    out.splice(svc.end, 0, `${' '.repeat(propIndent)}volumes:`, entry(propIndent + 2, null));
  } else {
    // `volumes: [a:/b]` or anything else on the key's own line.
    if (keyOf(all[volumesAt].text) !== 'volumes') return null;
    const end = listEnd(all, volumesAt);
    const items = all.slice(volumesAt + 1, end).filter((l) => !l.empty);
    const itemIndent = items.find((l) => l.text.trimStart().startsWith('-'))?.indent ?? propIndent + 2;

    const existing = all.findIndex(
      (l, i) => i > volumesAt && i < end && shortVolume(l.text)?.target === target,
    );
    if (existing !== -1) {
      out[existing] = entry(all[existing].indent, shortVolume(all[existing].text)!.mode);
    } else {
      out.splice(end, 0, entry(itemIndent, null));
    }
  }

  return declareExternal(out.join('\n'), volume);
}

/**
 * Add `volume: { external: true }` under the top-level `volumes:` — what the
 * Compose spec says about a volume that exists already. Rudder ignores the
 * block, so this is for the reader and for the file working elsewhere too.
 */
function declareExternal(manifest: string, volume: string): string {
  const all = lines(manifest);
  const at = all.findIndex((l) => l.indent === 0 && /^volumes\s*:/.test(l.text));
  const declaration = (indent: number) => [
    `${' '.repeat(indent)}${volume}:`,
    `${' '.repeat(indent + 2)}external: true`,
  ];

  if (at === -1) {
    const trimmed = manifest.replace(/\s+$/, '');
    return `${trimmed}\n\nvolumes:\n${declaration(2).join('\n')}\n`;
  }
  // `volumes: {}` and friends: leave it alone rather than guess.
  if (keyOf(all[at].text) !== 'volumes') return manifest;

  const end = blockEnd(all, at, 0);
  const children = all.slice(at + 1, end).filter((l) => !l.empty);
  const indent = children[0]?.indent ?? 2;
  if (children.some((l) => l.indent === indent && keyOf(l.text) === volume)) return manifest;

  const out = all.map((l) => l.text);
  out.splice(end, 0, ...declaration(indent));
  return out.join('\n');
}

/** A DNS-label-safe name for the Pod-level volume entry. */
function k8sVolumeName(volume: string): string {
  const label = volume
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '');
  return label || 'data';
}

/**
 * The two pieces a Kubernetes manifest needs to mount `volume`: a
 * `volumeMounts` entry for the container and a `volumes` entry for the Pod.
 * Shown rather than inserted — a Deployment nests these deep enough that a
 * line-based edit would be guessing.
 */
export function k8sVolumeSnippet(volume: string, target: string, readOnly = false): string {
  const name = k8sVolumeName(volume);
  return [
    '# under the container:',
    'volumeMounts:',
    `  - name: ${name}`,
    `    mountPath: ${target}`,
    ...(readOnly ? ['    readOnly: true'] : []),
    '',
    '# under the Pod spec (template.spec for a Deployment):',
    'volumes:',
    `  - name: ${name}`,
    '    persistentVolumeClaim:',
    `      claimName: ${volume}`,
  ].join('\n');
}
