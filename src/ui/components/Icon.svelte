<script lang="ts" module>
  // Line icons drawn for OpenPacketLab on a 24×24 grid.
  const P: Record<string, string> = {
    sidebar: "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM9 5v14M5.5 8.5h1.5M5.5 11h1.5",
    inspector: "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM15 5v14M17 8.5h1.5M17 11h1.5",
    cursor: "M6 3.5l12 7.2-5.3 1.3 3.2 5.6-2.2 1.3-3.2-5.6L6.8 17z",
    cable: "M5 19c0-6 3-7 7-7s7-1 7-7M3.5 17.5l3 3M17.5 3.5l3 3",
    note: "M5 4h14v11l-5 5H5zM14 20v-5h5M8 9h8M8 12.5h5",
    trash: "M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5",
    envelope: "M3.5 6.5h17v11h-17zM3.5 7l8.5 6.5L20.5 7",
    play: "M8 5.5v13l10.5-6.5z",
    pause: "M8 5.5v13M16 5.5v13",
    step: "M6 5.5v13l9-6.5zM18 5.5v13",
    reset: "M5 12a7 7 0 1 0 2.1-5M5 4.5v4h4",
    forward: "M3.5 6.5v11l8-5.5zM12 6.5v11l8-5.5z",
    clock: "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM12 7.5V12l3 2",
    plus: "M12 5v14M5 12h14",
    minus: "M5 12h14",
    folder: "M3.5 7V18a1 1 0 0 0 1 1h15a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-8L9.5 5.5H4.5a1 1 0 0 0-1 1z",
    save: "M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6",
    undo: "M9 6L4.5 10.5 9 15M5 10.5h9a5 5 0 0 1 0 10h-3",
    redo: "M15 6l4.5 4.5L15 15M19 10.5h-9a5 5 0 0 0 0 10h3",
    gear: "M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM12 3l1.4 2.3 2.6-.6.6 2.6L19 8.6l-1 2.4 1 2.4-2.4 1.3-.6 2.6-2.6-.6L12 21l-1.4-2.3-2.6.6-.6-2.6L5 15.4l1-2.4-1-2.4 2.4-1.3.6-2.6 2.6.6z",
    search: "M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM15.5 15.5L20 20",
    close: "M6 6l12 12M18 6L6 18",
    power: "M12 3.5v8M7.2 6.6a7 7 0 1 0 9.6 0",
    terminal: "M3.5 5h17v14h-17zM7 9.5l3 2.5-3 2.5M12.5 15h4.5",
    chevronDown: "M6 9.5l6 6 6-6",
    chevronRight: "M9.5 6l6 6-6 6",
    filter: "M4 6h16M7 12h10M10 18h4",
    info: "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM12 11v5.5M12 7.6v.2",
    history: "M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v3.7h3.7M12 8v4.5l3 1.8",
    download: "M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14",
    upload: "M12 15V4M7.5 8.5L12 4l4.5 4.5M5 19.5h14",
    zoomIn: "M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM15.5 15.5L20 20M10.5 8v5M8 10.5h5",
    zoomOut: "M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM15.5 15.5L20 20M8 10.5h5",
    fit: "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5",
    doc: "M6 3.5h8l4 4v13H6zM14 3.5v4h4",
    sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z",
    globe: "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM3.5 12h17M12 3.5c2.6 2.3 3.6 5.3 3.6 8.5s-1 6.2-3.6 8.5c-2.6-2.3-3.6-5.3-3.6-8.5s1-6.2 3.6-8.5z",
    network: "M12 4v5M6 15v-3h12v3M4 15h4v5H4zM10 15h4v5h-4zM16 15h4v5h-4zM10 4h4v5h-4z",
    keyboard: "M3 7h18v10H3zM6.5 10h1M10 10h1M13.5 10h1M17 10h1M7.5 14h9",
    check: "M5 12.5l4.5 4.5L19 7.5",
    warning: "M12 4l9 16H3zM12 10v4.5M12 17.3v.2",
    copy: "M8.5 8.5h11v11h-11zM15.5 8.5v-4h-11v11h4",
    duplicate: "M8.5 8.5h11v11h-11zM15.5 8.5v-4h-11v11h4M14 12v4M12 14h4",
    lock: "M6.5 11h11v9h-11zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
    wifi: "M4 9.5a11 11 0 0 1 16 0M7 12.8a6.5 6.5 0 0 1 10 0M10 16a2.5 2.5 0 0 1 4 0M12 19v.2",
    list: "M8.5 6.5h11M8.5 12h11M8.5 17.5h11M4.5 6.5h.2M4.5 12h.2M4.5 17.5h.2",
    eye: "M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12zM12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z",
    layers: "M12 4l8.5 4.5L12 13 3.5 8.5zM3.5 12.5L12 17l8.5-4.5M3.5 16.5L12 21l8.5-4.5",
    book: "M4 5.5c2.7-1 5.3-1 8 .5 2.7-1.5 5.3-1.5 8-.5v13c-2.7-1-5.3-1-8 .5-2.7-1.5-5.3-1.5-8-.5zM12 6v13",
    github: "M9 19c-4 1.3-4-2-5.6-2.5M15 21v-3.4a3 3 0 0 0-.8-2.3c2.8-.3 5.6-1.4 5.6-6.1a4.7 4.7 0 0 0-1.3-3.3 4.4 4.4 0 0 0-.1-3.3s-1-.3-3.4 1.3a11.6 11.6 0 0 0-6 0C6.6 2.3 5.6 2.6 5.6 2.6a4.4 4.4 0 0 0-.1 3.3 4.7 4.7 0 0 0-1.3 3.3c0 4.7 2.8 5.8 5.6 6.1a3 3 0 0 0-.8 2.3V21",
  };
  export const ICONS = Object.keys(P);
</script>

<script lang="ts">
  let { name, size = 18, stroke = 1.7, fill = false }: { name: string; size?: number; stroke?: number; fill?: boolean } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill={fill ? "currentColor" : "none"} stroke="currentColor" stroke-width={stroke} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none">
  <path d={P[name] ?? P.info} />
</svg>
