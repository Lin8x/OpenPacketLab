<script lang="ts">
  import { app } from "../state.svelte";
  import Icon from "./Icon.svelte";
</script>

<div class="toasts" aria-live="polite">
  {#each app.toasts as t (t.id)}
    <div class="toast {t.kind}">
      <Icon name={t.kind === "error" ? "warning" : t.kind === "success" ? "check" : "info"} size={16} />
      <span>{t.text}</span>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    left: 50%;
    bottom: 48px;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    z-index: 2000;
    pointer-events: none;
  }
  .toast {
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: 560px;
    padding: 9px 14px;
    border-radius: 12px;
    background: var(--surface);
    backdrop-filter: saturate(180%) blur(24px);
    -webkit-backdrop-filter: saturate(180%) blur(24px);
    box-shadow: var(--shadow);
    font-weight: 500;
    animation: rise 0.2s ease-out;
  }
  .toast.error {
    color: var(--red);
  }
  .toast.success :global(svg) {
    color: var(--green);
  }
  @keyframes rise {
    from {
      transform: translateY(8px);
      opacity: 0;
    }
  }
</style>
