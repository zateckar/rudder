<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { browser } from '$app/environment';
  
  export let containerId: string;
  export let tokenEndpoint: string = '/api/terminal/token';
  export let wsEndpoint: string = '/api/terminal/ws';
  
  let terminalElement: HTMLElement;
  let terminal: any;
  let fitAddon: any;
  let ws: WebSocket | null = null;
  let terminalToken: string | null = null;
  let sessionId: string;
  let isLoading = true;
  let error: string | null = null;
  let isConnecting = false;
  let cleanupFn: (() => void) | null = null;
  
  onMount(async () => {
    if (!browser) return;
    
    sessionId = crypto.randomUUID();
    
    try {
      // Dynamically import xterm (client-side only)
      const [xtermModule, fitAddonModule] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      
      // Also import the CSS
      await import('@xterm/xterm/css/xterm.css');
      
      const Terminal = xtermModule.default?.Terminal || xtermModule.Terminal;
      const FitAddon = fitAddonModule.default?.FitAddon || fitAddonModule.FitAddon;
      
      // Get terminal access token
      isConnecting = true;
      const response = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ containerId }),
      });
      
      if (!response.ok) {
        throw new Error(`Failed to get terminal token: ${response.statusText}`);
      }
      
      const data = await response.json();
      terminalToken = data.token;
      
      // Initialize terminal
      terminal = new Terminal({
        fontSize: 14,
        fontFamily: 'Consolas, "Courier New", monospace',
        theme: {
          background: '#1e1e1e',
          foreground: '#d4d4d4',
          cursor: '#ffffff',
          cursorAccent: '#000000',
          selectionBackground: '#264f78',
        },
        cursorBlink: true,
        cursorStyle: 'block',
        scrollback: 1000,
        tabStopWidth: 4,
      });
      
      fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      
      terminal.open(terminalElement);
      fitAddon.fit();
      
      // Setup WebSocket connection
      connectWebSocket();
      
      // Handle window resize
      const handleResize = () => {
        if (fitAddon && terminal) {
          fitAddon.fit();
        }
      };
      
      window.addEventListener('resize', handleResize);
      
      // Cleanup function
      cleanupFn = () => {
        window.removeEventListener('resize', handleResize);
        if (ws) {
          ws.close();
        }
        if (terminal) {
          terminal.dispose();
        }
      };
      
      isLoading = false;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Unknown error occurred';
      isLoading = false;
    }
  });
  
  onDestroy(() => {
    if (cleanupFn) {
      cleanupFn();
    }
  });
  
  function connectWebSocket() {
    if (!terminalToken) {
      error = 'No terminal token available';
      return;
    }
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}${wsEndpoint}?sessionId=${sessionId}&containerId=${containerId}&token=${terminalToken}`;
    
    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
      console.log('Terminal WebSocket connected');
      isConnecting = false;
      
      // Set up terminal data handling
      terminal.onData((data: string) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });
      
      terminal.onBinary((data: string) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });
    };
    
    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'connected') {
            console.log('Terminal session established:', message.message);
            return;
          }
        } catch {
          // Not JSON, treat as terminal data
        }
      }
      
      // Send data to terminal
      terminal.write(event.data);
    };
    
    ws.onerror = (event) => {
      console.error('WebSocket error:', event);
      error = 'Connection error occurred';
      isConnecting = false;
    };
    
    ws.onclose = (event) => {
      console.log('WebSocket closed:', event.code, event.reason);
      
      if (event.code !== 1000) {
        error = `Connection closed: ${event.reason || 'Unknown error'}`;
      }
      
      isConnecting = false;
      
      // Try to reconnect after a delay if it wasn't a clean close
      if (event.code !== 1000 && !isConnecting) {
        setTimeout(() => {
          if (!ws || ws.readyState === WebSocket.CLOSED) {
            isConnecting = true;
            connectWebSocket();
          }
        }, 3000);
      }
    };
  }
  
  function attemptReconnect() {
    if (!isConnecting) {
      isConnecting = true;
      error = null;
      connectWebSocket();
    }
  }
</script>

<div class="terminal-container">
  {#if isLoading}
    <div class="loading">
      <div class="spinner"></div>
      <p>Initializing terminal...</p>
    </div>
  {:else if error}
    <div class="error">
      <p class="error-message">{error}</p>
      <button class="retry-button" onclick={attemptReconnect} disabled={isConnecting}>
        {isConnecting ? 'Connecting...' : 'Retry Connection'}
      </button>
    </div>
  {:else if isConnecting}
    <div class="connecting">
      <div class="spinner"></div>
      <p>Connecting to container terminal...</p>
    </div>
  {/if}
  
  <div 
    bind:this={terminalElement} 
    class="xterm-container" 
    style:display={isLoading || error ? 'none' : 'block'}
  ></div>
</div>

<style>
  .terminal-container {
    width: 100%;
    height: 100%;
    background-color: #1e1e1e;
    border-radius: 6px;
    overflow: hidden;
    position: relative;
  }
  
  .loading, .connecting, .error {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: #d4d4d4;
    padding: 20px;
    text-align: center;
  }
  
  .spinner {
    width: 40px;
    height: 40px;
    border: 4px solid #333;
    border-top: 4px solid #007acc;
    border-radius: 50%;
    animation: spin 1s linear infinite;
    margin-bottom: 16px;
  }
  
  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
  
  .error {
    color: #f48771;
  }
  
  .error-message {
    margin-bottom: 16px;
    max-width: 400px;
  }
  
  .retry-button {
    background-color: #007acc;
    color: white;
    border: none;
    padding: 8px 16px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 14px;
    transition: background-color 0.2s;
  }
  
  .retry-button:hover:not(:disabled) {
    background-color: #005a9e;
  }
  
  .retry-button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  
  .xterm-container {
    width: 100%;
    height: 100%;
  }
  
  /* Ensure xterm takes full height */
  :global(.xterm) {
    height: 100% !important;
  }
  
  :global(.xterm-viewport) {
    scrollbar-color: #666 #1e1e1e;
  }
  
  :global(.xterm-viewport::-webkit-scrollbar) {
    width: 10px;
  }
  
  :global(.xterm-viewport::-webkit-scrollbar-track) {
    background: #1e1e1e;
  }
  
  :global(.xterm-viewport::-webkit-scrollbar-thumb) {
    background-color: #666;
    border-radius: 5px;
  }
</style>
