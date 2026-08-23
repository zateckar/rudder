<script lang="ts">
  import type { EnvVar } from './types';

  let { values = $bindable() }: { values: EnvVar[] } = $props();

  function add() {
    values.push({ key: '', value: '', secret: false });
  }

  function remove(index: number) {
    values.splice(index, 1);
  }
</script>

<div class="form-section">
  <div class="section-header">
    <h2>Environment Variables</h2>
    <button type="button" class="btn-add" onclick={add} title="Add an environment variable">
      + Add Variable
    </button>
  </div>

  {#if values.length === 0}
    <p class="empty-hint">No environment variables. Click "+ Add Variable" to add one.</p>
  {:else}
    <div class="kv-list">
      <!-- Keyed by index because rows have no identity of their own: two blank
           rows are indistinguishable until they are typed into. -->
      {#each values as env, i (i)}
        <div class="repeat-row env-row">
          <input type="text" class="mono" placeholder="VARIABLE_NAME" bind:value={env.key} />
          <input
            type={env.secret ? 'password' : 'text'}
            class="mono"
            placeholder="value"
            bind:value={env.value}
          />
          <label class="repeat-toggle" title="Mark as secret (masked)">
            <input type="checkbox" bind:checked={env.secret} />
            <span>🔒</span>
          </label>
          <button type="button" class="btn-remove" onclick={() => remove(i)} title="Remove this variable">
            ✕
          </button>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .kv-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  /* Name, value, secret toggle, remove. Everything else about the row comes
     from `.repeat-row` in the shared sheet. */
  .env-row {
    grid-template-columns: 1fr 1fr auto auto;
  }
</style>
