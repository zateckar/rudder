import { describe, expect, test } from 'bun:test';
import { bareYamlMessage, describeYamlError, firstFailingLine, parseYamlDocuments } from './yaml-errors';

/** Indented with a tab, which YAML rejects. */
const TAB_AT_LINE_5 = [
  'services:',
  '  web:',
  '    image: nginx:alpine',
  '  api:',
  '\t  image: traefik/whoami',
].join('\n');

function yamlError(text: string): unknown {
  try {
    Bun.YAML.parse(text);
  } catch (e) {
    return e;
  }
  throw new Error('expected the parser to reject this');
}

describe('bareYamlMessage', () => {
  test('drops the parser prefix so a caller can add context once', () => {
    // "YAML parse error: YAML Parse error: Unexpected token" was the symptom.
    const message = bareYamlMessage(yamlError(TAB_AT_LINE_5));
    expect(message).not.toMatch(/YAML\s+Parse\s+error/i);
    expect(message.length).toBeGreaterThan(0);
  });

  test('survives something that is not an Error', () => {
    expect(bareYamlMessage('boom')).toBe('boom');
    expect(bareYamlMessage(undefined)).toBe('undefined');
  });
});

describe('firstFailingLine', () => {
  test('finds the line the document stops parsing at', () => {
    expect(firstFailingLine(TAB_AT_LINE_5)).toBe(5);
  });

  test('is null for a document that parses', () => {
    expect(firstFailingLine('services:\n  web:\n    image: nginx\n')).toBeNull();
  });
});

describe('describeYamlError', () => {
  test('says where, quotes the line, and does not stutter', () => {
    const message = describeYamlError(TAB_AT_LINE_5, yamlError(TAB_AT_LINE_5));

    expect(message).toContain('line 5');
    expect(message).toContain('image: traefik/whoami');
    expect(message).toContain('tab characters');
    // One prefix, not two.
    expect(message.match(/parse error/gi)).toHaveLength(1);
  });

  test('names an unclosed quote', () => {
    const text = 'services:\n  web:\n    image: "nginx:alpine\n    ports: ["80"]\n';
    const message = describeYamlError(text, yamlError(text));
    expect(message).toContain('unclosed');
  });

  test('shifts the line by the offset a caller passes', () => {
    const message = describeYamlError(TAB_AT_LINE_5, yamlError(TAB_AT_LINE_5), 10);
    expect(message).toContain('line 15');
  });
});

describe('parseYamlDocuments', () => {
  test('returns every document', () => {
    const docs = parseYamlDocuments('kind: Deployment\n---\nkind: Service\n');
    expect(docs).toHaveLength(2);
    expect((docs[0] as any).kind).toBe('Deployment');
    expect((docs[1] as any).kind).toBe('Service');
  });

  test('locates a failure in the second document against the whole file', () => {
    // The unclosed bracket is line 6 of the file, but line 3 of its fragment.
    const manifest = ['kind: Deployment', 'metadata:', '  name: a', '---', 'kind: Service', 'ports: [80, 90'].join('\n');
    expect(() => parseYamlDocuments(manifest)).toThrow(/line 6/);
  });
});
