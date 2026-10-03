<script lang="ts">
  import {
    DEFAULT_IMAGE_UPDATE_INTERVAL_MINUTES,
    MAX_IMAGE_UPDATE_INTERVAL_MINUTES,
  } from '$lib/image-update-settings';

  let {
    enabled = $bindable(false),
    intervalMinutes = $bindable(DEFAULT_IMAGE_UPDATE_INTERVAL_MINUTES),
  }: {
    enabled?: boolean;
    intervalMinutes?: number;
  } = $props();
</script>

<div class="form-section">
  <h2>Automatic Image Updates</h2>

  <input type="hidden" name="autoUpdateEnabled" value={enabled ? 'true' : 'false'} />

  <div class="form-group">
    <label for="autoUpdateEnabled" class="checkbox-label">
      <input
        type="checkbox"
        id="autoUpdateEnabled"
        bind:checked={enabled}
        aria-describedby="image-update-help"
      />
      <span>Automatically deploy new images</span>
    </label>
    <p class="help-text" id="image-update-help">
      Check the configured image tags and deploy when an image changes. Digest-pinned images
      are skipped, and applications you stop manually stay stopped.
    </p>
  </div>

  <div class="form-group interval-field">
    <label for="autoUpdateIntervalMinutes">Check interval (minutes)</label>
    <input
      type="number"
      id="autoUpdateIntervalMinutes"
      name="autoUpdateIntervalMinutes"
      bind:value={intervalMinutes}
      min="1"
      max={MAX_IMAGE_UPDATE_INTERVAL_MINUTES}
      step="1"
      placeholder={String(DEFAULT_IMAGE_UPDATE_INTERVAL_MINUTES)}
      aria-describedby="image-update-interval-help"
    />
    <p class="help-text" id="image-update-interval-help">
      Defaults to one hour (60 minutes). Requires a successful deployment; deploy saved
      manifest changes manually before automatic checks can resume.
    </p>
  </div>
</div>

<style>
  .help-text {
    margin-bottom: 8px;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
  }

  .checkbox-label input {
    margin: 0;
    flex-shrink: 0;
  }

  .interval-field {
    max-width: 360px;
    margin-bottom: 0;
  }
</style>
