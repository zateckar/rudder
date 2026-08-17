<script lang="ts">
  import { enhance } from '$app/forms';
  import { confirmAction } from '$lib/client/dialog.svelte';

  let { data } = $props();

  /**
   * Guard a form submit with the in-page confirmation.
   *
   * `confirm()` was synchronous, so it could veto the submit inline. The
   * replacement is a promise, so the submit is always cancelled and then
   * re-issued from the form itself once the answer comes back.
   */
  function confirmDelete(templateName: string) {
    return async (event: Event) => {
      const button = event.currentTarget as HTMLButtonElement;
      if (button.dataset.confirmed === 'true') {
        delete button.dataset.confirmed;
        return;
      }
      event.preventDefault();
      const ok = await confirmAction({
        title: `Delete the template "${templateName}"?`,
        body: 'Applications already created from it are unaffected.',
        confirmLabel: 'Delete template',
        danger: true,
      });
      if (!ok) return;
      button.dataset.confirmed = 'true';
      button.click();
    };
  }

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

  let myTemplates = $derived(data.templates.filter((t: any) => isOwner(t.teamId) || t.createdBy === data.user?.id));
  let sharedTemplates = $derived(
    data.templates.filter((t: any) => !isOwner(t.teamId) && t.shared && t.createdBy !== data.user?.id)
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
    <div class="template-list">
      {#each myTemplates as tpl}
        {@const sourceApp = data.applications.find((a: any) => a.id === tpl.sourceAppId)}
        <div class="template-row">
          <div class="tpl-main">
            <div class="tpl-identity">
              <span class="tpl-name">{tpl.name}</span>
              <span class="tpl-type-tag">{tpl.type}</span>
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
              {#if sourceApp}
                <span class="tpl-source">from <em>{sourceApp.name}</em></span>
              {/if}
              <span class="tpl-team">{getTeamName(tpl.teamId)}</span>
            </div>
          </div>
          <div class="tpl-actions">
            <div class="tpl-management">
              {#if tpl.shared}
                <form method="POST" action="?/unshare" use:enhance={() => { return async ({ update }) => { await update(); }; }}>
                  <input type="hidden" name="templateId" value={tpl.id} />
                  <button type="submit" class="btn-action" title="Make private">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 8.5C2.5 5.46243 4.96243 3 8 3C11.0376 3 13.5 5.46243 13.5 8.5V13.5H2.5V8.5Z" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 10V11" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    Unshare
                  </button>
                </form>
              {:else}
                <form method="POST" action="?/share" use:enhance={() => { return async ({ update }) => { await update(); }; }}>
                  <input type="hidden" name="templateId" value={tpl.id} />
                  <button type="submit" class="btn-action" title="Share with all teams">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3L12 7M8 3L4 7M8 3V13" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    Share
                  </button>
                </form>
              {/if}
              <!-- The confirmation is async, so the submit is always cancelled
                   and re-issued once the operator has answered. -->
              <form method="POST" action="?/delete" use:enhance={() => { return async ({ update }) => { await update(); }; }}>
                <input type="hidden" name="templateId" value={tpl.id} />
                <!-- Icon-only, so it needs a name a screen reader can read;
                     `title` is a tooltip, not an accessible label. -->
                <button type="submit" class="btn-action btn-danger" onclick={confirmDelete(tpl.name)} title="Delete template" aria-label="Delete template {tpl.name}">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4H13M5 4V3C5 2.44772 5.44772 2 6 2H10C10.5523 2 11 2.44772 11 3V4M6 7V11M10 7V11M4 4L4.5 13C4.5 13.5523 4.94772 14 5.5 14H10.5C11.0523 14 11.5 13.5523 11.5 13L12 4" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
              </form>
            </div>
            <button class="btn-use" onclick={() => openApplyModal(tpl)}>
              Use Template
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3l5 5-5 5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
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
    <div class="template-list">
      {#each sharedTemplates as tpl}
        <div class="template-row shared">
          <div class="tpl-main">
            <div class="tpl-identity">
              <span class="tpl-name">{tpl.name}</span>
              <span class="tpl-type-tag">{tpl.type}</span>
            </div>
            {#if tpl.description}
              <p class="tpl-desc">{tpl.description}</p>
            {/if}
            <div class="tpl-meta">
              <span class="tpl-by">by {getTeamName(tpl.teamId)}</span>
            </div>
          </div>
          <div class="tpl-actions">
            <button class="btn-use" onclick={() => openApplyModal(tpl)}>
              Use Template
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3l5 5-5 5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
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
            } else if (result.type === 'error') {
              actionError = 'An unexpected error occurred';
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
            } else if (result.type === 'error') {
              actionError = 'An unexpected error occurred';
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

  /* ── Template List ────────────────────────────── */
  .template-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .template-row {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: 16px 20px;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    gap: 20px;
  }

  .template-row:hover {
    background: var(--bg-raised);
    border-color: var(--border-default);
    transform: translateX(4px);
    box-shadow: var(--shadow-md);
  }

  .template-row.shared {
    border-left: 3px solid var(--accent);
  }

  .tpl-main {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .tpl-identity {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .tpl-name {
    font-size: 16px;
    font-weight: 650;
    color: var(--text-primary);
    letter-spacing: -0.01em;
  }

  .tpl-type-tag {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    background: var(--bg-overlay);
    color: var(--text-muted);
    padding: 2px 8px;
    border-radius: 4px;
    border: 1px solid var(--border-subtle);
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
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.4;
    max-width: 600px;
  }

  .tpl-meta {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 4px;
  }

  .tpl-source em {
    color: var(--text-secondary);
    font-style: normal;
    font-weight: 500;
  }

  .tpl-team, .tpl-by {
    font-weight: 500;
  }

  .tpl-actions {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .tpl-management {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-right: 16px;
    border-right: 1px solid var(--border-subtle);
  }

  .btn-action {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: var(--bg-overlay);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 500;
    transition: all 0.15s;
    cursor: pointer;
  }

  .btn-action:hover {
    background: var(--bg-active);
    color: var(--text-primary);
    border-color: var(--border-default);
  }

  .btn-action.btn-danger:hover {
    background: var(--red-subtle);
    color: var(--red-text);
    border-color: var(--red);
  }

  .btn-use {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    background: var(--accent);
    color: var(--bg-root);
    border: none;
    border-radius: var(--radius-sm);
    font-size: 13px;
    font-weight: 600;
    transition: all 0.15s;
    cursor: pointer;
  }

  .btn-use:hover {
    background: var(--accent-hover);
    transform: translateY(-1px);
    box-shadow: 0 4px 12px var(--accent-subtle);
  }

  .btn-use svg {
    transition: transform 0.15s;
  }

  .btn-use:hover svg {
    transform: translateX(2px);
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
