/**
 * The record a failed deploy leaves of why it failed.
 *
 * This is the only copy: the generation that produced the output is removed
 * moments after it is captured, so anything lost here is lost for good. The
 * three ways to lose it are a capture that throws (taking the real error with
 * it), a stored value that will not parse back, and a secret printed by the
 * application ending up in the deployment history — so those are what this
 * covers, without a worker.
 */
import { describe, expect, test } from 'bun:test';
import {
  captureContainerOutput,
  FAILURE_LOG_TAIL_LINES,
  maskSecretValues,
  parseCapturedOutput,
  serializeCapturedOutput,
  tailChars,
  type LogSource,
} from './failure-logs';
import { REDACTED } from '$lib/server/redaction';

const one = [{ containerId: 'c1', name: 'app-g1' }];

describe('captureContainerOutput', () => {
  test('reads the tail of each container, naming it', async () => {
    const source: LogSource = {
      getContainerLogs: async (id) => `output of ${id}\n`,
    };
    const captured = await captureContainerOutput(source, [
      { containerId: 'c1', name: 'app-g1' },
      { containerId: 'c2', name: 'db-g1' },
    ]);
    expect(captured).toEqual([
      { container: 'app-g1', log: 'output of c1' },
      { container: 'db-g1', log: 'output of c2' },
    ]);
  });

  test('asks for stdout and stderr together, with a bounded tail', async () => {
    let asked: any;
    const source: LogSource = {
      getContainerLogs: async (_id, options) => {
        asked = options;
        return '';
      },
    };
    await captureContainerOutput(source, one);
    expect(asked.stdout).toBe(true);
    expect(asked.stderr).toBe(true);
    expect(asked.tail).toBe(FAILURE_LOG_TAIL_LINES);
  });

  test('a worker that will not answer is recorded, not thrown', async () => {
    // This runs while a deploy is already failing. Throwing here would replace
    // the error that explains the failure with one about reading a log.
    const source: LogSource = {
      getContainerLogs: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    };
    const captured = await captureContainerOutput(source, one);
    expect(captured).toEqual([
      { container: 'app-g1', log: '', unavailable: 'connect ECONNREFUSED' },
    ]);
  });

  test('one unreadable container does not cost the others their output', async () => {
    const source: LogSource = {
      getContainerLogs: async (id) => {
        if (id === 'bad') throw new Error('no such container');
        return 'still here';
      },
    };
    const captured = await captureContainerOutput(source, [
      { containerId: 'bad', name: 'db-g1' },
      { containerId: 'ok', name: 'app-g1' },
    ]);
    expect(captured[0].unavailable).toBe('no such container');
    expect(captured[1].log).toBe('still here');
  });

  test('secrets the deploy injected are masked out of what it stores', async () => {
    // An application that prints its configuration at startup is exactly the
    // kind that then fails to start.
    const source: LogSource = {
      getContainerLogs: async () => 'connecting with DB_PASSWORD=hunter2-and-then-some\n',
    };
    const captured = await captureContainerOutput(source, one, {
      mask: ['hunter2-and-then-some'],
    });
    expect(captured[0].log).not.toContain('hunter2');
    expect(captured[0].log).toContain(REDACTED);
  });
});

describe('maskSecretValues', () => {
  test('a secret containing regex metacharacters is still masked', () => {
    const masked = maskSecretValues('token=a.b*c(d)', ['a.b*c(d)']);
    expect(masked).toBe(`token=${REDACTED}`);
  });

  test('every occurrence goes, not just the first', () => {
    const masked = maskSecretValues('longsecret longsecret', ['longsecret']);
    expect(masked).toBe(`${REDACTED} ${REDACTED}`);
  });

  test('a very short value is left alone', () => {
    // Masking `id` would redact half the log and disclose nothing an attacker
    // did not already have.
    expect(maskSecretValues('an id here', ['id'])).toBe('an id here');
  });
});

describe('tailChars', () => {
  test('short output is untouched', () => {
    expect(tailChars('hello', 100)).toBe('hello');
  });

  test('long output keeps the end, which is where the crash is', () => {
    const text = 'a'.repeat(50) + '\nthe last line';
    const kept = tailChars(text, 20);
    expect(kept).toContain('the last line');
    expect(kept).toContain('earlier characters dropped');
  });

  test('truncation resumes at a line boundary', () => {
    const text = 'first line\nsecond line\nthird line';
    const kept = tailChars(text, 20).split('\n').slice(1).join('\n');
    expect(kept.startsWith('second') || kept.startsWith('third')).toBe(true);
  });
});

describe('the stored format', () => {
  test('round-trips', () => {
    const captured = [{ container: 'app-g1', log: 'boom' }];
    expect(parseCapturedOutput(serializeCapturedOutput(captured))).toEqual(captured);
  });

  test('containers that printed nothing are not stored at all', () => {
    expect(serializeCapturedOutput([{ container: 'app-g1', log: '' }])).toBeNull();
  });

  test('a container that could not be read is worth storing', () => {
    // "The worker would not tell us" is a different answer from "it printed
    // nothing", and the reader needs to be able to tell them apart.
    const stored = serializeCapturedOutput([
      { container: 'app-g1', log: '', unavailable: 'timed out' },
    ]);
    expect(parseCapturedOutput(stored)[0].unavailable).toBe('timed out');
  });

  test('a malformed record reads as no output, never as an error', () => {
    // It hangs off the deployment history, which has to render regardless.
    expect(parseCapturedOutput('{not json')).toEqual([]);
    expect(parseCapturedOutput('{"container":"x"}')).toEqual([]);
    expect(parseCapturedOutput(null)).toEqual([]);
  });

  test('entries missing the fields the page renders are dropped', () => {
    const parsed = parseCapturedOutput(
      JSON.stringify([{ container: 'app-g1', log: 'kept' }, { log: 'no name' }]),
    );
    expect(parsed).toEqual([{ container: 'app-g1', log: 'kept' }]);
  });
});
