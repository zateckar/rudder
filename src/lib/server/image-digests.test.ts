import { describe, expect, test } from 'bun:test';
import {
  SINGLE_IMAGE_KEY,
  normalizeRepository,
  parseDigestRecord,
  pinnedImageFor,
  repositoryOf,
  sameRepository,
  serializeDigestRecord,
} from './image-digests';

const DIGEST = 'docker.io/library/nginx@sha256:1111111111111111111111111111111111111111111111111111111111111111';
const OTHER = 'docker.io/library/redis@sha256:2222222222222222222222222222222222222222222222222222222222222222';

describe('parseDigestRecord', () => {
  test('reads a bare digest as the single-image entry', () => {
    const record = parseDigestRecord(DIGEST);
    expect(record.get(SINGLE_IMAGE_KEY)).toBe(DIGEST);
    expect(record.size).toBe(1);
  });

  test('reads the JSON form keyed by service', () => {
    const record = parseDigestRecord(JSON.stringify({ web: DIGEST, cache: OTHER }));
    expect(record.get('web')).toBe(DIGEST);
    expect(record.get('cache')).toBe(OTHER);
  });

  test('is empty for null, blank and malformed input', () => {
    expect(parseDigestRecord(null).size).toBe(0);
    expect(parseDigestRecord('   ').size).toBe(0);
    expect(parseDigestRecord('{not json').size).toBe(0);
    expect(parseDigestRecord('[]').size).toBe(0);
  });

  test('drops entries that are not digests, rather than trusting them as pins', () => {
    // A tag here would make rollback silently resolve `latest` again while
    // claiming the deployment was pinned.
    const record = parseDigestRecord(JSON.stringify({ web: 'nginx:latest', cache: OTHER }));
    expect(record.has('web')).toBe(false);
    expect(record.get('cache')).toBe(OTHER);
  });
});

describe('serializeDigestRecord', () => {
  test('a lone single-image entry stores as a bare reference', () => {
    expect(serializeDigestRecord([[SINGLE_IMAGE_KEY, DIGEST]])).toBe(DIGEST);
  });

  test('several entries store as JSON, sorted for a stable diff', () => {
    const first = serializeDigestRecord([['web', DIGEST], ['cache', OTHER]]);
    const second = serializeDigestRecord([['cache', OTHER], ['web', DIGEST]]);
    expect(first).toBe(second);
    expect(JSON.parse(first!)).toEqual({ cache: OTHER, web: DIGEST });
  });

  test('nothing resolved records null, not a tag', () => {
    expect(serializeDigestRecord([])).toBeNull();
    expect(serializeDigestRecord([['web', 'nginx:latest']])).toBeNull();
  });

  test('round-trips through parseDigestRecord', () => {
    const entries: Array<[string, string]> = [['web', DIGEST], ['cache', OTHER]];
    expect([...parseDigestRecord(serializeDigestRecord(entries)!)]).toEqual(
      entries.sort(([a], [b]) => (a < b ? -1 : 1)),
    );
  });
});

describe('repositoryOf', () => {
  test('strips a digest', () => {
    expect(repositoryOf(DIGEST)).toBe('docker.io/library/nginx');
  });

  test('strips a tag', () => {
    expect(repositoryOf('docker.io/library/nginx:1.27')).toBe('docker.io/library/nginx');
  });

  test('keeps a registry port, which is not a tag', () => {
    expect(repositoryOf('registry.example.com:5000/team/app')).toBe('registry.example.com:5000/team/app');
    expect(repositoryOf('registry.example.com:5000/team/app:v2')).toBe('registry.example.com:5000/team/app');
  });

  test('leaves a bare name alone', () => {
    expect(repositoryOf('nginx')).toBe('nginx');
  });
});

describe('normalizeRepository', () => {
  test('the three spellings of a Docker Hub library image agree', () => {
    expect(normalizeRepository('nginx')).toBe('library/nginx');
    expect(normalizeRepository('docker.io/nginx')).toBe('library/nginx');
    expect(normalizeRepository('docker.io/library/nginx')).toBe('library/nginx');
  });

  test('a user image on Docker Hub is not given the library prefix', () => {
    expect(normalizeRepository('traefik/whoami')).toBe('traefik/whoami');
    expect(normalizeRepository('docker.io/traefik/whoami')).toBe('traefik/whoami');
  });

  test('a private registry is left as written', () => {
    expect(normalizeRepository('registry.example.com:5000/team/app')).toBe('registry.example.com:5000/team/app');
    expect(normalizeRepository('localhost/dev-build')).toBe('localhost/dev-build');
  });
});

describe('sameRepository', () => {
  test('shorthand and fully qualified names match', () => {
    expect(sameRepository(DIGEST, 'nginx:latest')).toBe(true);
    expect(sameRepository(DIGEST, 'docker.io/library/nginx:1.27')).toBe(true);
  });

  test('different images do not', () => {
    expect(sameRepository(DIGEST, 'redis:7')).toBe(false);
  });
});

describe('pinnedImageFor', () => {
  test('uses the recorded digest when the manifest still names that image', () => {
    const record = parseDigestRecord(DIGEST);
    expect(pinnedImageFor(SINGLE_IMAGE_KEY, record, 'nginx:latest')).toBe(DIGEST);
  });

  test('falls back to the manifest when nothing was recorded', () => {
    expect(pinnedImageFor(SINGLE_IMAGE_KEY, new Map(), 'nginx:latest')).toBe('nginx:latest');
  });

  test('a digest for a different image is ignored, not deployed', () => {
    // The manifest was edited between the two deployments. Running the old
    // image under the new manifest would be a silent substitution.
    const record = parseDigestRecord(DIGEST);
    expect(pinnedImageFor(SINGLE_IMAGE_KEY, record, 'redis:7')).toBe('redis:7');
  });

  test('picks the digest belonging to the named service', () => {
    const record = parseDigestRecord(JSON.stringify({ web: DIGEST, cache: OTHER }));
    expect(pinnedImageFor('cache', record, 'redis:7')).toBe(OTHER);
    expect(pinnedImageFor('web', record, 'nginx:latest')).toBe(DIGEST);
    expect(pinnedImageFor('worker', record, 'busybox:1')).toBe('busybox:1');
  });
});
