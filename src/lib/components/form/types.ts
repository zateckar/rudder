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
  /**
   * Mount source. An absolute path is a host directory; anything else is a
   * named Podman volume, mounted under that literal name. See
   * `isHostPathSource` in `$lib/server/volumes` — the field name is what the
   * stored JSON has always called it, not what it means.
   */
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
