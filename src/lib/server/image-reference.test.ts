import { describe, expect, test } from 'bun:test';
import { imageReferenceError } from './image-reference';

describe('imageReferenceError', () => {
  test('accepts the references people actually deploy', () => {
    for (const ref of [
      'nginx',
      'nginx:alpine',
      'nginx:1.27.4',
      'traefik/whoami:latest',
      'docker.io/library/nginx:alpine',
      'ghcr.io/owner/repo:v1.2.3',
      'registry.example.com:5000/team/app:2024-01-01',
      'quay.io/org/sub/app',
      'crowdsecurity/crowdsec:v1.7.8',
      'docker.io/library/nginx@sha256:' + 'a'.repeat(64),
      'my-app_v2.final:latest',
      'localhost/built-here:dev',
    ]) {
      expect(imageReferenceError(ref), ref).toBeNull();
    }
  });

  test('rejects the blob that caused the 500', () => {
    // Stored by the create form, surfaced by Podman as "invalid reference format".
    expect(imageReferenceError('{"image":"","ports":[]}')).toMatch(/looks like JSON/);
  });

  test('rejects an empty or whitespace reference', () => {
    expect(imageReferenceError('')).toMatch(/required/i);
    expect(imageReferenceError('   ')).toMatch(/required/i);
  });

  test('names the specific problem rather than saying "invalid"', () => {
    expect(imageReferenceError('nginx alpine')).toMatch(/space/);
    expect(imageReferenceError('MyApp/server')).toMatch(/lowercase/);
    expect(imageReferenceError('nginx:')).toMatch(/colon and no tag/);
    expect(imageReferenceError('team//app')).toMatch(/empty path segment/);
    expect(imageReferenceError('nginx@sha256:nothex')).toMatch(/not a valid image digest/);
    expect(imageReferenceError('nginx:' + 'x'.repeat(200))).toMatch(/not a valid image tag/);
  });

  test('does not mistake a registry port for a tag', () => {
    expect(imageReferenceError('registry.example.com:5000/app')).toBeNull();
    // A capitalised host is legal; a capitalised repository is not.
    expect(imageReferenceError('Registry.Example.COM/app')).toBeNull();
    expect(imageReferenceError('registry.example.com/App')).toMatch(/lowercase/);
  });
});
