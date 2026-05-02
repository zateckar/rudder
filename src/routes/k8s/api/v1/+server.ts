import { authenticateK8s, k8sError, k8sJson } from '$lib/server/k8s/auth';

export async function GET({ request }: { request: Request }) {
  const ctx = await authenticateK8s(request);
  if (!ctx) return k8sError(401, 'Unauthorized');

  return k8sJson({
    kind: 'APIResourceList',
    groupVersion: 'v1',
    resources: [
      {
        name: 'namespaces',
        singularName: 'namespace',
        namespaced: false,
        kind: 'Namespace',
        verbs: ['get', 'list'],
        shortNames: ['ns'],
      },
      {
        name: 'pods',
        singularName: 'pod',
        namespaced: true,
        kind: 'Pod',
        verbs: ['get', 'list', 'delete'],
        shortNames: ['po'],
      },
      {
        name: 'pods/log',
        singularName: '',
        namespaced: true,
        kind: 'Pod',
        verbs: ['get'],
      },
    ],
  });
}
