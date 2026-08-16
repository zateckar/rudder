import { describe, expect, test } from 'bun:test';
import {
  CHANNEL,
  SUPPORTED_PROTOCOLS,
  frame,
  parseFrame,
  parseResize,
  selectChannelProtocol,
  statusFrame,
} from './channel';

describe('selectChannelProtocol', () => {
  test('prefers v5, which is what kubectl 1.29+ offers', () => {
    expect(selectChannelProtocol(['v5.channel.k8s.io', 'v4.channel.k8s.io'])).toBe('v5.channel.k8s.io');
  });

  test('accepts v4 from an older client', () => {
    expect(selectChannelProtocol(['v4.channel.k8s.io'])).toBe('v4.channel.k8s.io');
  });

  test('rejects an offer it cannot speak, so the client fails fast', () => {
    expect(selectChannelProtocol(['v3.channel.k8s.io', 'base64.channel.k8s.io'])).toBe(false);
    expect(selectChannelProtocol([])).toBe(false);
  });

  test('takes a Set, which is what the ws library passes', () => {
    expect(selectChannelProtocol(new Set(['v5.channel.k8s.io']))).toBe('v5.channel.k8s.io');
  });

  test('every advertised protocol is one we select', () => {
    for (const p of SUPPORTED_PROTOCOLS) {
      expect(selectChannelProtocol([p])).toBe(p);
    }
  });
});

describe('frame / parseFrame', () => {
  test('prefixes the channel byte', () => {
    const f = frame(CHANNEL.STDOUT, 'hello');
    expect(f[0]).toBe(1);
    expect(f.subarray(1).toString()).toBe('hello');
  });

  test('round-trips', () => {
    const parsed = parseFrame(frame(CHANNEL.STDERR, 'oops'));
    expect(parsed?.channel).toBe(CHANNEL.STDERR);
    expect(parsed?.payload.toString()).toBe('oops');
  });

  test('an empty frame is dropped, not read as channel 0', () => {
    // kubectl sends zero-length keepalives; treating one as stdin would write
    // a stray byte into the user's shell.
    expect(parseFrame(Buffer.alloc(0))).toBeNull();
  });

  test('a channel byte with no payload is still a frame', () => {
    const parsed = parseFrame(Buffer.from([CHANNEL.STDIN]));
    expect(parsed?.channel).toBe(CHANNEL.STDIN);
    expect(parsed?.payload.length).toBe(0);
  });

  test('binary payloads are preserved', () => {
    const payload = Buffer.from([0x00, 0xff, 0x1b, 0x5b]);
    const parsed = parseFrame(frame(CHANNEL.STDOUT, payload));
    expect(parsed?.payload).toEqual(payload);
  });
});

describe('parseResize', () => {
  test('reads the capitalised form kubectl sends', () => {
    expect(parseResize(Buffer.from('{"Width":120,"Height":40}'))).toEqual({ width: 120, height: 40 });
  });

  test('accepts the lowercase spelling too', () => {
    expect(parseResize(Buffer.from('{"width":80,"height":24}'))).toEqual({ width: 80, height: 24 });
  });

  test('rejects nonsense rather than resizing to zero', () => {
    expect(parseResize(Buffer.from('not json'))).toBeNull();
    expect(parseResize(Buffer.from('{"Width":0,"Height":24}'))).toBeNull();
    expect(parseResize(Buffer.from('{"Width":-5,"Height":24}'))).toBeNull();
    expect(parseResize(Buffer.from('{}'))).toBeNull();
  });
});

describe('statusFrame', () => {
  test('success goes on the error channel too — kubectl needs it to exit 0', () => {
    const parsed = parseFrame(statusFrame(0, ['sh', '-c', 'true']))!;
    expect(parsed.channel).toBe(CHANNEL.ERROR);
    const status = JSON.parse(parsed.payload.toString());
    expect(status.kind).toBe('Status');
    expect(status.status).toBe('Success');
  });

  test('a non-zero exit carries the code kubectl reports', () => {
    const parsed = parseFrame(statusFrame(127, ['sh', '-c', 'nope']))!;
    const status = JSON.parse(parsed.payload.toString());
    expect(status.status).toBe('Failure');
    expect(status.reason).toBe('NonZeroExitCode');
    expect(status.details.causes[0]).toEqual({ reason: 'ExitCode', message: '127' });
  });

  test('the failure message names the command that failed', () => {
    const parsed = parseFrame(statusFrame(2, ['ls', '/missing']))!;
    const status = JSON.parse(parsed.payload.toString());
    expect(status.message).toContain('ls');
    expect(status.message).toContain('/missing');
  });
});
