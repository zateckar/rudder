<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { enhance } from '$app/forms';

  let { data } = $props();
  let loading = $state(false);
</script>

<PageHeader title="Add New Worker" />

<div class="form-container">
  <form method="POST" use:enhance={() => {
    loading = true;
    return async ({ update }) => {
      await update();
      loading = false;
    };
  }}>
    <div class="form-section">
      <h2>Worker Details</h2>

      <div class="form-group">
        <label for="name">Worker Name</label>
        <input type="text" id="name" name="name" placeholder="e.g., worker-1" required />
      </div>

      <div class="form-group">
        <label for="hostname">Hostname / IP Address</label>
        <input type="text" id="hostname" name="hostname" placeholder="e.g., 192.168.1.100 or worker1.example.com" required />
      </div>

      <div class="form-group">
        <label for="baseDomain">Base Domain (wildcard)</label>
        <input type="text" id="baseDomain" name="baseDomain" placeholder="e.g., gamma.apps.example.com (for *.gamma.apps.example.com)" />
        <span class="form-hint">Used for routing: podman-api.&lt;domain&gt;, &lt;app&gt;.&lt;domain&gt;</span>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label for="sshPort">SSH Port</label>
          <input type="number" id="sshPort" name="sshPort" value="22" required />
        </div>
        <div class="form-group">
          <label for="sshUser">SSH User</label>
          <input type="text" id="sshUser" name="sshUser" placeholder="e.g., root" required />
        </div>
      </div>
    </div>

    <div class="form-actions">
      <a href="/workers" class="btn-secondary btn-lg">Cancel</a>
      <button type="submit" class="btn-primary btn-lg" disabled={loading} title="Create the new worker">
        {loading ? 'Creating...' : 'Create Worker'}
      </button>
    </div>
  </form>
</div>

<style>
  .form-section:last-child {
    border-bottom: none;
    padding-bottom: 0;
  }
</style>
