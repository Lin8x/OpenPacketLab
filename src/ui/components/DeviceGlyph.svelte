<script lang="ts" module>
  import type { DeviceKind } from "../../engine/network";

  // Original device artwork: a rounded tile with a simple white glyph.
  export const KIND_COLOR: Record<DeviceKind, [string, string]> = {
    router: ["#4b8cff", "#1f5fe0"],
    switch: ["#36c2d6", "#118aa6"],
    l3switch: ["#9b6bff", "#6b3fe0"],
    hub: ["#a2a8b3", "#6e7480"],
    pc: ["#5e6c84", "#384459"],
    laptop: ["#5e6c84", "#384459"],
    server: ["#ff9f43", "#e0701a"],
    printer: ["#8f97a6", "#5f6776"],
    phone: ["#43c77a", "#1f9a52"],
    tablet: ["#43c77a", "#1f9a52"],
    iot: ["#f06292", "#c2185b"],
    ap: ["#4dd0e1", "#00838f"],
    firewall: ["#ff6b6b", "#d32f2f"],
    cloud: ["#90caf9", "#5c9ce6"],
  };

  const GLYPH: Partial<Record<DeviceKind, string>> = {
    // Router: disc with crossing arrows.
    router: "M16 22h8M20 18v8M12.5 14.5l3 3M27.5 14.5l-3 3M12.5 29.5l3-3M27.5 29.5l-3-3M10 12l3 .3-.3-3M30 12l-3 .3.3-3M10 32l3-.3-.3 3M30 32l-3-.3.3 3",
    // Switch: two opposing arrow pairs.
    switch: "M9 16h20M25 12l4 4-4 4M31 28H11M15 24l-4 4 4 4",
    l3switch: "M9 15h20M25 11l4 4-4 4M31 25H11M15 21l-4 4 4 4M15 32h10",
    hub: "M20 10v24M10 22h20M13 15l14 14M27 15L13 29",
    pc: "M9 11h22v15H9zM16 31h8M20 26v5",
    laptop: "M11 12h18v13H11zM7 29h26l-2 2H9z",
    server: "M11 9h18v7H11zM11 18.5h18v7H11zM11 28h18v6H11zM14.5 12.5h3M14.5 22h3M14.5 31h3",
    printer: "M13 10h14v6H13zM9 16h22v11H9zM13 23h14v9H13z",
    phone: "M15 8h10a1 1 0 0 1 1 1v26a1 1 0 0 1-1 1H15a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zM19 32h2",
    tablet: "M11 9h18a1 1 0 0 1 1 1v24a1 1 0 0 1-1 1H11a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1zM19 31h2",
    iot: "M20 17a5 5 0 1 1 0 10 5 5 0 0 1 0-10zM13 15a10 10 0 0 0 0 14M27 15a10 10 0 0 1 0 14M9.5 11.5a15 15 0 0 0 0 21M30.5 11.5a15 15 0 0 1 0 21",
    ap: "M12 28h16v4H12zM20 28v-8M14 17a8 8 0 0 1 12 0M11 13.5a12 12 0 0 1 18 0",
    firewall: "M9 12h22v20H9zM9 19h22M9 26h22M16 12v7M24 19v7M16 26v6",
    cloud: "M13 29a6 6 0 0 1 0-12 8 8 0 0 1 15 1 5.5 5.5 0 0 1 0 11z",
  };
</script>

<script lang="ts">
  let { kind, size = 44, x, y, dim = false }: { kind: DeviceKind; size?: number; x?: number; y?: number; dim?: boolean } = $props();
  const id = `g${Math.random().toString(36).slice(2, 8)}`;
  const c = $derived(KIND_COLOR[kind] ?? KIND_COLOR.pc);
  const round = $derived(kind === "router" ? 20 : 10);
</script>

<svg {x} {y} width={size} height={size} viewBox="0 0 40 44" opacity={dim ? 0.45 : 1} aria-hidden="true">
  <defs>
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color={c[0]} />
      <stop offset="1" stop-color={c[1]} />
    </linearGradient>
  </defs>
  <rect x="2" y="3.5" width="36" height="38" rx={round} fill="rgba(0,0,0,.18)" />
  <rect x="2" y="2" width="36" height="38" rx={round} fill="url(#{id})" />
  <rect x="2.5" y="2.5" width="35" height="37" rx={round - 0.5} fill="none" stroke="rgba(255,255,255,.28)" />
  <path d={GLYPH[kind] ?? GLYPH.pc} fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" transform="translate(0 -1)" />
</svg>
