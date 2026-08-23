<script lang="ts">
  import type { PortMapping } from './types';

  let { values = $bindable() }: { values: PortMapping[] } = $props();

  function add() {
    values.push({ containerPort: '', hostPort: '', protocol: 'tcp' });
  }

  function remove(index: number) {
    values.splice(index, 1);
  }
</script>

<div class="form-section">
  <div class="section-header">
    <h2>Port Mappings</h2>
    <button type="button" class="btn-add" onclick={add} title="Add a port mapping">+ Add Port</button>
  </div>
  <p class="help-text">Map container ports to host ports so they are reachable from outside.</p>

  {#if values.length === 0}
    <p class="empty-hint">No port mappings. The app will be accessible via Traefik only.</p>
  {:else}
    <div class="repeat-header port-row">
      <span>Container Port</span>
      <span>Host Port</span>
      <span>Protocol</span>
      <span></span>
    </div>
    {#each values as port, i (i)}
      <div class="repeat-row port-row">
        <input type="text" placeholder="80" bind:value={port.containerPort} />
        <input type="text" placeholder="auto" bind:value={port.hostPort} />
        <select bind:value={port.protocol}>
          <option value="tcp">TCP</option>
          <option value="udp">UDP</option>
        </select>
        <button type="button" class="btn-remove" onclick={() => remove(i)} title="Remove this port mapping">
          ✕
        </button>
      </div>
    {/each}
  {/if}
</div>

<style>
  /* Container port, host port, protocol, remove. */
  .port-row {
    grid-template-columns: 1fr 1fr 100px 32px;
  }

  .port-row:not(.repeat-header) {
    margin-bottom: 8px;
  }
</style>
