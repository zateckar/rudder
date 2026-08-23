/**
 * Which lifecycle controls the application detail header offers.
 *
 * Tested rather than eyeballed because reproducing the interesting states means
 * finding an application that happens to be in them: a five-service compose app
 * with two containers down, a retained previous generation sitting alongside a
 * live one. The rules are three lines and every one of them is a way to strand
 * an operator.
 */
import { describe, expect, test } from 'bun:test';
import { lifecycleControls, lifecycleLabel } from './lifecycle-controls';

const running = (state = 'active') => ({ state, status: 'running' });
const exited = (state = 'active') => ({ state, status: 'exited' });

describe('lifecycleControls', () => {
  test('a fully running application offers Stop and Restart, not Start', () => {
    const c = lifecycleControls([running(), running(), running()]);

    expect(c).toEqual({
      activeCount: 3,
      runningCount: 3,
      canStart: false,
      canStopOrRestart: true,
      confirmRestart: true,
    });
  });

  test('a fully stopped application offers only Start', () => {
    const c = lifecycleControls([exited(), exited()]);

    expect(c.canStart).toBe(true);
    expect(c.canStopOrRestart).toBe(false);
  });

  test('a partially running application offers all three', () => {
    // The state these controls exist for. Hiding Start here would leave the
    // application unrecoverable without going container by container.
    const c = lifecycleControls([running(), exited(), running()]);

    expect(c.canStart).toBe(true);
    expect(c.canStopOrRestart).toBe(true);
    expect(c.runningCount).toBe(2);
  });

  test('anything Podman does not call running counts as down', () => {
    // `containers.status` is free text, so 'missing' and 'created' are both
    // real values and neither is running.
    const c = lifecycleControls([
      { state: 'active', status: 'missing' },
      { state: 'active', status: 'created' },
    ]);

    expect(c.runningCount).toBe(0);
    expect(c.canStart).toBe(true);
    expect(c.canStopOrRestart).toBe(false);
  });

  test('ignores generations that are not serving', () => {
    // The count has to match what /api/applications/deploy touches, or the
    // button offers to stop four containers and the endpoint stops two.
    const c = lifecycleControls([
      running('active'),
      running('active'),
      running('superseded'),
      running('pending'),
    ]);

    expect(c.activeCount).toBe(2);
    expect(c.runningCount).toBe(2);
  });

  test('a retained generation alone is not something to act on', () => {
    // Everything superseded means the live generation is gone; the header shows
    // no lifecycle controls and Deploy is the way out.
    const c = lifecycleControls([running('superseded'), exited('superseded')]);

    expect(c.activeCount).toBe(0);
    expect(c.canStart).toBe(false);
    expect(c.canStopOrRestart).toBe(false);
  });

  test('nothing deployed offers nothing', () => {
    expect(lifecycleControls([])).toEqual({
      activeCount: 0,
      runningCount: 0,
      canStart: false,
      canStopOrRestart: false,
      confirmRestart: false,
    });
  });

  test('a single container restarts without a prompt', () => {
    // Matching the per-container Restart button, which does not ask either.
    expect(lifecycleControls([running()]).confirmRestart).toBe(false);
    expect(lifecycleControls([running(), running()]).confirmRestart).toBe(true);
  });
});

describe('lifecycleLabel', () => {
  test('names the count only when there is more than one container', () => {
    expect(lifecycleLabel('Stop', 1)).toBe('Stop');
    expect(lifecycleLabel('Stop', 3)).toBe('Stop all (3)');
    expect(lifecycleLabel('Restart', 12)).toBe('Restart all (12)');
  });

  test('says nothing odd when there is nothing to act on', () => {
    // Not rendered in this case, but "Start all (0)" would be a bug worth
    // catching here rather than in a screenshot.
    expect(lifecycleLabel('Start', 0)).toBe('Start');
  });
});
