/**
 * The three repeating rows an application form edits.
 *
 * `applications/new` and `applications/[id]/edit` each declared these
 * interfaces, and the six add/remove helpers that went with them, verbatim.
 */

export interface EnvVar {
  key: string;
  value: string;
  secret: boolean;
}

export interface PortMapping {
  containerPort: string;
  hostPort: string;
  protocol: string;
}

export interface VolumeMount {
  volumeId: string;
  hostPath: string;
  containerPath: string;
  mode: string;
}

/** A volume already registered with Rudder, offered in the volume picker. */
export interface RegisteredVolume {
  id: string;
  name: string;
  containerPath: string;
}
