export const DEFAULT_IMAGE_UPDATE_INTERVAL_MINUTES = 60;
export const MAX_IMAGE_UPDATE_INTERVAL_MINUTES = 10080;
export const IMAGE_UPDATE_INTERVAL_ERROR =
  `Image update check interval must be a whole number from 1 to ${MAX_IMAGE_UPDATE_INTERVAL_MINUTES} minutes.`;

/** Empty input uses the default; reject coercions such as fractions or booleans. */
export function parseImageUpdateInterval(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_IMAGE_UPDATE_INTERVAL_MINUTES;
  }

  let minutes: number;
  if (typeof raw === 'number') {
    minutes = raw;
  } else if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    minutes = Number(raw.trim());
  } else {
    return null;
  }

  return Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_IMAGE_UPDATE_INTERVAL_MINUTES
    ? minutes
    : null;
}

interface ImageUpdateSettings {
  autoUpdateEnabled: boolean;
  autoUpdateIntervalMinutes: number;
}

/** Missing edit fields preserve settings. Only changed settings reset the clock. */
export function parseImageUpdateFormSettings(
  formData: FormData,
  current?: ImageUpdateSettings,
): (ImageUpdateSettings & { autoUpdateLastCheckedAt?: null }) | null {
  const enabledRaw = formData.get('autoUpdateEnabled');
  const intervalRaw = formData.get('autoUpdateIntervalMinutes');
  const autoUpdateEnabled = enabledRaw === null
    ? (current?.autoUpdateEnabled ?? false)
    : enabledRaw === 'true';
  const autoUpdateIntervalMinutes = intervalRaw === null && current
    ? current.autoUpdateIntervalMinutes
    : parseImageUpdateInterval(intervalRaw);
  if (autoUpdateIntervalMinutes === null) return null;

  const changed = current && (
    current.autoUpdateEnabled !== autoUpdateEnabled ||
    current.autoUpdateIntervalMinutes !== autoUpdateIntervalMinutes
  );
  return {
    autoUpdateEnabled,
    autoUpdateIntervalMinutes,
    ...(changed ? { autoUpdateLastCheckedAt: null } : {}),
  };
}
