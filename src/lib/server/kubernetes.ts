import { parse as parseYaml } from 'yaml';

export interface K8sMetadata {
  name?: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface K8sPodSpec {
  containers?: K8sContainer[];
  volumes?: K8sVolume[];
  serviceAccountName?: string;
  nodeSelector?: Record<string, string>;
  restartPolicy?: string;
}

export interface K8sContainer {
  name: string;
  image?: string;
  ports?: Array<{ containerPort: number; protocol?: string }>;
  env?: Array<{ name: string; value?: string }>;
  volumeMounts?: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
  resources?: {
    requests?: { memory?: string; cpu?: string };
    limits?: { memory?: string; cpu?: string };
  };
  command?: string[];
  args?: string[];
  workingDir?: string;
}

export interface K8sVolume {
  name: string;
  emptyDir?: Record<string, any>;
  hostPath?: { path: string };
  configMap?: { name: string };
  secret?: { secretName: string };
}

export interface K8sServiceSpec {
  selector?: Record<string, string>;
  ports?: Array<{ port: number; targetPort: number | string; protocol?: string; name?: string }>;
  type?: string;
}

export interface K8sManifest {
  apiVersion?: string;
  kind?: string;
  metadata?: K8sMetadata;
  spec?: K8sPodSpec | K8sServiceSpec;
}

export interface ParsedK8sContainer {
  name: string;
  image: string;
  env: Record<string, string>;
  ports: Record<string, Array<{ hostPort: string }>>;
  volumes: Record<string, { bind: string; options: string }>;
  restartPolicy: string;
  labels: Record<string, string>;
  command?: string[];
  args?: string[];
  workingDir?: string;
  memory?: number;
  cpuShares?: number;
}

export function parseK8sManifest(manifest: string, appName: string, teamSlug?: string): ParsedK8sContainer[] {
  const docs = manifest.split('---').map(doc => parseYaml(doc)).filter(Boolean);
  
  const containers: ParsedK8sContainer[] = [];
  const volumes: Record<string, string> = {};
  const labels: Record<string, string> = { app: appName };
  if (teamSlug) labels.team = teamSlug;

  for (const doc of docs) {
    if (!doc) continue;
    
    const kind = doc.kind?.toLowerCase();
    const metadata = doc.metadata || {};
    const spec = doc.spec || {};
    
    if (kind === 'pod') {
      const podSpec = spec as K8sPodSpec;
      
      if (podSpec.volumes) {
        for (const vol of podSpec.volumes) {
          if (vol.hostPath) {
            volumes[vol.name] = vol.hostPath.path;
          } else if (vol.emptyDir) {
            volumes[vol.name] = '';
          }
        }
      }

      if (podSpec.containers) {
        for (const container of podSpec.containers) {
          const parsed = parseK8sContainer(container, metadata, volumes, podSpec.restartPolicy);
          parsed.labels = { ...labels, ...parsed.labels };
          containers.push(parsed);
        }
      }
    } else if (kind === 'deployment') {
      if (spec.template?.spec) {
        const podSpec = spec.template.spec as K8sPodSpec;
        
        if (podSpec.volumes) {
          for (const vol of podSpec.volumes) {
            if (vol.hostPath) {
              volumes[vol.name] = vol.hostPath.path;
            }
          }
        }

        if (podSpec.containers) {
          for (const container of podSpec.containers) {
            const parsed = parseK8sContainer(container, metadata, volumes, podSpec.restartPolicy);
            // Strip any traefik.* labels from user metadata to prevent route hijacking
            const safeMetaLabels = Object.fromEntries(
              Object.entries(metadata.labels || {}).filter(
                ([k]) => !k.toLowerCase().startsWith('traefik.')
              )
            );
            parsed.labels = { 
              ...labels, 
              ...safeMetaLabels,
              'app.kubernetes.io/name': container.name,
              'app.kubernetes.io/version': container.image?.split(':')[1] || 'latest',
            };
            containers.push(parsed);
          }
        }
      }
    } else if (kind === 'service') {
      // Services are handled separately for routing
    } else if (kind === 'configmap') {
      // ConfigMaps can be used for environment variables
    } else if (kind === 'secret') {
      // Secrets for sensitive data
    }
  }

  if (containers.length === 0) {
    throw new Error('No Pod or Deployment found in manifest');
  }

  return containers;
}

function parseK8sContainer(
  container: K8sContainer,
  metadata: K8sMetadata,
  volumes: Record<string, string>,
  restartPolicy?: string
): ParsedK8sContainer {
  const env: Record<string, string> = {};
  
  if (container.env) {
    for (const envEntry of container.env) {
      env[envEntry.name] = envEntry.value || '';
    }
  }

  const ports: Record<string, Array<{ hostPort: string }>> = {};
  
  if (container.ports) {
    for (const port of container.ports) {
      ports[`${port.containerPort}/tcp`] = [{ hostPort: String(port.containerPort) }];
    }
  }

  const containerVolumes: Record<string, { bind: string; options: string }> = {};
  
  if (container.volumeMounts) {
    for (const vm of container.volumeMounts) {
      const hostPath = volumes[vm.name];
      if (hostPath !== undefined) {
        containerVolumes[hostPath] = { 
          bind: vm.mountPath, 
          options: vm.readOnly ? 'ro' : 'rw' 
        };
      }
    }
  }

  let memory: number | undefined;
  if (container.resources?.limits?.memory) {
    memory = parseMemory(container.resources.limits.memory);
  }

  let cpuShares: number | undefined;
  if (container.resources?.limits?.cpu) {
    cpuShares = parseCpu(container.resources.limits.cpu);
  }

  // Strip any traefik.* labels from user metadata to prevent route hijacking
  const containerLabels: Record<string, string> = Object.fromEntries(
    Object.entries(metadata.labels || {}).filter(
      ([k]) => !k.toLowerCase().startsWith('traefik.')
    )
  );

  return {
    name: container.name,
    image: container.image || `${container.name}:latest`,
    env,
    ports,
    volumes: containerVolumes,
    restartPolicy: restartPolicy || 'always',
    labels: containerLabels,
    command: container.command,
    args: container.args,
    workingDir: container.workingDir,
    memory,
    cpuShares,
  };
}

function parseMemory(memStr: string): number {
  const match = memStr.match(/^(\d+)([eEiKmMgG]?)$/);
  if (!match) return 0;
  
  const value = parseInt(match[1], 10);
  const unit = (match[2] || 'b').toLowerCase();
  
  switch (unit) {
    case 'e':
      return value * 1024 * 1024 * 1024 * 1024;
    case 'p':
      return value * 1024 * 1024 * 1024 * 1024;
    case 't':
      return value * 1024 * 1024 * 1024;
    case 'g':
      return value * 1024 * 1024 * 1024;
    case 'm':
      return value * 1024 * 1024;
    case 'k':
      return value * 1024;
    default:
      return value;
  }
}

function parseCpu(cpuStr: string): number {
  if (cpuStr.endsWith('m')) {
    return parseInt(cpuStr, 10);
  }
  return Math.floor(parseFloat(cpuStr) * 1024);
}

export function validateK8sManifest(manifest: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  try {
    const docs = manifest.split('---').map(doc => parseYaml(doc)).filter(Boolean);
    
    if (docs.length === 0) {
      errors.push('Empty manifest');
      return { valid: false, errors };
    }
    
    const supportedKinds = ['pod', 'deployment', 'service', 'configmap', 'secret', 'ingress'];
    
    for (const doc of docs) {
      if (!doc.kind) {
        errors.push('Missing kind in manifest');
        continue;
      }
      
      if (!supportedKinds.includes(doc.kind.toLowerCase())) {
        errors.push(`Unsupported kind: ${doc.kind}`);
      }
      
      if (!doc.apiVersion) {
        errors.push(`Missing apiVersion for kind: ${doc.kind}`);
      }
    }
  } catch (e: any) {
    errors.push(`YAML parse error: ${e.message}`);
  }
  
  return { valid: errors.length === 0, errors };
}
