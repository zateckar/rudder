<script lang="ts">
  import { enhance } from '$app/forms';

  let { data } = $props();

  let showSaveModal = $state(false);
  let saveAppId = $state('');
  let saveName = $state('');
  let saveDescription = $state('');

  let showApplyModal = $state(false);
  let applyTemplateId = $state('');
  let applyName = $state('');
  let applyWorkerId = $state('');
  let applyTeamId = $state('');

  let actionError = $state('');
  let actionSuccess = $state('');
  let submitting = $state(false);

  function getTeamName(teamId: string): string {
    return data.teams.find((t: any) => t.id === teamId)?.name ?? 'Unknown';
  }

  function isOwner(teamId: string): boolean {
    return data.userTeamIds.includes(teamId);
  }

  function openSaveModal() {
    saveAppId = '';
    saveName = '';
    saveDescription = '';
    actionError = '';
    showSaveModal = true;
  }

  function openApplyModal(template: any) {
    applyTemplateId = template.id;
    applyName = '';
    applyWorkerId = '';
    applyTeamId = data.userTeamIds[0] ?? '';
    actionError = '';
    showApplyModal = true;
  }

  let myTemplates = $derived(data.templates.filter((t: any) => isOwner(t.teamId)));
  let sharedTemplates = $derived(
    data.templates.filter((t: any) => !isOwner(t.teamId) && t.shared)
  );
</script>

<header>
  <h1>Templates</h1>
  {#if data.applications.length > 0}
    <button class="btn-primary" onclick={openSaveModal} title="Save an existing application as a template">Save as Template</button>
  {/if}
</header>

{#if actionSuccess}
  <div class="toast success">{actionSuccess}</div>
{/if}
{#if actionError && !showSaveModal && !showApplyModal}
  <div class="toast error">{actionError}</div>
{/if}

<!-- ── My Templates ────────────────────────────────────────────── -->
{#if myTemplates.length > 0}
  <div class="section">
    <h2>My Team Templates</h2>
    <div class="template-grid">
      {#each myTemplates as tpl}
        {@const sourceApp = data.applications.find((a: any) => a.id === tpl.sourceAppId)}
        <div class="template-card">
          <div class="tpl-body">
            <div class="tpl-top">
              <span class="tpl-name">{tpl.name}</span>
              {#if tpl.shared}
                <span class="share-badge shared">shared</span>
              {:else}
                <span class="share-badge private">private</span>
              {/if}
            </div>
            {#if tpl.description}
              <p class="tpl-desc">{tpl.description}</p>
            {/if}
            <div class="tpl-meta">
              <span class="tpl-tag">{tpl.type}</span>
              {#if sourceApp}
                <span class="tpl-source">from <em>{sourceApp.name}</em></span>
              {/if}
              <span class="tpl-team">{getTeamName(tpl.teamId)}</span>
            </div>
          </div>
          <div class="tpl-footer">
            <div class="tpl-actions-left">
              {#if tpl.shared}
                <form method="POST" action="?/unshare" use:enhance={() => { return async ({ update }) => { await update(); }; }}>
                  <input type="hidden" name="templateId" value={tpl.id} />
                  <button type="submit" class="btn-tiny btn-unshare" title="Make this template private to your team">Unshare</button>
                </form>
              {:else}
                <form method="POST" action="?/share" use:enhance={() => { return async ({ update }) => { await update(); }; }}>
                  <input type="hidden" name="templateId" value={tpl.id} />
                  <button type="submit" class="btn-tiny btn-share" title="Share this template with all teams">Share</button>
                </form>
              {/if}
              <form method="POST" action="?/delete" use:enhance={() => { return async ({ update }) => { await update(); }; }}>
                <input type="hidden" name="templateId" value={tpl.id} />
                <button type="submit" class="btn-tiny btn-delete" onclick={(e: Event) => { if (!confirm('Delete this template?')) e.preventDefault(); }} title="Permanently delete this template">Delete</button>
              </form>
            </div>
            <button class="btn-apply" onclick={() => openApplyModal(tpl)} title="Deploy a new application from this template">Use Template</button>
          </div>
        </div>
      {/each}
    </div>
  </div>
{/if}

<!-- ── Shared Templates ────────────────────────────────────────── -->
{#if sharedTemplates.length > 0}
  <div class="section">
    <h2>Shared Templates</h2>
    <div class="template-grid">
      {#each sharedTemplates as tpl}
        <div class="template-card">
          <div class="tpl-body">
            <div class="tpl-top">
              <span class="tpl-name">{tpl.name}</span>
            </div>
            {#if tpl.description}
              <p class="tpl-desc">{tpl.description}</p>
            {/if}
            <div class="tpl-meta">
              <span class="tpl-tag">{tpl.type}</span>
              <span class="tpl-team">{getTeamName(tpl.teamId)}</span>
            </div>
          </div>
          <div class="tpl-footer">
            <span class="tpl-by">by {getTeamName(tpl.teamId)}</span>
            <button class="btn-apply" onclick={() => openApplyModal(tpl)} title="Deploy a new application from this template">Use Template</button>
          </div>
        </div>
      {/each}
    </div>
  </div>
{/if}

{#if data.templates.length === 0}
  <div class="empty-state">
    <div class="empty-icon">+</div>
    <p>No templates yet.</p>
    {#if data.applications.length > 0}
      <button class="btn-primary" onclick={openSaveModal} title="Save an existing application as a template">Save one from an existing application</button>
    {:else}
      <p class="muted">Deploy an application first, then save it as a template.</p>
    {/if}
  </div>
{/if}

<!-- ── Save as Template modal ───────────────────────────────────── -->
{#if showSaveModal}
  <div class="modal-backdrop" onclick={() => showSaveModal = false} onkeydown={(e) => e.key === 'Escape' && (showSaveModal = false)} role="button" tabindex="-1">
    <div class="modal" onclick={(e) => e.stopPropagation()} onkeydown={() => {}} role="dialog" tabindex="-1">
      <h3>Save as Template</h3>
      {#if actionError}
        <div class="toast error inline">{actionError}</div>
      {/if}
      <form
        method="POST"
        action="?/save"
        use:enhance={() => {
          submitting = true;
          actionError = '';
          return async ({ result, update }) => {
            submitting = false;
            if (result.type === 'failure') {
              actionError = (result.data as any)?.error || 'Failed to save template';
            } else {
              showSaveModal = false;
              actionSuccess = 'Template saved';
              setTimeout(() => actionSuccess = '', 3000);
              await update();
            }
          };
        }}
      >
        <div class="form-group">
          <label for="appId">Source Application</label>
          <select id="appId" name="appId" bind:value={saveAppId} required>
            <option value="">Select application…</option>
            {#each data.applications as app}
              <option value={app.id}>{app.name}</option>
            {/each}
          </select>
        </div>
        <div class="form-group">
          <label for="tplName">Template Name</label>
          <input type="text" id="tplName" name="name" bind:value={saveName} placeholder="my-template" required />
        </div>
        <div class="form-group">
          <label for="tplDesc">Description (optional)</label>
          <input type="text" id="tplDesc" name="description" bind:value={saveDescription} placeholder="What this template deploys" />
        </div>
        <div class="modal-actions">
          <button type="button" class="btn-secondary" onclick={() => showSaveModal = false} title="Close without saving">Cancel</button>
          <button type="submit" class="btn-primary" disabled={submitting || !saveAppId || !saveName} title="Save the selected application as a template">
            {submitting ? 'Saving…' : 'Save Template'}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

<!-- ── Apply Template modal ─────────────────────────────────────── -->
{#if showApplyModal}
  {@const tpl = data.templates.find((t: any) => t.id === applyTemplateId)}
  <div class="modal-backdrop" onclick={() => showApplyModal = false} onkeydown={(e) => e.key === 'Escape' && (showApplyModal = false)} role="button" tabindex="-1">
    <div class="modal" onclick={(e) => e.stopPropagation()} onkeydown={() => {}} role="dialog" tabindex="-1">
      <h3>Deploy from Template</h3>
      <p class="modal-subtitle">Template: <strong>{tpl?.name}</strong></p>
      {#if actionError}
        <div class="toast error inline">{actionError}</div>
      {/if}
      <form
        method="POST"
        action="?/apply"
        use:enhance={() => {
          submitting = true;
          actionError = '';
          return async ({ result, update }) => {
            submitting = false;
            if (result.type === 'failure') {
              actionError = (result.data as any)?.error || 'Failed to deploy';
            } else {
              showApplyModal = false;
              await update();
            }
          };
        }}
      >
        <input type="hidden" name="templateId" value={applyTemplateId} />
        <div class="form-group">
          <label for="appName">Application Name</label>
          <input type="text" id="appName" name="name" bind:value={applyName} placeholder="my-app" required />
          <p class="help-text">Lowercase letters, numbers, and hyphens only</p>
        </div>
        <div class="form-group">
          <label for="appWorker">Worker</label>
          <select id="appWorker" name="workerId" bind:value={applyWorkerId} required>
            <option value="">Select worker…</option>
            {#each data.workers.filter((w: any) => w.baseDomain) as worker}
              <option value={worker.id}>{worker.name} ({worker.baseDomain})</option>
            {/each}
          </select>
        </div>
        <div class="form-group">
          <label for="appTeam">Team</label>
          <select id="appTeam" name="teamId" bind:value={applyTeamId} required>
            {#each data.teams.filter((t: any) => data.userTeamIds.includes(t.id)) as team}
              <option value={team.id}>{team.name}</option>
            {/each}
          </select>
        </div>
        {#if applyName && applyWorkerId}
          {@const w = data.workers.find((w: any) => w.id === applyWorkerId)}
          {#if w?.baseDomain}
            <div class="domain-preview">
              <span class="domain-label">URL:</span>
              <code>https://{applyName}.{w.baseDomain}</code>
            </div>
          {/if}
        {/if}
        <div class="modal-actions">
          <button type="button" class="btn-secondary" onclick={() => showApplyModal = false} title="Close without deploying">Cancel</button>
          <button type="submit" class="btn-primary" disabled={submitting || !applyName || !applyWorkerId || !applyTeamId} title="Deploy a new application from this template">
            {submitting ? 'Deploying…' : 'Deploy'}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

<style>
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 24px;
  }

  header h1 {
    font-size: 26px;
    font-weight: 700;
    color: var(--text-primary);
    letter-spacing: -0.02em;
  }

  .btn-primary {
    padding: 9px 18px;
    background: var(--accent);
    color: var(--text-inverse);
    border-radius: var(--radius-sm);
    font-weight: 600;
    font-size: 13px;
    text-decoration: none;
    border: none;
    cursor: pointer;
    transition: background 0.15s;
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .btn-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-secondary {
    padding: 9px 18px;
    background: var(--bg-raised);
    color: var(--text-primary);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    font-size: 13px;
    cursor: pointer;
    transition: background 0.15s;
  }

  .btn-secondary:hover {
    background: var(--bg-hover);
  }

  /* ── Toast ────────────────────────────────────── */

  .toast {
    padding: 10px 16px;
    border-radius: var(--radius-sm);
    font-size: 13px;
    font-weight: 500;
    margin-bottom: 16px;
  }

  .toast.success {
    background: var(--green-subtle);
    color: var(--green-text);
    border: 1px solid var(--green);
  }

  .toast.error {
    background: var(--red-subtle);
    color: var(--red-text);
    border: 1px solid var(--red);
  }

  .toast.inline {
    margin-bottom: 12px;
  }

  /* ── Sections ─────────────────────────────────── */

  .section {
    margin-bottom: 32px;
  }

  .section h2 {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 14px;
  }

  /* ── Template Grid ────────────────────────────── */

  .template-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 14px;
  }

  .template-card {
    background: var(--bg-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    transition: border-color 0.15s, box-shadow 0.15s;
    overflow: hidden;
  }

  .template-card:hover {
    border-color: var(--border-default);
    box-shadow: 0 2px 16px rgba(0, 0, 0, 0.3);
  }

  .tpl-body {
    padding: 18px 20px 12px;
  }

  .tpl-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
  }

  .tpl-name {
    font-size: 16px;
    font-weight: 650;
    color: var(--text-primary);
    letter-spacing: -0.01em;
  }

  .share-badge {
    font-size: 10px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .share-badge.shared {
    background: var(--accent-subtle);
    color: var(--accent-text);
  }

  .share-badge.private {
    background: var(--bg-overlay);
    color: var(--text-muted);
  }

  .tpl-desc {
    font-size: 12.5px;
    color: var(--text-secondary);
    margin: 4px 0;
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .tpl-meta {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 8px;
    font-size: 12px;
    color: var(--text-muted);
  }

  .tpl-tag {
    padding: 2px 8px;
    background: var(--bg-overlay);
    border-radius: var(--radius-sm);
    font-size: 11px;
    font-weight: 500;
    color: var(--text-secondary);
  }

  .tpl-source em {
    color: var(--text-secondary);
  }

  .tpl-team {
    font-weight: 500;
  }

  /* ── Footer ───────────────────────────────────── */

  .tpl-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 20px;
    background: var(--bg-surface);
    border-top: 1px solid var(--border-subtle);
  }

  .tpl-actions-left {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .tpl-by {
    font-size: 11px;
    color: var(--text-muted);
  }

  .btn-tiny {
    padding: 3px 10px;
    border-radius: var(--radius-sm);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid var(--border-default);
    background: var(--bg-raised);
    color: var(--text-secondary);
    transition: background 0.15s;
  }

  .btn-tiny:hover {
    background: var(--bg-hover);
  }

  .btn-share {
    color: var(--blue);
    border-color: var(--blue);
    background: var(--blue-subtle);
  }

  .btn-share:hover {
    background: var(--bg-active);
  }

  .btn-unshare {
    color: var(--yellow);
    border-color: var(--yellow);
    background: var(--yellow-subtle);
  }

  .btn-unshare:hover {
    background: var(--bg-active);
  }

  .btn-delete {
    color: var(--red-text);
    border-color: var(--red);
    background: var(--red-subtle);
  }

  .btn-delete:hover {
    background: var(--bg-active);
  }

  .btn-apply {
    padding: 5px 14px;
    background: var(--accent);
    color: var(--text-inverse);
    border: none;
    border-radius: var(--radius-sm);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s;
  }

  .btn-apply:hover {
    background: var(--accent-hover);
  }

  /* ── Empty state ──────────────────────────────── */

  .empty-state {
    background: var(--bg-surface);
    border: 1px dashed var(--border-default);
    padding: 60px;
    border-radius: var(--radius-lg);
    text-align: center;
  }

  .empty-icon {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: var(--bg-raised);
    color: var(--text-muted);
    font-size: 24px;
    line-height: 48px;
    margin: 0 auto 16px;
  }

  .empty-state p {
    color: var(--text-secondary);
    margin-bottom: 16px;
    font-size: 14px;
  }

  .muted {
    color: var(--text-muted);
    font-size: 13px;
  }

  /* ── Modal ────────────────────────────────────── */

  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal {
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    padding: 28px;
    border-radius: var(--radius-lg);
    width: 100%;
    max-width: 440px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  }

  .modal h3 {
    margin: 0 0 4px;
    font-size: 18px;
    font-weight: 700;
    color: var(--text-primary);
  }

  .modal-subtitle {
    font-size: 13px;
    color: var(--text-secondary);
    margin-bottom: 20px;
  }

  .form-group {
    margin-bottom: 16px;
  }

  .form-group label {
    display: block;
    margin-bottom: 6px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-primary);
  }

  .form-group input,
  .form-group select {
    width: 100%;
    padding: 9px 12px;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    font-size: 14px;
    background: var(--bg-input);
    color: var(--text-primary);
    box-sizing: border-box;
    transition: border-color 0.15s;
  }

  .form-group input:focus,
  .form-group select:focus {
    outline: none;
    border-color: var(--border-focus);
  }

  .help-text {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 4px;
  }

  .domain-preview {
    background: var(--blue-subtle);
    border: 1px solid var(--blue);
    border-radius: var(--radius-sm);
    padding: 10px 14px;
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .domain-label {
    font-size: 13px;
    color: var(--text-secondary);
    font-weight: 500;
  }

  .domain-preview code {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--blue);
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 20px;
  }
</style>
