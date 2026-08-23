<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { browser } from '$app/environment';

  let {
    children,
    user,
    teams = [],
    pathname,
  }: {
    children?: any;
    user?: { username: string; role: string; id: string } | null;
    /** From the root layout load — see `+layout.server.ts`. */
    teams?: Array<{ id: string; name: string }>;
    /** Drives which nav entry is lit. See `isActive`. */
    pathname: string;
  } = $props();

  /**
   * Which team the rest of the app is scoped to.
   *
   * The URL is the source of truth, because every page load reads `?team=` on
   * the server. `localStorage` only remembers the choice across a fresh visit
   * that names no team.
   *
   * This used to fetch `/api/teams` in an `$effect` on every mount and pick the
   * selection afterwards, which meant a second authenticated round trip per
   * navigation and a sidebar that rendered without its selector until it
   * landed.
   */
  const selectedTeam = $derived.by(() => {
    if (teams.length === 0) return null;

    const fromUrl = $page.url.searchParams.get('team');
    if (fromUrl && (fromUrl === 'all' || teams.some((t) => t.id === fromUrl))) return fromUrl;

    if (browser) {
      const saved = localStorage.getItem('rudder_team_id');
      if (saved && (saved === 'all' || teams.some((t) => t.id === saved))) return saved;
    }
    return teams[0].id;
  });

  $effect(() => {
    if (browser && selectedTeam) localStorage.setItem('rudder_team_id', selectedTeam);
  });

  function updateTeam(e: Event) {
    const target = e.target as HTMLSelectElement;
    if (!target.value) return;
    localStorage.setItem('rudder_team_id', target.value);

    // `goto`, not `window.location.href`: this is a same-app navigation, and a
    // full document load discards the page and re-downloads every asset to
    // change one query parameter.
    const url = new URL($page.url);
    url.searchParams.set('team', target.value);
    goto(`${url.pathname}${url.search}`, { invalidateAll: true });
  }

  const isAdmin = $derived(user?.role === 'admin');

  // One rule for every entry: a section stays lit while you are anywhere
  // inside it. This used to be two — an `activePage` first-path-segment match
  // for some links and an exact `pathname ===` for the rest — which meant the
  // exact-match ones went dark the moment you opened a child route.
  function isActive(href: string) {
    return pathname === href || pathname.startsWith(`${href}/`);
  }
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
      <a href="/dashboard?team={selectedTeam}" class:active={isActive('/dashboard')}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="1" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="9" y="1" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="1" y="9" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="9" y="9" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.5"/></svg>
        Dashboard
      </a>
      <a href="/applications?team={selectedTeam}" class:active={isActive('/applications')}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 5l6-3 6 3v6l-6 3-6-3V5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M2 5l6 3m0 0l6-3M8 8v6" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
        Applications
      </a>
      <a href="/templates?team={selectedTeam}" class:active={isActive('/templates')}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M5 6h6M5 8h4M5 10h5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
        Templates
      </a>
      <a href="/teams?team={selectedTeam}" class:active={isActive('/teams')}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="6" cy="5" r="2.5" stroke="currentColor" stroke-width="1.5"/><circle cx="11" cy="5" r="2" stroke="currentColor" stroke-width="1.3"/><path d="M1 13c0-2.5 2.2-4 5-4s5 1.5 5 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M11 9c1.8 0 3.5 1 3.5 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        Teams
      </a>
      <a href="/volumes?team={selectedTeam}" class:active={isActive('/volumes')}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><ellipse cx="8" cy="4" rx="6" ry="2" stroke="currentColor" stroke-width="1.5"/><path d="M2 4v3c0 1.1 2.7 2 6 2s6-.9 6-2V4" stroke="currentColor" stroke-width="1.5"/><path d="M2 7v3c0 1.1 2.7 2 6 2s6-.9 6-2V7" stroke="currentColor" stroke-width="1.5"/></svg>
        Volumes
      </a>
      <a href="/secrets?team={selectedTeam}" class:active={isActive('/secrets')}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="3" y="6" width="10" height="7" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M5 6V4a3 3 0 016 0v2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="10" r="1" fill="currentColor"/></svg>
        Secrets
      </a>

      {#if isAdmin}
        <div class="nav-label">Admin</div>
        <a href="/workers?team={selectedTeam}" class:active={isActive('/workers')}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M5 7h6M5 9h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="12" cy="5" r="1" fill="currentColor"/></svg>
          Workers
        </a>
        <a href="/users?team={selectedTeam}" class:active={isActive('/users')}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="5" r="2.75" stroke="currentColor" stroke-width="1.5"/><path d="M2.5 13.5c0-2.8 2.5-4.5 5.5-4.5s5.5 1.7 5.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          Users
        </a>
        <a href="/audit?team={selectedTeam}" class:active={isActive('/audit')}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M3 7h7M3 10h9M3 13h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
          Audit Logs
        </a>
        <a href="/settings?team={selectedTeam}" class:active={isActive('/settings')}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2.25" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.5l1 1.6 1.9-.4.4 1.9 1.6 1-.9 1.7.9 1.7-1.6 1-.4 1.9-1.9-.4-1 1.6-1-1.6-1.9.4-.4-1.9-1.6-1 .9-1.7-.9-1.7 1.6-1 .4-1.9 1.9.4 1-1.6z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
          Settings
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
