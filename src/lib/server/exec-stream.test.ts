import { describe, expect, test } from 'bun:test';
import { demultiplexExecStream } from './podman';

/** Build one of Podman's 8-byte-headed frames. */
function frame(stream: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text, 'utf-8');
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe('demultiplexExecStream', () => {
  test('separates the two streams', () => {
    const raw = Buffer.concat([
      frame(1, 'to stdout\n'),
      frame(2, 'to stderr\n'),
      frame(1, 'more stdout\n'),
    ]);

    expect(demultiplexExecStream(raw)).toEqual({
      stdout: 'to stdout\nmore stdout\n',
      stderr: 'to stderr\n',
    });
  });

  test('the empty case is empty, not a crash', () => {
    expect(demultiplexExecStream(Buffer.alloc(0))).toEqual({ stdout: '', stderr: '' });
  });

  test('keeps a truncated final frame rather than dropping it', () => {
    // Output that was written and then cut off is still output.
    const header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(100, 4);
    const raw = Buffer.concat([header, Buffer.from('cut short', 'utf-8')]);

    expect(demultiplexExecStream(raw).stdout).toBe('cut short');
  });

  test('falls back to stdout when the body carries no frame headers', () => {
    // Some versions answer a TTY-less exec with a plain body; losing it
    // entirely would be worse than mislabelling it.
    const raw = Buffer.from('plain output with no framing at all', 'utf-8');
    expect(demultiplexExecStream(raw).stdout).toContain('plain output');
  });

  test('handles a payload split across the boundary of what was read', () => {
    const raw = Buffer.concat([frame(1, 'first'), frame(2, 'second'), frame(1, 'third')]);
    const result = demultiplexExecStream(raw);
    expect(result.stdout).toBe('firstthird');
    expect(result.stderr).toBe('second');
  });

  test('multi-byte characters survive the split', () => {
    const raw = Buffer.concat([frame(1, 'héllo → wörld'), frame(2, 'chyba: ✗')]);
    const result = demultiplexExecStream(raw);
    expect(result.stdout).toBe('héllo → wörld');
    expect(result.stderr).toBe('chyba: ✗');
  });
});
