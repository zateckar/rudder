import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const toolchain = readFileSync(join(root, 'formal', 'lean-toolchain'), 'utf8').trim();
const pinned = /^leanprover\/lean4:v(\d+\.\d+\.\d+)$/.exec(toolchain)?.[1];
if (!pinned) throw new Error('Unrecognized formal/lean-toolchain pin');
const model = join(root, 'formal', 'Lifecycle.lean');
const source = readFileSync(model, 'utf8');
// Warnings and the dependency audit below also catch implicit proof holes.
if (/\b(sorry|admit|axiom|native_decide|unsafe)\b/.test(source)) {
  throw new Error('The formal model must not contain proof holes, custom axioms, or unchecked execution');
}

const executableName = process.platform === 'win32' ? 'lean.exe' : 'lean';
const elanHome = process.env.ELAN_HOME || join(homedir(), '.elan');
function isElanShim(candidate: string): boolean {
  const normalized = resolve(candidate).toLowerCase();
  return normalized === resolve(elanHome, 'bin', executableName).toLowerCase() ||
    existsSync(join(dirname(candidate), process.platform === 'win32' ? 'elan.exe' : 'elan'));
}
const candidates: string[] = [];
if (process.env.LEAN_BIN) {
  const explicit = Bun.which(process.env.LEAN_BIN) || process.env.LEAN_BIN;
  if (isElanShim(explicit)) throw new Error('LEAN_BIN must identify a toolchain binary, not an elan shim');
  candidates.push(explicit);
} else {
  // Read existing toolchains directly if the elan shim is misconfigured. This
  // neither installs a toolchain nor modifies the user's global elan settings.
  try {
    for (const entry of readdirSync(join(elanHome, 'toolchains'))) {
      const candidate = join(elanHome, 'toolchains', entry, 'bin', executableName);
      if (existsSync(candidate)) candidates.push(candidate);
    }
  } catch { /* An elan installation is optional when LEAN_BIN or PATH works. */ }
  const onPath = Bun.which('lean');
  // An elan shim can download a selected toolchain even for --version. Never
  // execute it during discovery; use an existing toolchain binary instead.
  if (onPath && !isElanShim(onPath)) candidates.push(onPath);
}

let lean: string | undefined;
for (const candidate of candidates) {
  const version = Bun.spawnSync([candidate, '--version'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (version.exitCode === 0 && /Lean \(version ([\d.]+)/.exec(version.stdout.toString())?.[1] === pinned) {
    lean = candidate;
    break;
  }
}
if (!lean) throw new Error(`Lean ${pinned} is required. Install the pinned toolchain or set LEAN_BIN to its executable.`);
console.log(`Checking lifecycle model with Lean ${pinned}`);
const result = Bun.spawnSync([lean, model], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
const output = result.stdout.toString() + result.stderr.toString();
process.stdout.write(output);
if (result.exitCode !== 0 || /\bwarning:/.test(output)) {
  throw new Error('Lean verification failed or emitted warnings');
}

const namespaces: string[] = [];
const theorems: string[] = [];
for (const line of source.split(/\r?\n/)) {
  const namespace = /^namespace\s+([\w.]+)\s*$/.exec(line);
  if (namespace) namespaces.push(namespace[1]);
  else if (/^end\s+\w+\s*$/.test(line)) namespaces.pop();
  else {
    const theorem = /^theorem\s+([\w.]+)/.exec(line);
    if (theorem) theorems.push([...namespaces, theorem[1]].join('.'));
  }
}
const audits = [...output.matchAll(/^'([^']+)' (?:depends on axioms: \[([^\]]*)\]|does not depend on any axioms)/gm)];
const auditNames = new Set(audits.map((a) => a[1]));
if (audits.length !== theorems.length || auditNames.size !== audits.length ||
    theorems.some((theorem) => !auditNames.has(theorem))) {
  throw new Error('Every theorem must have exactly one dependency audit with its fully qualified name');
}
const standardAxioms = new Set(['propext', 'Quot.sound', 'Classical.choice']);
for (const audit of audits) {
  for (const axiom of (audit[2] || '').split(',').map((a) => a.trim()).filter(Boolean)) {
    if (!standardAxioms.has(axiom)) throw new Error(`Unexpected proof dependency: ${axiom}`);
  }
}
console.log(`Verified ${theorems.length} theorems, including explicit race witnesses. All dependency audits passed.`);
