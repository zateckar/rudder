<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { browser } from '$app/environment';

  let {
    children,
    user,
    activePage,
    pathname,
  }: {
    children?: any;
    user?: { username: string; role: string; id: string } | null;
    activePage: string;
    pathname?: string;
  } = $props();

  let teams = $state<any[]>([]);
  let selectedTeam = $state<string | null>(null);

  $effect(() => {
    if (!browser) return;
    fetch('/api/teams')
      .then((r) => r.json())
      .then((data) => {
        teams = data;
        if (data.length > 0) {
          const urlTeam = $page.url.searchParams.get('team');
          if (urlTeam && data.find((t: any) => t.id === urlTeam)) {
            selectedTeam = urlTeam;
          } else {
            const saved = localStorage.getItem('rudder_team_id');
            if (saved && data.find((t: any) => t.id === saved)) {
              selectedTeam = saved;
            } else {
              selectedTeam = data[0].id;
            }
          }
          localStorage.setItem('rudder_team_id', selectedTeam!);
        }
      })
      .catch(console.error);
  });

  function updateTeam(e: Event) {
    const target = e.target as HTMLSelectElement;
    if (target.value) {
      localStorage.setItem('rudder_team_id', target.value);
      const url = new URL(window.location.href);
      url.searchParams.set('team', target.value);
      window.location.href = url.toString();
    }
  }

  const isAdmin = $derived(user?.role === 'admin');
</script>

<div class="layout">
  <aside class="sidebar">
    <div class="logo">
      <div class="logo-mark">R</div>
      <span class="logo-text">Rudder</span>
    </div>

    {#if teams.length > 0}
      <div class="team-selector">
        <select value={selectedTeam} onchange={updateTeam}>
          {#if isAdmin}
            <option value="all">All Teams</option>
          {/if}
          {#each teams as team}
            <option value={team.id}>{team.name}</option>
          {/each}
        </select>
      </div>
    {/if}

    <nav>
      <div class="nav-label">Overview</div>
      <a href="/dashboard" class:active={activePage === 'dashboard'}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="1" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="9" y="1" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="1" y="9" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="9" y="9" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.5"/></svg>
        Dashboard
      </a>
      <a href="/applications" class:active={activePage === 'applications'}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 5l6-3 6 3v6l-6 3-6-3V5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M2 5l6 3m0 0l6-3M8 8v6" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
        Applications
      </a>
      <a href="/templates" class:active={activePage === 'templates'}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M5 6h6M5 8h4M5 10h5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
        Templates
      </a>
      <a href="/stacks" class:active={activePage === 'stacks'}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="3" y="2" width="10" height="3" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="3" y="6.5" width="10" height="3" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="3" y="11" width="10" height="3" rx="1" stroke="currentColor" stroke-width="1.3"/></svg>
        Stacks
      </a>
      <a href="/teams" class:active={activePage === 'teams'}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="6" cy="5" r="2.5" stroke="currentColor" stroke-width="1.5"/><circle cx="11" cy="5" r="2" stroke="currentColor" stroke-width="1.3"/><path d="M1 13c0-2.5 2.2-4 5-4s5 1.5 5 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M11 9c1.8 0 3.5 1 3.5 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        Teams
      </a>
      <a href="/settings/volumes" class:active={pathname === '/settings/volumes'}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><ellipse cx="8" cy="4" rx="6" ry="2" stroke="currentColor" stroke-width="1.5"/><path d="M2 4v3c0 1.1 2.7 2 6 2s6-.9 6-2V4" stroke="currentColor" stroke-width="1.5"/><path d="M2 7v3c0 1.1 2.7 2 6 2s6-.9 6-2V7" stroke="currentColor" stroke-width="1.5"/></svg>
        Volumes
      </a>

      <div class="nav-label">Secrets</div>
      <a href="/secrets" class:active={pathname === '/secrets' || pathname === '/settings'}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="3" y="6" width="10" height="7" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M5 6V4a3 3 0 016 0v2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="10" r="1" fill="currentColor"/></svg>
        Secrets
      </a>

      {#if isAdmin}
        <div class="nav-label">Admin</div>
        <a href="/workers" class:active={activePage === 'workers'}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M5 7h6M5 9h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="12" cy="5" r="1" fill="currentColor"/></svg>
          Workers
        </a>
        <a href="/admin" class:active={activePage === 'admin'}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1l1.8 3.6L14 5.3l-3 2.9.7 4.1L8 10.5l-3.7 1.8.7-4.1-3-2.9 4.2-.7L8 1z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
          Admin
        </a>
        <a href="/settings/audit" class:active={pathname === '/settings/audit'}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M3 7h7M3 10h9M3 13h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
          Audit Logs
        </a>
        <a href="/settings/oidc" class:active={pathname === '/settings/oidc'}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2L3 5v4c0 3.5 2.2 5.5 5 6.5 2.8-1 5-3 5-6.5V5L8 2z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M6 8l1.5 1.5L10.5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          OIDC Config
        </a>
        <a href="/settings/notifications" class:active={pathname === '/settings/notifications'}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 6a4 4 0 018 0c0 2 1 3.5 1.5 4.5H2.5C3 9.5 4 8 4 6z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M6 11.5a2 2 0 004 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          Notifications
        </a>
        <a href="/settings/backup" class:active={pathname === '/settings/backup'}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 8a6 6 0 0112 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M8 2v4l2 1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 10v3h8v-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 12h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
          Backups
        </a>
      {/if}
    </nav>

    <div class="sidebar-footer">
      <div class="user-info">
        <div class="user-avatar">{user?.username?.charAt(0)?.toUpperCase()}</div>
        <div class="user-details">
          <span class="user-name">{user?.username}</span>
          <span class="user-role">{user?.role}</span>
        </div>
      </div>
      <form method="POST" action="/api/auth/logout" use:enhance={() => {
    return async ({ result, update }) => {
      await update({ reset: false });
      if (result.type === 'success' && (result.data as any)?.redirect) {
        goto((result.data as any).redirect);
      }
    };
  }}>
        <button type="submit" class="logout-btn" title="Sign out">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 2H3a1 1 0 00-1 1v8a1 1 0 001 1h2M9 10l3-3-3-3M12 7H6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </form>
    </div>
  </aside>

  <main class="main-content">
    <div class="main-inner">
      {@render children()}
    </div>
  </main>
</div>

<style>
  .layout {
    display: flex;
    min-height: 100vh;
  }

  .sidebar {
    width: 228px;
    background: var(--bg-surface);
    border-right: 1px solid var(--border-subtle);
    display: flex;
    flex-direction: column;
    padding: 0;
    flex-shrink: 0;
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    z-index: 100;
    overflow-y: auto;
  }

  .logo {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 20px 20px 16px;
    border-bottom: 1px solid var(--border-subtle);
  }

  .logo-mark {
    width: 32px;
    height: 32px;
    background: var(--accent);
    color: var(--text-inverse);
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 16px;
    letter-spacing: -0.02em;
  }

  .logo-text {
    font-size: 17px;
    font-weight: 700;
    color: var(--text-primary);
    letter-spacing: -0.03em;
  }

  .team-selector {
    padding: 12px 16px 8px;
  }

  .team-selector select {
    width: 100%;
    padding: 7px 10px;
    background: var(--bg-input);
    border: 1px solid var(--border-default);
    color: var(--text-secondary);
    border-radius: var(--radius-sm);
    font-size: 12px;
    font-family: var(--font-sans);
    cursor: pointer;
  }

  .team-selector select:focus {
    outline: none;
    border-color: var(--border-focus);
  }

  .sidebar nav {
    flex: 1;
    padding: 8px 12px;
    overflow-y: auto;
  }

  .nav-label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    padding: 16px 8px 4px;
  }

  .nav-label:first-child {
    padding-top: 4px;
  }

  .sidebar nav a {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 10px;
    color: var(--text-secondary);
    border-radius: var(--radius-sm);
    margin-bottom: 1px;
    text-decoration: none;
    font-size: 13px;
    font-weight: 450;
    transition: all 0.12s;
  }

  .sidebar nav a:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .sidebar nav a.active {
    background: var(--accent-subtle);
    color: var(--accent-text);
  }

  .sidebar nav a svg {
    flex-shrink: 0;
    opacity: 0.7;
  }

  .sidebar nav a.active svg {
    opacity: 1;
  }

  .sidebar-footer {
    border-top: 1px solid var(--border-subtle);
    padding: 12px 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .user-info {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .user-avatar {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--bg-active);
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 600;
    flex-shrink: 0;
  }

  .user-details {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .user-name {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .user-role {
    font-size: 10px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 500;
  }

  .logout-btn {
    background: transparent;
    border: 1px solid var(--border-default);
    color: var(--text-muted);
    width: 28px;
    height: 28px;
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.12s;
    flex-shrink: 0;
  }

  .logout-btn:hover {
    background: var(--red-subtle);
    border-color: var(--red);
    color: var(--red-text);
  }

  .main-content {
    flex: 1;
    margin-left: 228px;
    min-height: 100vh;
    background: var(--bg-root);
  }

  .main-inner {
    width: min(calc(100vw - 228px - 64px), 1400px);
    margin: 0 auto;
    padding: 28px 32px;
  }

  @media (max-width: 768px) {
    .sidebar {
      width: 60px;
    }
    .sidebar .logo-text,
    .sidebar .team-selector,
    .sidebar .nav-label,
    .sidebar .user-details,
    .sidebar nav a {
      font-size: 0;
    }
    .sidebar nav a {
      justify-content: center;
      padding: 10px;
    }
    .main-content {
      margin-left: 60px;
    }
    .main-inner {
      width: 95%;
      padding: 20px 16px;
    }
  }
</style>
