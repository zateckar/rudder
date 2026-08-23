<script lang="ts">
  import { page } from '$app/stores';
  import PageHeader from '$lib/components/PageHeader.svelte';

  let { children } = $props();

  // The four pages under /settings are one screen with four tabs, not four
  // sidebar entries. The title and the blurb live here so each page is only
  // its own content.
  const TABS = [
    { href: '/settings', label: 'General', subtitle: 'System-wide settings that apply to every team.' },
    { href: '/settings/oidc', label: 'Single Sign-On', subtitle: 'Configure a generic OpenID Connect provider for single sign-on (Auth Code + PKCE).' },
    { href: '/settings/notifications', label: 'Notifications', subtitle: 'Notification channels, alert rules, and the alerts they have raised.' },
    { href: '/settings/backup', label: 'Backups', subtitle: 'Automated daily backups of the database to Azure Blob Storage.' },
  ];

  const pathname = $derived($page.url.pathname);
  const active = $derived(TABS.find((t) => t.href === pathname));

  // Notifications scopes its alert rules by `?team=`, so tabs carry the
  // selected team across rather than dropping it on the way in.
  const search = $derived($page.url.search);
</script>

<PageHeader title="Settings" subtitle={active?.subtitle} />

<nav class="tabs">
  {#each TABS as tab (tab.href)}
    <a href="{tab.href}{search}" class:active={tab.href === pathname}>{tab.label}</a>
  {/each}
</nav>

{@render children()}
