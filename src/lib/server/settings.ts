/**
 * Reading operator-tunable numbers out of `system_settings`.
 *
 * Extracted from the metrics collector once a second background loop needed the
 * same thing. An out-of-range or unparseable value falls back to the default
 * rather than propagating: these feed `setTimeout`, and a NaN interval is a
 * background loop that never runs again.
 */

import { db } from '$lib/db';
import { systemSettings } from '$lib/db/schema';
import { eq } from 'drizzle-orm';

export async function numericSetting(
  key: string,
  defaultValue: number,
  min: number,
  max: number,
): Promise<number> {
  try {
    const row = await db.select().from(systemSettings).where(eq(systemSettings.key, key)).get();
    if (row) {
      const val = parseInt(row.value);
      if (val >= min && val <= max) return val;
    }
  } catch {
    // No table yet (first boot, before init) — the default is correct.
  }
  return defaultValue;
}
