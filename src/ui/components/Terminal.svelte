<script lang="ts" module>
  export interface TermSession {
    buffer: string;
    busy: boolean;
    readonly hidden: boolean;
    history: string[];
    prompt(): string;
    input(line: string): void;
    attach(out: (s: string) => void): void;
    detach(): void;
    abort(): void;
    help?(text: string): string;
    complete?(text: string): string;
    end?(): void;
    write(s: string): void;
    onClear?: () => void;
  }
</script>

<script lang="ts">
  import { onMount } from "svelte";
  import { prefs } from "../prefs.svelte";
  import { app } from "../state.svelte";

  let { session }: { session: TermSession } = $props();
  let text = $state("");
  let typed = $state("");
  let caret = $state(0);
  let input: HTMLInputElement;
  let scroller: HTMLDivElement;
  let histIdx = -1;
  let queue: string[] = [];

  onMount(() => {
    text = session.buffer;
    session.attach((s) => {
      text = session.buffer;
      void s;
      queueMicrotask(scrollDown);
      if (!session.busy && queue.length) setTimeout(drain, 0);
    });
    session.onClear = () => (text = "");
    focus();
    const t = setTimeout(focus, 60);
    scrollDown();
    return () => {
      clearTimeout(t);
      session.detach();
    };
  });

  // Keep the view fresh as simulated time produces output.
  $effect(() => {
    void app.tick;
    if (text.length !== session.buffer.length) {
      text = session.buffer;
      queueMicrotask(scrollDown);
    }
  });

  function scrollDown() {
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  export function focus() {
    input?.focus({ preventScroll: true });
  }

  function submit(line: string) {
    session.input(line);
    typed = "";
    caret = 0;
    histIdx = -1;
    text = session.buffer;
    queueMicrotask(scrollDown);
  }

  function drain() {
    while (queue.length && !session.busy) submit(queue.shift()!);
  }

  function onKey(e: KeyboardEvent) {
    const busy = session.busy;
    if ((e.ctrlKey && (e.key === "c" || e.key === "C")) || (e.ctrlKey && e.shiftKey && e.key === "^")) {
      if (busy || !window.getSelection()?.toString()) {
        e.preventDefault();
        session.abort();
        queue = [];
        if (!busy && typed) {
          session.write(`${typed}^C\n${session.prompt()}`);
          typed = "";
          caret = 0;
        }
        text = session.buffer;
      }
      return;
    }
    if (e.ctrlKey && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      session.end?.();
      typed = "";
      text = session.buffer;
      return;
    }
    if (busy) {
      e.preventDefault();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      submit(typed);
    } else if (e.key === "Tab") {
      e.preventDefault();
      if (session.complete) {
        typed = session.complete(typed);
        caret = typed.length;
      }
    } else if (e.key === "?" && session.help && !session.hidden) {
      e.preventDefault();
      session.write(`${typed}?\n${session.help(typed)}${session.prompt()}`);
      text = session.buffer;
      queueMicrotask(scrollDown);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const h = session.history;
      if (!h.length) return;
      histIdx = histIdx < 0 ? h.length - 1 : Math.max(0, histIdx - 1);
      typed = h[histIdx];
      caret = typed.length;
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const h = session.history;
      if (histIdx < 0) return;
      histIdx++;
      if (histIdx >= h.length) {
        histIdx = -1;
        typed = "";
      } else typed = h[histIdx];
      caret = typed.length;
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      session.buffer = session.prompt();
      text = session.buffer;
    }
    requestAnimationFrame(() => (caret = input?.selectionStart ?? typed.length));
  }

  function onPaste(e: ClipboardEvent) {
    const data = e.clipboardData?.getData("text") ?? "";
    if (!data.includes("\n")) return;
    e.preventDefault();
    const lines = data.replace(/\r/g, "").split("\n");
    const last = lines.pop() ?? "";
    lines[0] = typed.slice(0, caret) + lines[0];
    queue.push(...lines);
    typed = last;
    caret = last.length;
    drain();
  }

  const shown = $derived(session.hidden ? "" : typed);
  const display = $derived(text.length > 120000 ? text.slice(-100000) : text);
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="terminal scroll" bind:this={scroller} onclick={() => !window.getSelection()?.toString() && focus()} style:font-size="{prefs.terminalFontSize}px">
  <pre>{display}{#if !session.busy}<span class="typed">{shown.slice(0, caret)}<span class="caret"></span>{shown.slice(caret)}</span>{/if}</pre>
  <input
    bind:this={input}
    bind:value={typed}
    class="hidden-input"
    autocomplete="off"
    autocapitalize="off"
    spellcheck="false"
    aria-label="Terminal input"
    onkeydown={onKey}
    oninput={() => (caret = input.selectionStart ?? typed.length)}
    onpaste={onPaste}
  />
</div>

<style>
  .terminal {
    position: relative;
    height: 100%;
    background: var(--terminal-bg);
    color: var(--terminal-fg);
    padding: 10px 12px;
    font-family: var(--mono);
    line-height: 1.4;
    cursor: text;
  }
  pre {
    margin: 0;
    font: inherit;
    white-space: pre-wrap;
    word-break: break-word;
    user-select: text;
    -webkit-user-select: text;
  }
  .caret {
    display: inline-block;
    width: 0.6em;
    height: 1.15em;
    margin-bottom: -0.2em;
    background: var(--accent);
    opacity: 0.85;
    animation: blink 1.1s steps(1) infinite;
  }
  .terminal:not(:focus-within) .caret {
    background: transparent;
    outline: 1px solid var(--secondary);
    animation: none;
  }
  @keyframes blink {
    50% {
      opacity: 0;
    }
  }
  .hidden-input {
    position: absolute;
    left: -9999px;
    top: 0;
    opacity: 0;
    width: 10px;
  }
</style>
