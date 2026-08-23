import { describe, expect, test } from 'bun:test';
import { createFrameReader, demultiplexExecStream } from './podman';

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

/**
 * The streaming form, which had five hand-written copies across the exec and
 * logs paths before it was extracted.
 */
describe('createFrameReader', () => {
  function collect(chunks: Buffer[], tty = false) {
    const out: string[] = [];
    const err: string[] = [];
    const read = createFrameReader({
      tty,
      onStdout: (p) => out.push(p.toString('utf-8')),
      onStderr: (p) => err.push(p.toString('utf-8')),
    });
    for (const chunk of chunks) read(chunk);
    return { stdout: out.join(''), stderr: err.join('') };
  }

  test('separates the two streams', () => {
    expect(collect([frame(1, 'out'), frame(2, 'err'), frame(1, 'more')])).toEqual({
      stdout: 'outmore',
      stderr: 'err',
    });
  });

  test('reassembles a frame split across two reads', () => {
    // The reason this cannot live in the caller: a TCP read boundary can fall
    // anywhere, and treating half a header as payload puts binary on a terminal.
    const whole = frame(1, 'hello world');
    expect(collect([whole.subarray(0, 3), whole.subarray(3)])).toEqual({
      stdout: 'hello world',
      stderr: '',
    });
  });

  test('reassembles a header split across reads', () => {
    const whole = Buffer.concat([frame(1, 'aaa'), frame(2, 'bbb')]);
    const parts = [whole.subarray(0, 9), whole.subarray(9, 12), whole.subarray(12)];
    expect(collect(parts)).toEqual({ stdout: 'aaa', stderr: 'bbb' });
  });

  test('holds back an incomplete trailing frame rather than emitting garbage', () => {
    const whole = frame(1, 'complete');
    const partial = frame(1, 'incomplete').subarray(0, 12);
    expect(collect([whole, partial]).stdout).toBe('complete');
  });

  test('in TTY mode the chunk is passed through untouched', () => {
    // The pty has already merged the streams; there are no headers to read, and
    // parsing the payload as one would corrupt it.
    const raw = Buffer.from('\x01\x02\x03 raw terminal bytes');
    expect(collect([raw], true)).toEqual({ stdout: raw.toString('utf-8'), stderr: '' });
  });

  test('stderr falls back to stdout when no stderr handler is given', () => {
    // The logs paths want both streams in one text view. Before this was
    // shared, their copies dropped the stream byte entirely and labelled
    // everything stdout by accident rather than by choice.
    const out: string[] = [];
    const read = createFrameReader({ tty: false, onStdout: (p) => out.push(p.toString()) });
    read(Buffer.concat([frame(1, 'a'), frame(2, 'b')]));
    expect(out.join('')).toBe('ab');
  });

  test('a zero-length frame is consumed, not treated as a stall', () => {
    expect(collect([Buffer.concat([frame(1, ''), frame(1, 'after')])]).stdout).toBe('after');
  });
});
