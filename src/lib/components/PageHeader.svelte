<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    /** One line under the title explaining what the page is for. */
    subtitle?: string;
    /** Breadcrumb back to the parent page. */
    back?: { href: string; label: string };
    /** A status chip sitting on the same line as the title. */
    badge?: Snippet;
    /** URLs, descriptions — anything belonging under the title. */
    meta?: Snippet;
    /** Buttons and links, right-aligned. */
    actions?: Snippet;
  }

  let { title, subtitle, back, badge, meta, actions }: Props = $props();
</script>

<!--
  Every page built its own header. Sixteen of them, in five different flex
  arrangements, with the bottom margin varying between 8px and 28px and the
  `h1` between 24px and 28px — none of it a decision anyone had made. The
  layout is here now; pages supply the content.
-->
<header class="page-header">
  <div class="page-header-main">
    {#if back}
      <a href={back.href} class="back-link">← {back.label}</a>
    {/if}
    {#if badge}
      <div class="title-row">
        <h1>{title}</h1>
        {@render badge()}
      </div>
    {:else}
      <h1>{title}</h1>
    {/if}
    {#if subtitle}
      <p class="subtitle">{subtitle}</p>
    {/if}
    {@render meta?.()}
  </div>

  {#if actions}
    <div class="header-actions">{@render actions()}</div>
  {/if}
</header>

<style>
  .page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 16px;
    margin-bottom: 24px;
  }

  .page-header-main {
    display: flex;
    flex-direction: column;
    gap: 6px;
    /* So a long title or URL wraps instead of pushing the actions off-screen. */
    min-width: 0;
  }

  .title-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
  }

  .page-header h1 {
    margin: 0;
    color: var(--text-primary);
    font-size: 26px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }
</style>
