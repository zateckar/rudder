import { authenticateK8s, k8sError, k8sJson } from '$lib/server/k8s/auth';

export async function GET({ request }: { request: Request }) {
  const ctx = await authenticateK8s(request);
  if (!ctx) return k8sError(401, 'Unauthorized');

  return k8sJson({
    kind: 'APIGroupList',
    apiVersion: 'v1',
    groups: [
      {
        name: 'apps',
        versions: [{ groupVersion: 'apps/v1', version: 'v1' }],
        preferredVersion: { groupVersion: 'apps/v1', version: 'v1' },
      },
    ],
  });
}
