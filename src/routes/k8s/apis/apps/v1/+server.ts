import { authenticateK8s, k8sError, k8sJson } from '$lib/server/k8s/auth';

export async function GET({ request }: { request: Request }) {
  const ctx = await authenticateK8s(request);
  if (!ctx) return k8sError(401, 'Unauthorized');

  return k8sJson({
    kind: 'APIResourceList',
    groupVersion: 'apps/v1',
    resources: [
      {
        name: 'deployments',
        singularName: 'deployment',
        namespaced: true,
        kind: 'Deployment',
        verbs: ['create', 'delete', 'get', 'list', 'patch', 'update'],
        shortNames: ['deploy'],
        categories: ['all'],
      },
      {
        name: 'deployments/scale',
        singularName: '',
        namespaced: true,
        kind: 'Scale',
        group: 'autoscaling',
        version: 'v1',
        verbs: ['get', 'patch', 'update'],
      },
    ],
  });
}
