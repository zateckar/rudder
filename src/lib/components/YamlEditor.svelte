<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

  interface ValidationError {
    message: string;
    line: number;
    column: number;
    severity: 'error' | 'warning';
  }

  let {
    value = $bindable(''),
    language = 'yaml',
    readOnly = false,
    onValidate
  }: {
    value?: string;
    language?: string;
    readOnly?: boolean;
    onValidate?: (errors: ValidationError[]) => void;
  } = $props();

  let editorContainer: HTMLElement;
  let editor: any = null;
  let monacoRef: any = null;

  onMount(async () => {
    const loader = (await import('@monaco-editor/loader')).default;
    loader.config({ paths: { vs: '/monaco-editor/min/vs' } });
    monacoRef = await loader.init();

    editor = monacoRef.editor.create(editorContainer, {
      value,
      language,
      theme: 'vs-dark',
      automaticLayout: true,
      readOnly,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      wordWrap: 'on',
      padding: { top: 16, bottom: 16 },
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      lineNumbersMinChars: 3,
      tabSize: 2,
      renderWhitespace: 'selection',
      suggest: { showWords: false },
      quickSuggestions: false,
    });

    if (!readOnly) {
      editor.onDidChangeModelContent(() => {
        value = editor.getValue();
      });
    }

    if (onValidate) {
      monacoRef.editor.onDidChangeMarkers(([uri]: any[]) => {
        if (!editor) return;
        const model = editor.getModel();
        if (model && uri.toString() === model.uri.toString()) {
          const markers = monacoRef.editor.getModelMarkers({ resource: uri });
          const errors: ValidationError[] = markers
            .filter((m: any) => m.severity <= 8) // Error + Warning
            .map((m: any) => ({
              message: m.message,
              line: m.startLineNumber,
              column: m.startColumn,
              severity: m.severity === 8 ? 'error' as const : 'warning' as const,
            }));
          onValidate(errors);
        }
      });
    }
  });

  onDestroy(() => {
    if (editor) {
      editor.dispose();
    }
  });

  $effect(() => {
    if (editor && editor.getValue() !== value) {
      editor.setValue(value);
    }
  });
</script>

<div class="editor-wrapper" bind:this={editorContainer}></div>

<style>
  .editor-wrapper {
    width: 100%;
    height: 400px;
    border-radius: 4px;
    overflow: hidden;
    border: 1px solid #444;
  }
</style>
