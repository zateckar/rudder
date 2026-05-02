import { authenticateK8s, k8sError, k8sJson } from '$lib/server/k8s/auth';

export async function GET({ request }: { request: Request }) {
  const ctx = await authenticateK8s(request);
  if (!ctx) return k8sError(401, 'Unauthorized');

  return k8sJson({
    kind: 'APIVersions',
    versions: ['v1'],
    serverAddressByClientCIDRs: [
      { clientCIDR: '0.0.0.0/0', serverAddress: '' },
    ],
  });
}
