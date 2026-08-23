<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { enhance } from '$app/forms';

  let { data } = $props();
  let loading = $state(false);

  let worker = $derived(data.worker);
</script>

<PageHeader title="Edit Worker" back={{ href: `/workers/${worker.id}`, label: `Back to ${worker.name}` }} />

<div class="form-container">
  <form
    method="POST"
    use:enhance={() => {
      loading = true;
      return async ({ update }) => {
        await update();
        loading = false;
      };
    }}
  >
    <div class="form-section">
      <h2>Worker Details</h2>

      <div class="form-group">
        <label for="name">Worker Name</label>
        <input type="text" id="name" name="name" value={worker.name} required />
      </div>

      <div class="form-group">
        <label for="hostname">Hostname / IP Address</label>
        <input type="text" id="hostname" name="hostname" value={worker.hostname} required />
      </div>

      <div class="form-group">
        <label for="baseDomain">Base Domain (wildcard)</label>
        <input type="text" id="baseDomain" name="baseDomain" value={worker.baseDomain ?? ''} placeholder="e.g., gamma.apps.example.com" />
        <span class="form-hint">Used for routing: app-name.domain</span>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label for="sshPort">SSH Port</label>
          <input type="number" id="sshPort" name="sshPort" value={worker.sshPort} required />
        </div>
        <div class="form-group">
          <label for="sshUser">SSH User</label>
          <input type="text" id="sshUser" name="sshUser" value={worker.sshUser} required />
        </div>
      </div>
    </div>


    <div class="form-section">
      <h2>Podman API</h2>
      <div class="form-group">
        <label for="podmanApiUrl">Podman API URL</label>
        <input type="text" id="podmanApiUrl" name="podmanApiUrl" value={worker.podmanApiUrl} />
      </div>
    </div>

    <div class="form-actions">
      <a href="/workers/{worker.id}" class="btn-secondary btn-lg">Cancel</a>
      <button type="submit" class="btn-primary btn-lg" disabled={loading} title="Save worker configuration">
        {loading ? 'Saving…' : 'Save Changes'}
      </button>
    </div>
  </form>
</div>

<style></style>
