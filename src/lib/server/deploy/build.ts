/**
 * The last place an application's *type* is looked at.
 *
 * Three formats, three parsers, one `DeploymentPlan`. Everything downstream —
 * secrets, digests, labels, rows, generations, start, verification — is written
 * once and reads only the plan.
 */
import { parseCompose, validateCompose } from '../compose';
import { parseK8sManifest, validateK8sManifest } from '../kubernetes';
import { parseSingle } from '../single';
import type { MountIntent } from '../mounts';
import { ManifestError, type DeploymentPlan, type PlanContext } from './plan';

export interface BuildPlanInput {
  /** `applications.type`; anything unrecognised is treated as single-container. */
  type: string | null | undefined;
  manifest: string;
  /**
   * Mount intents for the single-container format, resolved by the caller
   * because the volume registry lives in the database and parsers do not.
   */
  singleMounts?: MountIntent[];
}

/**
 * Read a manifest into a plan, or refuse it.
 *
 * Everything a parser throws becomes a `ManifestError`, which the deploy path
 * reports as a 400. A parser only ever fails because the manifest cannot be
 * deployed as written, and the user is the one who can fix it.
 */
export function buildDeploymentPlan(input: BuildPlanInput, ctx: PlanContext): DeploymentPlan {
  try {
    switch (input.type) {
      case 'compose': {
        const validation = validateCompose(input.manifest);
        if (!validation.valid) throw new ManifestError(validation.errors.join(', '));
        return parseCompose(input.manifest, ctx);
      }
      case 'k8s': {
        const validation = validateK8sManifest(input.manifest);
        if (!validation.valid) throw new ManifestError(validation.errors.join(', '));
        return parseK8sManifest(input.manifest, ctx);
      }
      default:
        return parseSingle(input.manifest, ctx, { mounts: input.singleMounts });
    }
  } catch (e: any) {
    if (e instanceof ManifestError) throw e;
    throw new ManifestError(e?.message ?? String(e));
  }
}
