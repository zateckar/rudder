/**
 * Minimal USTAR writer.
 *
 * Podman's `PUT /containers/{id}/archive` is the only way to put a file inside
 * a container without running a command in it, and it takes a tar stream. The
 * archives Rudder builds are a handful of small files, so a dependency-free
 * writer is cheaper than pulling in a tar library — and it keeps the format
 * under test rather than trusting a transitive package with secret material.
 *
 * Deliberately limited: regular files only, no long names (>100 bytes), no
 * sparse files, no PAX extensions. Callers that need more should not be using
 * this.
 */

const BLOCK = 512;

export interface TarFile {
  /** Path relative to the archive root, e.g. `DB_PASSWORD`. */
  name: string;
  content: string | Buffer;
  /** Unix permission bits. Defaults to 0o400 — read-only, owner only. */
  mode?: number;
  /** Seconds since the epoch. Defaults to 0 so archives are reproducible. */
  mtime?: number;
}

/** Longest name USTAR can store without the prefix field. */
export const MAX_TAR_NAME = 100;

function writeString(block: Buffer, value: string, offset: number, length: number): void {
  // Truncation here would silently produce a file with the wrong name, so the
  // caller is expected to have validated. Assert rather than corrupt.
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) {
    throw new Error(`tar field too long: "${value}" needs ${bytes.length} bytes, field holds ${length}`);
  }
  bytes.copy(block, offset);
}

/** Octal, NUL-terminated, zero-padded — the USTAR numeric convention. */
function writeOctal(block: Buffer, value: number, offset: number, length: number): void {
  const text = value.toString(8).padStart(length - 1, '0');
  writeString(block, text, offset, length - 1);
  block[offset + length - 1] = 0;
}

function header(file: TarFile, size: number): Buffer {
  const block = Buffer.alloc(BLOCK);

  writeString(block, file.name, 0, MAX_TAR_NAME);
  writeOctal(block, file.mode ?? 0o400, 100, 8);
  writeOctal(block, 0, 108, 8); // uid: root
  writeOctal(block, 0, 116, 8); // gid: root
  writeOctal(block, size, 124, 12);
  writeOctal(block, file.mtime ?? 0, 136, 12);

  // The checksum is computed with its own field full of spaces.
  block.fill(0x20, 148, 156);

  block[156] = 0x30; // typeflag '0' — regular file
  writeString(block, 'ustar', 257, 6);
  block[262] = 0; // NUL after "ustar"
  writeString(block, '00', 263, 2);
  writeString(block, 'root', 265, 32);
  writeString(block, 'root', 297, 32);

  let sum = 0;
  for (const byte of block) sum += byte;
  // Six octal digits, NUL, space — the form GNU tar and Podman both accept.
  writeString(block, sum.toString(8).padStart(6, '0'), 148, 6);
  block[154] = 0;
  block[155] = 0x20;

  return block;
}

/**
 * Build an uncompressed tar archive.
 *
 * The two trailing zero blocks are the end-of-archive marker; without them
 * Podman reports an unexpected EOF and the upload is rejected.
 */
export function buildTar(files: TarFile[]): Buffer {
  const parts: Buffer[] = [];

  for (const file of files) {
    const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8');
    parts.push(header(file, content.length));
    parts.push(content);

    const remainder = content.length % BLOCK;
    if (remainder !== 0) parts.push(Buffer.alloc(BLOCK - remainder));
  }

  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}
