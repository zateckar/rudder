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
      {
        // Served over WebSocket (v4/v5.channel.k8s.io), not SPDY. kubectl 1.29
        // and later negotiate WebSocket; older clients cannot connect.
        name: 'pods/exec',
        singularName: '',
        namespaced: true,
        kind: 'PodExecOptions',
        verbs: ['create', 'get'],
      },
      {
        name: 'events',
        singularName: 'event',
        namespaced: true,
        kind: 'Event',
        verbs: ['get', 'list'],
        shortNames: ['ev'],
      },
    ],
  });
}
