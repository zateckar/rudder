import { authenticateK8s, k8sError, k8sJson } from '$lib/server/k8s/auth';

export async function GET({ request }: { request: Request }) {
  const ctx = await authenticateK8s(request);
  if (!ctx) return k8sError(401, 'Unauthorized');

  return k8sJson({
    major: '1',
    minor: '28',
    gitVersion: 'v1.28.0-rudder',
    gitCommit: '0000000000000000000000000000000000000000',
    gitTreeState: 'clean',
    buildDate: '2024-01-01T00:00:00Z',
    goVersion: 'go1.21.0',
    compiler: 'gc',
    platform: 'linux/amd64',
  });
}
