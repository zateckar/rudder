import { describe, expect, test } from 'bun:test';
import { buildTar, MAX_TAR_NAME } from './tar';

const BLOCK = 512;

/** Read a NUL/space-terminated field out of a header block. */
function field(buf: Buffer, offset: number, length: number): string {
  return buf.subarray(offset, offset + length).toString('utf8').replace(/[\0 ]+$/, '');
}

describe('buildTar', () => {
  test('writes name, mode and size into the header', () => {
    const tar = buildTar([{ name: 'DB_PASSWORD', content: 'hunter2', mode: 0o400 }]);

    expect(field(tar, 0, 100)).toBe('DB_PASSWORD');
    expect(field(tar, 100, 8)).toBe('0000400');
    expect(parseInt(field(tar, 124, 12), 8)).toBe(7);
    expect(tar[156]).toBe(0x30); // regular file
    expect(field(tar, 257, 6)).toBe('ustar');
  });

  test('the checksum matches what an extractor computes', () => {
    // Getting this wrong is the classic silent tar bug: the archive looks
    // right and every extractor refuses it.
    const tar = buildTar([{ name: 'API_KEY', content: 'abc' }]);
    const header = Buffer.from(tar.subarray(0, BLOCK));
    const stored = parseInt(field(header, 148, 8), 8);

    header.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;

    expect(stored).toBe(sum);
  });

  test('content is padded to a block boundary', () => {
    const tar = buildTar([{ name: 'A', content: 'x' }]);
    // header + one padded content block + two end-of-archive blocks
    expect(tar.length).toBe(BLOCK * 4);
    expect(tar.subarray(BLOCK, BLOCK + 1).toString()).toBe('x');
    expect(tar.subarray(BLOCK + 1, BLOCK * 2).every((b) => b === 0)).toBe(true);
  });

  test('content that exactly fills a block gets no extra padding', () => {
    const tar = buildTar([{ name: 'A', content: 'y'.repeat(BLOCK) }]);
    expect(tar.length).toBe(BLOCK * 4);
  });

  test('ends with two zero blocks, or extractors report a truncated archive', () => {
    const tar = buildTar([{ name: 'A', content: 'x' }]);
    expect(tar.subarray(tar.length - BLOCK * 2).every((b) => b === 0)).toBe(true);
  });

  test('several files are laid out back to back', () => {
    const tar = buildTar([
      { name: 'ONE', content: 'a' },
      { name: 'TWO', content: 'bb' },
    ]);
    expect(field(tar, 0, 100)).toBe('ONE');
    expect(field(tar, BLOCK * 2, 100)).toBe('TWO');
    expect(parseInt(field(tar, BLOCK * 2 + 124, 12), 8)).toBe(2);
  });

  test('defaults to owner-read-only', () => {
    const tar = buildTar([{ name: 'SECRET', content: 'v' }]);
    expect(parseInt(field(tar, 100, 8), 8)).toBe(0o400);
  });

  test('an empty archive is still a valid empty archive', () => {
    const tar = buildTar([]);
    expect(tar.length).toBe(BLOCK * 2);
    expect(tar.every((b) => b === 0)).toBe(true);
  });

  test('binary content survives byte for byte', () => {
    const content = Buffer.from([0x00, 0xff, 0x7f, 0x80]);
    const tar = buildTar([{ name: 'BIN', content }]);
    expect(tar.subarray(BLOCK, BLOCK + 4)).toEqual(content);
  });

  test('a name too long to store throws instead of being truncated', () => {
    // Truncation would produce a file with the wrong name — a secret delivered
    // where the application will not look for it.
    expect(() => buildTar([{ name: 'N'.repeat(MAX_TAR_NAME + 1), content: 'x' }])).toThrow(
      /tar field too long/,
    );
  });

  test('utf-8 length is measured in bytes, not characters', () => {
    const name = 'é'.repeat(51); // 102 bytes
    expect(() => buildTar([{ name, content: 'x' }])).toThrow(/tar field too long/);
  });
});
