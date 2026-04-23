<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  
  let { containerId } = $props();
  let terminalElement = $state<HTMLElement | null>(null);
  let containerRef = $state<HTMLElement | null>(null);
  let logViewerRef = $state<HTMLElement | null>(null);
  let term: any = null;
  let fitAddon: any = null;
  let resizeObserver: ResizeObserver | null = null;
  let activeTab = $state('logs');
  let commandInput = $state('');
  let commandHistory = $state<string[]>([]);
  let historyIndex = $state(-1);
  let isExecuting = $state(false);
  let isStreaming = $state(false);
  let lastWidth = 0;
  let lastHeight = 0;
  let eventSource: EventSource | null = null;

  // Log viewer state
  let logLines = $state<string[]>([]);
  let searchQuery = $state('');
  let tailCount = $state('1000');
  let showTimestamps = $state(true);
  let autoScroll = $state(true);
  let copyFeedback = $state(false);

  // Derived: filtered/displayed lines
  let displayLines = $derived.by(() => {
    return logLines.map((line) => {
      // Parse timestamp if present (ISO 8601 format at start of line)
      const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s?)/);
      let timestamp = '';
      let content = line;
      if (tsMatch) {
        timestamp = tsMatch[1].trim();
        content = line.slice(tsMatch[0].length);
      }
      // Detect log level
      let level: 'error' | 'warn' | 'info' | 'default' = 'default';
      const upper = content.toUpperCase();
      if (upper.includes('ERROR') || upper.includes('FATAL') || upper.includes('PANIC')) {
        level = 'error';
      } else if (upper.includes('WARN') || upper.includes('WARNING')) {
        level = 'warn';
      } else if (upper.includes('INFO')) {
        level = 'info';
      }
      return { timestamp, content, level, raw: line };
    });
  });

  let searchMatchCount = $derived.by(() => {
    if (!searchQuery.trim()) return 0;
    const q = searchQuery.toLowerCase();
    return displayLines.filter(l => l.raw.toLowerCase().includes(q)).length;
  });

  function scrollToBottom() {
    if (logViewerRef && autoScroll) {
      logViewerRef.scrollTop = logViewerRef.scrollHeight;
    }
  }

  function handleLogViewerScroll() {
    if (!logViewerRef) return;
    const { scrollTop, scrollHeight, clientHeight } = logViewerRef;
    // If user scrolled up more than 40px from bottom, disable auto-scroll
    const atBottom = scrollHeight - scrollTop - clientHeight < 40;
    if (!atBottom && autoScroll) {
      autoScroll = false;
    }
  }

  // Use $effect to auto-scroll when new lines come in
  $effect(() => {
    // Track logLines.length to trigger on new lines
    const _len = logLines.length;
    if (autoScroll && logViewerRef && activeTab === 'logs') {
      // Use tick-like delay for DOM update
      requestAnimationFrame(() => {
        if (logViewerRef) {
          logViewerRef.scrollTop = logViewerRef.scrollHeight;
        }
      });
    }
  });

  function highlightSearch(text: string): string {
    if (!searchQuery.trim()) return escapeHtml(text);
    const escaped = escapeHtml(text);
    const q = escapeHtml(searchQuery);
    const regex = new RegExp(`(${escapeRegex(q)})`, 'gi');
    return escaped.replace(regex, '<mark class="search-highlight">$1</mark>');
  }

  function escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function stripAnsi(str: string): string {
    return str.replace(/\x1b\[[0-9;]*m/g, '');
  }

  onMount(async () => {
    await initTerminal();
    startStreamingLogs();
  });

  async function initTerminal() {
    const { Terminal } = await import('@xterm/xterm');
    const { FitAddon } = await import('@xterm/addon-fit');
    await import('@xterm/xterm/css/xterm.css');

    term = new Terminal({
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4'
      },
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      convertEol: true,
      scrollback: 1000,
    });

    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
  }

  function mountTerminal() {
    if (!term || !terminalElement) return;
    term.open(terminalElement);
    setTimeout(() => {
      if (fitAddon && containerRef) {
        fitAddon.fit();
        lastWidth = containerRef.clientWidth;
        lastHeight = containerRef.clientHeight;
      }
    }, 100);

    if (containerRef && !resizeObserver) {
      resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const newWidth = entry.contentRect.width;
          const newHeight = entry.contentRect.height;
          if (Math.abs(newWidth - lastWidth) > 10 || Math.abs(newHeight - lastHeight) > 10) {
            lastWidth = newWidth;
            lastHeight = newHeight;
            if (fitAddon) {
              fitAddon.fit();
            }
          }
        }
      });
      resizeObserver.observe(containerRef);
    }
  }

  // Mount terminal when switching to terminal tab
  $effect(() => {
    if (activeTab === 'terminal' && terminalElement && term) {
      // Small delay to ensure DOM element is rendered
      requestAnimationFrame(() => {
        mountTerminal();
      });
    }
  });

  onDestroy(() => {
    stopStreaming();
    if (resizeObserver) {
      resizeObserver.disconnect();
    }
    if (term) {
      term.dispose();
    }
  });

  function startStreamingLogs() {
    stopStreaming();
    logLines = [];
    isStreaming = true;

    const tail = tailCount === 'all' ? '0' : tailCount;
    eventSource = new EventSource(`/api/containers/logs?containerId=${containerId}&tail=${tail}&follow=true`);
    
    let firstMessage = true;

    eventSource.onmessage = (event) => {
      if (firstMessage) {
        firstMessage = false;
      }
      
      if (event.data === '[DONE]') {
        isStreaming = false;
        eventSource?.close();
        return;
      }

      try {
        const data = JSON.parse(event.data);
        if (data.error) {
          logLines.push(`ERROR: ${data.error}`);
        } else {
          logLines.push(stripAnsi(String(data)));
        }
      } catch {
        logLines.push(stripAnsi(event.data));
      }
    };

    eventSource.onerror = () => {
      isStreaming = false;
      eventSource?.close();
    };
  }

  function stopStreaming() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    isStreaming = false;
  }

  function reconnectWithTail() {
    startStreamingLogs();
  }

  function clearLogs() {
    logLines = [];
  }

  function downloadLogs() {
    const text = logLines.join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `container-${containerId}-logs.log`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function copyLogs() {
    const text = logLines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      copyFeedback = true;
      setTimeout(() => { copyFeedback = false; }, 2000);
    } catch {
      // fallback: do nothing
    }
  }

  function switchTab(tab: string) {
    activeTab = tab;
    if (tab === 'logs') {
      startStreamingLogs();
    } else if (tab === 'terminal') {
      stopStreaming();
      if (term) {
        term.clear();
        term.writeln('\x1b[36mContainer Terminal - Type commands below\x1b[0m');
        term.writeln('\x1b[33mNote: Each command runs in a new shell (not interactive)\x1b[0m');
        term.writeln('');
      }
    }
  }

  async function executeCommand() {
    if (!commandInput.trim() || isExecuting) return;
    
    const cmd = commandInput.trim();
    commandHistory = [...commandHistory, cmd];
    historyIndex = -1;
    commandInput = '';
    isExecuting = true;

    if (term) {
      term.writeln(`\x1b[32m$ ${cmd}\x1b[0m`);
    }

    try {
      const response = await fetch(`/api/containers/${containerId}/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd }),
      });

      const result = await response.json();

      if (!response.ok) {
        if (term) {
          term.writeln(`\x1b[31mError: ${result.error}\x1b[0m`);
        }
      } else {
        if (result.stdout && term) {
          term.write(result.stdout);
          if (!result.stdout.endsWith('\n')) {
            term.writeln('');
          }
        }
        if (result.stderr && term) {
          term.write(`\x1b[31m${result.stderr}\x1b[0m`);
          if (!result.stderr.endsWith('\n')) {
            term.writeln('');
          }
        }
        if (result.exitCode !== 0 && term) {
          term.writeln(`\x1b[33m(exit code: ${result.exitCode})\x1b[0m`);
        }
      }
    } catch (err: any) {
      if (term) {
        term.writeln(`\x1b[31mError: ${err.message}\x1b[0m`);
      }
    } finally {
      isExecuting = false;
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      executeCommand();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (commandHistory.length > 0) {
        if (historyIndex === -1) {
          historyIndex = commandHistory.length - 1;
        } else if (historyIndex > 0) {
          historyIndex--;
        }
        commandInput = commandHistory[historyIndex];
      }
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (historyIndex !== -1) {
        if (historyIndex < commandHistory.length - 1) {
          historyIndex++;
          commandInput = commandHistory[historyIndex];
        } else {
          historyIndex = -1;
          commandInput = '';
        }
      }
    }
  }

  function handleTailChange(e: Event) {
    const target = e.target as HTMLSelectElement;
    tailCount = target.value;
    reconnectWithTail();
  }
</script>

<div class="terminal-container" bind:this={containerRef}>
  <div class="terminal-header">
    <div class="tabs">
      <button class:active={activeTab === 'logs'} onclick={() => switchTab('logs')}>
        Logs {#if isStreaming}<span class="streaming-indicator"></span>{/if}
      </button>
      <button class:active={activeTab === 'terminal'} onclick={() => switchTab('terminal')}>Terminal</button>
    </div>
    {#if activeTab === 'logs'}
      <div class="header-actions">
        {#if isStreaming}
          <button class="btn-action btn-stop" onclick={stopStreaming} title="Stop streaming">Stop</button>
        {:else}
          <button class="btn-action" onclick={startStreamingLogs} title="Start streaming">Stream</button>
        {/if}
      </div>
    {/if}
  </div>

  {#if activeTab === 'logs'}
    <!-- Log Toolbar -->
    <div class="log-toolbar">
      <div class="toolbar-left">
        <div class="search-box">
          <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"></circle>
            <path d="m21 21-4.3-4.3"></path>
          </svg>
          <input
            type="text"
            class="search-input"
            placeholder="Search logs..."
            bind:value={searchQuery}
          />
          {#if searchQuery.trim()}
            <span class="search-count">{searchMatchCount}</span>
          {/if}
        </div>

        <div class="toolbar-select">
          <label class="toolbar-label" for="tail-select">Tail</label>
          <select id="tail-select" class="toolbar-dropdown" value={tailCount} onchange={handleTailChange}>
            <option value="100">100</option>
            <option value="500">500</option>
            <option value="1000">1000</option>
            <option value="5000">5000</option>
            <option value="all">All</option>
          </select>
        </div>
      </div>

      <div class="toolbar-right">
        <label class="toolbar-toggle" title="Show timestamps">
          <input type="checkbox" bind:checked={showTimestamps} />
          <span class="toggle-label">Timestamps</span>
        </label>

        <label class="toolbar-toggle" title="Auto-scroll to bottom">
          <input type="checkbox" bind:checked={autoScroll} />
          <span class="toggle-label">Auto-scroll</span>
        </label>

        <div class="toolbar-divider"></div>

        <button class="btn-tool" onclick={downloadLogs} title="Download logs">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
            <polyline points="7 10 12 15 17 10"></polyline>
            <line x1="12" y1="15" x2="12" y2="3"></line>
          </svg>
        </button>

        <button class="btn-tool" onclick={copyLogs} title={copyFeedback ? 'Copied!' : 'Copy all logs'}>
          {#if copyFeedback}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          {:else}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          {/if}
        </button>

        <button class="btn-tool" onclick={clearLogs} title="Clear logs">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18"></path>
            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
          </svg>
        </button>
      </div>
    </div>

    <!-- HTML Log Viewer -->
    <div
      class="log-viewer"
      bind:this={logViewerRef}
      onscroll={handleLogViewerScroll}
    >
      {#if displayLines.length === 0}
        <div class="log-empty">
          {#if isStreaming}
            <span class="log-empty-text">Waiting for log output...</span>
          {:else}
            <span class="log-empty-text">No logs loaded. Click "Stream" to start.</span>
          {/if}
        </div>
      {:else}
        <table class="log-table">
          <tbody>
            {#each displayLines as line, i (i)}
              {@const isMatch = searchQuery.trim() ? line.raw.toLowerCase().includes(searchQuery.toLowerCase()) : false}
              <tr
                class="log-line"
                class:level-error={line.level === 'error'}
                class:level-warn={line.level === 'warn'}
                class:level-info={line.level === 'info'}
                class:search-match={isMatch}
              >
                <td class="line-number">{i + 1}</td>
                {#if showTimestamps && line.timestamp}
                  <td class="line-timestamp">{line.timestamp}</td>
                {/if}
                <td class="line-content">
                  {#if searchQuery.trim()}
                    {@html highlightSearch(line.content)}
                  {:else}
                    {line.content}
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>

    <!-- Log status bar -->
    <div class="log-statusbar">
      <span class="status-text">{logLines.length} lines</span>
      {#if isStreaming}
        <span class="status-streaming">
          <span class="streaming-dot"></span>
          Streaming
        </span>
      {/if}
    </div>
  {:else}
    <!-- Terminal tab: xterm.js -->
    <div class="terminal-wrapper" bind:this={terminalElement}></div>
    <div class="command-input-wrapper">
      <span class="prompt">$</span>
      <input
        type="text"
        class="command-input"
        bind:value={commandInput}
        onkeydown={handleKeydown}
        placeholder="Type a command and press Enter..."
        disabled={isExecuting}
      />
      {#if isExecuting}
        <span class="executing">Running...</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .terminal-container {
    background: #1e1e1e;
    border-radius: 8px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    height: 500px;
    margin-top: 16px;
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
    contain: strict;
  }

  .terminal-header {
    background: #2d2d2d;
    padding: 8px 16px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-shrink: 0;
  }

  .tabs {
    display: flex;
    gap: 8px;
  }

  .tabs button {
    background: transparent;
    border: none;
    color: #888;
    padding: 6px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
  }

  .tabs button.active {
    background: #444;
    color: white;
  }

  .tabs button:hover:not(.active) {
    color: #ccc;
  }

  .header-actions {
    display: flex;
    gap: 6px;
  }

  .btn-action {
    background: transparent;
    border: 1px solid #444;
    color: #ccc;
    padding: 4px 12px;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
  }

  .btn-action:hover {
    background: #444;
    color: white;
  }

  .btn-stop {
    border-color: #e51400;
    color: #e51400;
  }

  .btn-stop:hover {
    background: #e51400;
    color: white;
  }

  .streaming-indicator {
    display: inline-block;
    width: 8px;
    height: 8px;
    background: #4ec9b0;
    border-radius: 50%;
    margin-left: 6px;
    animation: pulse 1.5s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  /* ---- Log Toolbar ---- */
  .log-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 6px 12px;
    background: #252525;
    border-bottom: 1px solid var(--border-subtle, #303744);
    flex-shrink: 0;
    flex-wrap: wrap;
  }

  .toolbar-left {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 0;
  }

  .toolbar-right {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  .search-box {
    display: flex;
    align-items: center;
    background: #1e1e1e;
    border: 1px solid #3d3d3d;
    border-radius: 4px;
    padding: 0 8px;
    gap: 6px;
    min-width: 160px;
    max-width: 260px;
    flex: 1;
  }

  .search-box:focus-within {
    border-color: var(--accent, #38bdf8);
  }

  .search-icon {
    color: #666;
    flex-shrink: 0;
  }

  .search-input {
    background: transparent;
    border: none;
    color: #d4d4d4;
    font-family: Menlo, Monaco, "Courier New", monospace;
    font-size: 12px;
    padding: 5px 0;
    outline: none;
    width: 100%;
    min-width: 0;
  }

  .search-input::placeholder {
    color: #555;
  }

  .search-count {
    font-size: 10px;
    color: var(--accent, #38bdf8);
    font-weight: 600;
    flex-shrink: 0;
    background: var(--accent-subtle, #38bdf81a);
    padding: 1px 6px;
    border-radius: 8px;
  }

  .toolbar-select {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .toolbar-label {
    font-size: 11px;
    color: #888;
    font-weight: 500;
  }

  .toolbar-dropdown {
    background: #1e1e1e;
    border: 1px solid #3d3d3d;
    color: #d4d4d4;
    font-size: 11px;
    padding: 4px 6px;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
  }

  .toolbar-dropdown:focus {
    outline: none;
    border-color: var(--accent, #38bdf8);
  }

  .toolbar-toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    flex-shrink: 0;
    user-select: none;
  }

  .toolbar-toggle input[type="checkbox"] {
    width: 13px;
    height: 13px;
    accent-color: var(--accent, #38bdf8);
    cursor: pointer;
    margin: 0;
  }

  .toggle-label {
    font-size: 11px;
    color: #999;
    white-space: nowrap;
  }

  .toolbar-divider {
    width: 1px;
    height: 18px;
    background: #3d3d3d;
    flex-shrink: 0;
  }

  .btn-tool {
    background: transparent;
    border: 1px solid #3d3d3d;
    color: #999;
    padding: 4px 6px;
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.12s;
  }

  .btn-tool:hover {
    background: #333;
    color: #eee;
    border-color: #555;
  }

  /* ---- Log Viewer ---- */
  .log-viewer {
    flex: 1;
    overflow: auto;
    background: #1a1a1a;
    min-height: 0;
  }

  .log-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 40px;
  }

  .log-empty-text {
    color: #555;
    font-size: 13px;
    font-family: Menlo, Monaco, "Courier New", monospace;
  }

  .log-table {
    width: 100%;
    border-collapse: collapse;
    font-family: Menlo, Monaco, "Courier New", monospace;
    font-size: 12px;
    line-height: 1.5;
    table-layout: fixed;
  }

  .log-line {
    border-bottom: 1px solid transparent;
  }

  .log-line:hover {
    background: #ffffff08;
  }

  .log-line.level-error {
    background: #f8514908;
  }
  .log-line.level-error:hover {
    background: #f8514912;
  }

  .log-line.level-warn {
    background: #d2992208;
  }
  .log-line.level-warn:hover {
    background: #d2992212;
  }

  .log-line.level-info td.line-content {
    color: var(--blue-text, #79c0ff);
  }

  .log-line.search-match {
    background: #d2992215;
  }

  .line-number {
    width: 50px;
    min-width: 50px;
    padding: 1px 10px 1px 12px;
    text-align: right;
    color: #555;
    user-select: none;
    white-space: nowrap;
    vertical-align: top;
    border-right: 1px solid #2a2a2a;
  }

  .line-timestamp {
    width: 200px;
    min-width: 200px;
    padding: 1px 10px;
    color: #666;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    vertical-align: top;
  }

  .line-content {
    padding: 1px 12px;
    color: #d4d4d4;
    white-space: pre-wrap;
    word-break: break-all;
    vertical-align: top;
  }

  .log-line.level-error .line-content {
    color: var(--red-text, #ff7b72);
  }

  .log-line.level-warn .line-content {
    color: var(--yellow-text, #e3b341);
  }

  :global(.search-highlight) {
    background: #d29922;
    color: #000;
    border-radius: 2px;
    padding: 0 1px;
  }

  /* ---- Status Bar ---- */
  .log-statusbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 12px;
    background: #252525;
    border-top: 1px solid #2a2a2a;
    flex-shrink: 0;
  }

  .status-text {
    font-size: 11px;
    color: #666;
    font-family: Menlo, Monaco, "Courier New", monospace;
  }

  .status-streaming {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: #4ec9b0;
  }

  .streaming-dot {
    width: 6px;
    height: 6px;
    background: #4ec9b0;
    border-radius: 50%;
    animation: pulse 1.5s ease-in-out infinite;
  }

  /* ---- Terminal (exec) tab ---- */
  .terminal-wrapper {
    flex: 1;
    padding: 12px;
    overflow: hidden;
    min-width: 0;
    min-height: 0;
    max-width: 100%;
    box-sizing: border-box;
  }

  .command-input-wrapper {
    display: flex;
    align-items: center;
    background: #2d2d2d;
    padding: 8px 16px;
    gap: 8px;
    flex-shrink: 0;
  }

  .prompt {
    color: #4ec9b0;
    font-family: Menlo, Monaco, "Courier New", monospace;
    font-size: 14px;
    flex-shrink: 0;
  }

  .command-input {
    flex: 1;
    background: transparent;
    border: none;
    color: #d4d4d4;
    font-family: Menlo, Monaco, "Courier New", monospace;
    font-size: 14px;
    outline: none;
    min-width: 0;
  }

  .command-input::placeholder {
    color: #666;
  }

  .command-input:disabled {
    opacity: 0.6;
  }

  .executing {
    color: #569cd6;
    font-size: 12px;
    flex-shrink: 0;
  }

  /* xterm containment */
  :global(.terminal-wrapper .xterm) {
    height: 100% !important;
    width: 100% !important;
    max-width: 100% !important;
    overflow: hidden !important;
  }

  :global(.terminal-wrapper .xterm-viewport) {
    border-radius: 4px;
    width: 100% !important;
    max-width: 100% !important;
    overflow-y: auto !important;
    overflow-x: hidden !important;
  }

  :global(.terminal-wrapper .xterm-screen) {
    width: 100% !important;
    max-width: 100% !important;
  }

  :global(.terminal-wrapper .xterm-helper-textarea) {
    position: absolute !important;
  }
</style>
