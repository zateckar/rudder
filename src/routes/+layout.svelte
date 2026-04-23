<script lang="ts">
  import { page } from '$app/stores';
  import AppLayout from '$lib/components/AppLayout.svelte';
  
  let { data, children }: { 
    data: { user: { username: string; role: string; id: string } | null };
    children: any;
  } = $props();
  
  let activePage = $derived(
    $page.url.pathname.split('/')[1] || 'dashboard'
  );
  
  let showLayout = $derived(
    String($page.url.pathname) !== '/login' && 
    String($page.url.pathname) !== '/' &&
    data.user
  );
</script>

{#if showLayout}
  <AppLayout user={data.user} {activePage} pathname={$page.url.pathname}>
    {@render children()}
  </AppLayout>
{:else}
  {@render children()}
{/if}

<style>
  :global(:root) {
    /* ── Surface palette — lifted for bright-room readability ── */
    --bg-root: #13171e;
    --bg-surface: #1a1f27;
    --bg-raised: #212730;
    --bg-overlay: #282e38;
    --bg-hover: #2f3642;
    --bg-active: #383f4d;
    --bg-input: #1e232b;

    /* ── Border palette — visible in ambient light ── */
    --border-subtle: #303744;
    --border-default: #3d4554;
    --border-strong: #4e5768;
    --border-focus: #38bdf8;

    /* ── Text palette — high contrast ── */
    --text-primary: #f0f2f5;
    --text-secondary: #b0b8c4;
    --text-muted: #7a8494;
    --text-inverse: #0d1117;

    /* ── Accent: calm teal ── */
    --accent: #38bdf8;
    --accent-hover: #7dd3fc;
    --accent-subtle: #38bdf81a;
    --accent-text: #7dd3fc;

    /* ── Status colors — vivid for quick scanning ── */
    --green: #3fb950;
    --green-subtle: #3fb95022;
    --green-text: #56d364;
    --red: #f85149;
    --red-subtle: #f8514922;
    --red-text: #ff7b72;
    --blue: #58a6ff;
    --blue-subtle: #58a6ff22;
    --blue-text: #79c0ff;
    --yellow: #d29922;
    --yellow-subtle: #d2992222;
    --yellow-text: #e3b341;
    --purple: #bc8cff;
    --purple-subtle: #bc8cff22;

    /* ── Typography ── */
    --font-sans: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
    --font-mono: 'JetBrains Mono', 'SF Mono', 'Fira Code', monospace;

    /* ── Spacing ── */
    --radius-sm: 6px;
    --radius-md: 8px;
    --radius-lg: 12px;

    /* ── Shadows ── */
    --shadow-sm: 0 1px 2px rgba(0,0,0,0.4);
    --shadow-md: 0 4px 12px rgba(0,0,0,0.5);
    --shadow-lg: 0 8px 24px rgba(0,0,0,0.6);
    --glow-accent: 0 0 20px rgba(56,189,248,0.2);
    --glow-green: 0 0 12px rgba(63,185,80,0.25);
    --glow-red: 0 0 12px rgba(248,81,73,0.25);
  }

  :global(*) {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  :global(body) {
    font-family: var(--font-sans);
    background-color: var(--bg-root);
    color: var(--text-primary);
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  :global(a) {
    color: var(--accent);
    text-decoration: none;
    transition: color 0.15s;
  }

  :global(a:hover) {
    color: var(--accent-hover);
  }

  :global(button) {
    cursor: pointer;
    font-family: var(--font-sans);
  }

  :global(input, textarea, select) {
    font-family: var(--font-sans);
    font-size: inherit;
  }

  :global(::selection) {
    background: var(--accent);
    color: var(--text-inverse);
  }

  :global(::-webkit-scrollbar) {
    width: 6px;
    height: 6px;
  }

  :global(::-webkit-scrollbar-track) {
    background: transparent;
  }

  :global(::-webkit-scrollbar-thumb) {
    background: var(--border-default);
    border-radius: 3px;
  }

  :global(::-webkit-scrollbar-thumb:hover) {
    background: var(--border-strong);
  }
</style>
