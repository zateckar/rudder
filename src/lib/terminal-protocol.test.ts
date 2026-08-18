/**
 * The terminal token is read out of the handshake, so this is the parse that
 * stands between a WebSocket and a container shell.
 */
import { describe, expect, test } from 'bun:test';
import {
  TERMINAL_SUBPROTOCOL,
  terminalSubprotocols,
  tokenFromSubprotocols,
} from './terminal-protocol';

describe('terminal subprotocol token', () => {
  test('round-trips a token through the header the browser sends', () => {
    const token = crypto.randomUUID();
    // A browser joins the offered protocols with ", " in Sec-WebSocket-Protocol.
    const header = terminalSubprotocols(token).join(', ');

    expect(tokenFromSubprotocols(header)).toBe(token);
  });

  test('offers the protocol the server has to echo back', () => {
    expect(terminalSubprotocols('t')).toContain(TERMINAL_SUBPROTOCOL);
  });

  test('tolerates a header joined without spaces', () => {
    const token = crypto.randomUUID();
    expect(tokenFromSubprotocols(terminalSubprotocols(token).join(','))).toBe(token);
  });

  test('a missing header yields no token', () => {
    expect(tokenFromSubprotocols(undefined)).toBeNull();
    expect(tokenFromSubprotocols(null)).toBeNull();
    expect(tokenFromSubprotocols('')).toBeNull();
  });

  test('the marker protocol alone is not mistaken for a token', () => {
    // The failure that matters: reading the marker as a credential would hand
    // every connection the same non-token and defer the rejection.
    expect(tokenFromSubprotocols(TERMINAL_SUBPROTOCOL)).toBeNull();
  });

  test('an empty token is rejected rather than returned as an empty string', () => {
    expect(tokenFromSubprotocols('rudder.terminal.v1, rudder.token.')).toBeNull();
  });

  test('an unrelated protocol list yields no token', () => {
    expect(tokenFromSubprotocols('v5.channel.k8s.io, v4.channel.k8s.io')).toBeNull();
  });
});
