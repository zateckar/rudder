<script lang="ts">
  import type { RegisteredVolume, VolumeMount } from './types';

  let {
    values = $bindable(),
    volumes = [],
  }: { values: VolumeMount[]; volumes?: RegisteredVolume[] } = $props();

  function add() {
    values.push({ volumeId: '', hostPath: '', containerPath: '', mode: 'rw' });
  }

  function remove(index: number) {
    values.splice(index, 1);
  }

  /**
   * Picking a registered volume fills in its paths and locks them; picking
   * "Custom" clears them so they can be typed. Without the clear, switching
   * away from a registered volume left its paths behind as editable text that
   * looked deliberate.
   */
  function select(mount: VolumeMount, volumeId: string) {
    mount.volumeId = volumeId;
    const registered = volumeId ? volumes.find((v) => v.id === volumeId) : undefined;
    mount.hostPath = registered ? registered.name : '';
    mount.containerPath = registered ? registered.containerPath : '';
  }
</script>

<div class="form-section">
  <div class="section-header">
    <h2>Volume Mounts</h2>
    <button type="button" class="btn-add" onclick={add} title="Add a volume mount">+ Add Volume</button>
  </div>
  <p class="help-text">Select a registered volume or enter a host path manually.</p>

  {#if values.length === 0}
    <p class="empty-hint">No volume mounts.</p>
  {:else}
    <div class="repeat-header volume-row">
      <span>Volume</span>
      <span>Host Path</span>
      <span>Container Path</span>
      <span>Mode</span>
      <span></span>
    </div>
    {#each values as mount, i (i)}
      <div class="repeat-row volume-row">
        <select
          value={mount.volumeId}
          onchange={(e) => select(mount, (e.currentTarget as HTMLSelectElement).value)}
        >
          <option value="">Custom</option>
          {#each volumes as volume}
            <option value={volume.id}>{volume.name}</option>
          {/each}
        </select>
        <input type="text" placeholder="/data/myapp" bind:value={mount.hostPath} disabled={!!mount.volumeId} />
        <input type="text" placeholder="/app/data" bind:value={mount.containerPath} disabled={!!mount.volumeId} />
        <select bind:value={mount.mode}>
          <option value="rw">Read/Write</option>
          <option value="ro">Read Only</option>
        </select>
        <button type="button" class="btn-remove" onclick={() => remove(i)} title="Remove this volume mount">
          ✕
        </button>
      </div>
    {/each}
  {/if}
</div>

<style>
  /* Volume, host path, container path, mode, remove. */
  .volume-row {
    grid-template-columns: 140px 1fr 1fr 110px 32px;
  }

  .volume-row:not(.repeat-header) {
    margin-bottom: 8px;
  }
</style>
