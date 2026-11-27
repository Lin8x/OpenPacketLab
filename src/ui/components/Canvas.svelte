<script lang="ts">
  import { app, LIBRARY } from "../state.svelte";
  import { prefs } from "../prefs.svelte";
  import type { Device, Link, Port } from "../../engine/network";
  import DeviceGlyph from "./DeviceGlyph.svelte";
  import Icon from "./Icon.svelte";

  let svg: SVGSVGElement;
  let w = $state(800);
  let h = $state(600);
  let pointer = $state({ x: 0, y: 0 });
  let marquee = $state<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  let portPicker = $state<{ device: string; x: number; y: number } | null>(null);
  let editingNote = $state<string | null>(null);

  const devices = $derived((app.tick, [...app.net.devices.values()]));
  const links = $derived((app.tick, [...app.net.links.values()]));
  const now = $derived((app.tick, performance.now()));

  const PROTO_COLOR: Record<string, string> = {
    ARP: "#ffcc00",
    ICMP: "#ff9500",
    DHCP: "#34c759",
    DNS: "#5ac8fa",
    HTTP: "#007aff",
    HTTPS: "#5856d6",
    TCP: "#8e8e93",
    UDP: "#a2845e",
    Telnet: "#af52de",
    SSH: "#bf5af2",
    RIP: "#ff2d55",
    OSPF: "#ff375f",
    EIGRP: "#ff6482",
    STP: "#30b0c7",
    LLDP: "#64d2ff",
    Syslog: "#8e8e93",
  };

  function toWorld(cx: number, cy: number) {
    const r = svg.getBoundingClientRect();
    return { x: (cx - r.left - app.view.x) / app.view.zoom, y: (cy - r.top - app.view.y) / app.view.zoom };
  }

  function snap(v: number) {
    return prefs.snapToGrid ? Math.round(v / 20) * 20 : v;
  }

  // ------------------------------------------------------------ interactions

  let drag:
    | { kind: "pan"; sx: number; sy: number; vx: number; vy: number }
    | { kind: "move"; ids: string[]; lx: number; ly: number; moved: boolean }
    | { kind: "marquee"; x0: number; y0: number; add: boolean }
    | { kind: "note"; id: string; lx: number; ly: number }
    | null = null;
  let spaceDown = false;

  function onPointerDown(e: PointerEvent) {
    portPicker = null;
    const p = toWorld(e.clientX, e.clientY);
    if (e.button === 1 || (e.button === 0 && spaceDown)) {
      drag = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: app.view.x, vy: app.view.y };
      svg.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    if (app.placing) {
      app.addDevice(app.placing, snap(p.x), snap(p.y));
      if (!e.shiftKey) app.placing = null;
      return;
    }
    if (app.tool === "note") {
      app.checkpoint();
      const id = `n${Math.random().toString(36).slice(2, 8)}`;
      app.notes.push({ id, x: p.x, y: p.y, text: "", color: "yellow" });
      editingNote = id;
      app.tool = "select";
      app.markDirty();
      return;
    }
    app.selectedLink = null;
    if (!e.shiftKey) app.selection = new Set();
    if (app.tool === "select") {
      drag = { kind: "marquee", x0: p.x, y0: p.y, add: e.shiftKey };
      marquee = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      svg.setPointerCapture(e.pointerId);
    } else {
      drag = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: app.view.x, vy: app.view.y };
      svg.setPointerCapture(e.pointerId);
    }
    app.pendingConnect = null;
  }

  function onPointerMove(e: PointerEvent) {
    const p = toWorld(e.clientX, e.clientY);
    pointer = p;
    if (!drag) return;
    if (drag.kind === "pan") {
      app.view = { ...app.view, x: drag.vx + e.clientX - drag.sx, y: drag.vy + e.clientY - drag.sy };
    } else if (drag.kind === "move") {
      const dx = p.x - drag.lx;
      const dy = p.y - drag.ly;
      if (!drag.moved && Math.hypot(dx, dy) < 2) return;
      if (!drag.moved) app.checkpoint();
      drag.moved = true;
      app.moveDevices(drag.ids, dx, dy);
      drag.lx = p.x;
      drag.ly = p.y;
    } else if (drag.kind === "marquee") {
      marquee = { x0: drag.x0, y0: drag.y0, x1: p.x, y1: p.y };
    } else if (drag.kind === "note") {
      const n = app.notes.find((x) => x.id === (drag as { id: string }).id);
      if (n) {
        n.x += p.x - drag.lx;
        n.y += p.y - drag.ly;
      }
      drag.lx = p.x;
      drag.ly = p.y;
      app.markDirty();
    }
  }

  function onPointerUp() {
    if (drag?.kind === "move" && drag.moved && prefs.snapToGrid) {
      for (const id of drag.ids) {
        const d = app.device(id);
        if (d) {
          d.x = snap(d.x);
          d.y = snap(d.y);
        }
      }
      app.bump();
    }
    if (drag?.kind === "marquee" && marquee) {
      const x0 = Math.min(marquee.x0, marquee.x1);
      const x1 = Math.max(marquee.x0, marquee.x1);
      const y0 = Math.min(marquee.y0, marquee.y1);
      const y1 = Math.max(marquee.y0, marquee.y1);
      if (x1 - x0 > 4 || y1 - y0 > 4) {
        const sel = new Set(drag.add ? app.selection : []);
        for (const d of devices) if (d.x >= x0 && d.x <= x1 && d.y >= y0 && d.y <= y1) sel.add(d.id);
        app.selection = sel;
      }
    }
    marquee = null;
    drag = null;
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const r = svg.getBoundingClientRect();
      const cx = e.clientX - r.left;
      const cy = e.clientY - r.top;
      const z0 = app.view.zoom;
      const z = Math.min(3, Math.max(0.25, z0 * Math.exp(-e.deltaY * 0.01)));
      app.view = { zoom: z, x: cx - ((cx - app.view.x) * z) / z0, y: cy - ((cy - app.view.y) * z) / z0 };
    } else {
      app.view = { ...app.view, x: app.view.x - e.deltaX, y: app.view.y - e.deltaY };
    }
  }

  let lastPress = { id: "", t: 0, x: 0, y: 0 };
  function onDevicePointerDown(e: PointerEvent, d: Device) {
    e.stopPropagation();
    portPicker = null;
    if (e.button !== 0) return;
    if (spaceDown) return onPointerDown(e);
    if (app.tool === "delete") return app.removeDevices([d.id]);
    if (app.tool === "pdu") {
      if (!app.pendingPdu) {
        app.pendingPdu = d.id;
        app.toast(`Source: ${d.hostname}. Now click the destination.`);
      } else if (app.pendingPdu !== d.id) {
        app.addPdu(app.pendingPdu, d.id);
        app.pendingPdu = null;
      }
      return;
    }
    if (app.tool === "connect") return connectClick(d, e);
    app.selectedLink = null;
    if (e.shiftKey) {
      const s = new Set(app.selection);
      if (s.has(d.id)) s.delete(d.id);
      else s.add(d.id);
      app.selection = s;
    } else if (!app.selection.has(d.id)) app.selection = new Set([d.id]);
    // Pointer capture retargets dblclick to the svg, so detect double-press here.
    const now = performance.now();
    const isDouble = lastPress.id === d.id && now - lastPress.t < 400 && Math.hypot(e.clientX - lastPress.x, e.clientY - lastPress.y) < 6;
    lastPress = isDouble ? { id: "", t: 0, x: 0, y: 0 } : { id: d.id, t: now, x: e.clientX, y: e.clientY };
    if (isDouble && !e.shiftKey) {
      drag = null;
      app.openWindow(d.id);
      return;
    }
    const p = toWorld(e.clientX, e.clientY);
    drag = { kind: "move", ids: [...app.selection], lx: p.x, ly: p.y, moved: false };
    svg.setPointerCapture(e.pointerId);
  }

  function connectClick(d: Device, e: PointerEvent) {
    const usable = app.usablePorts(d);
    if (!usable.length) return app.toast(`${d.hostname} has no free ports for this cable.`, "error");
    if (app.cable === "auto") {
      if (!app.pendingConnect) {
        app.pendingConnect = { device: d.id, port: "" };
        return;
      }
      const a = app.device(app.pendingConnect.device);
      if (!a || a === d) return;
      const pair = app.pendingConnect.port ? [a.port(app.pendingConnect.port)!, app.autoPortPair(a, d)?.[1]] : app.autoPortPair(a, d);
      if (!pair || !pair[0] || !pair[1]) {
        app.toast(`No compatible free ports between ${a.hostname} and ${d.hostname}.`, "error");
        app.pendingConnect = null;
        return;
      }
      const err = app.connect(pair[0], pair[1] as Port);
      if (err) app.toast(err, "error");
      app.pendingConnect = null;
      return;
    }
    const r = svg.getBoundingClientRect();
    portPicker = { device: d.id, x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function pickPort(p: Port) {
    portPicker = null;
    if (!app.pendingConnect) {
      app.pendingConnect = { device: p.device.id, port: p.name };
      return;
    }
    const a = app.device(app.pendingConnect.device)?.port(app.pendingConnect.port);
    if (!a) return;
    const err = app.connect(a, p);
    if (err) app.toast(err, "error");
    app.pendingConnect = null;
  }

  function onLinkDown(e: PointerEvent, l: Link) {
    e.stopPropagation();
    if (app.tool === "delete") return app.removeLink(l.id);
    app.selection = new Set();
    app.selectedLink = l.id;
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    const i = e.dataTransfer?.getData("application/x-opl-device");
    if (i === undefined || i === "") return;
    const p = toWorld(e.clientX, e.clientY);
    app.addDevice(LIBRARY[Number(i)], snap(p.x), snap(p.y));
  }

  // ------------------------------------------------------------ geometry

  function ends(l: Link) {
    const a = l.a.device;
    const b = l.b.device;
    // Parallel links between the same two devices are spread apart.
    const siblings = links.filter((x) => (x.a.device === a && x.b.device === b) || (x.a.device === b && x.b.device === a));
    const idx = siblings.indexOf(l);
    const off = (idx - (siblings.length - 1) / 2) * 14;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    return { x1: a.x + nx * off, y1: a.y + ny * off, x2: b.x + nx * off, y2: b.y + ny * off, len, ux: dx / len, uy: dy / len };
  }

  const LIGHT: Record<string, string> = { green: "var(--green)", amber: "var(--orange)", red: "var(--red)", off: "var(--gray)" };

  function cableStyle(l: Link): { color: string; dash?: string; width: number } {
    switch (l.cable) {
      case "crossover":
        return { color: "var(--label)", dash: "7 4", width: 1.8 };
      case "fiber":
        return { color: "#ff9500", width: 2 };
      case "serial":
        return { color: "#ff3b30", width: 2, dash: "12 3 2 3" };
      case "console":
        return { color: "#5ac8fa", width: 1.8, dash: "2 4" };
      case "wireless":
        return { color: "var(--accent)", width: 1.5, dash: "1 5" };
      default:
        return { color: "var(--label)", width: 1.8 };
    }
  }

  function envelopes() {
    void now;
    const out: { x: number; y: number; color: string; proto: string; id: number }[] = [];
    const dur = app.animDuration();
    const t = performance.now();
    for (const a of app.animating) {
      const l = app.net.links.get(a.tx.linkId);
      const from = app.device(a.tx.from);
      const to = app.device(a.tx.to);
      if (!from || !to) continue;
      const k = Math.min(1, (t - a.start) / dur);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      let x1 = from.x,
        y1 = from.y,
        x2 = to.x,
        y2 = to.y;
      if (l) {
        const g = ends(l);
        const forward = l.a.device === from;
        [x1, y1, x2, y2] = forward ? [g.x1, g.y1, g.x2, g.y2] : [g.x2, g.y2, g.x1, g.y1];
      }
      out.push({ x: x1 + (x2 - x1) * e, y: y1 + (y2 - y1) * e, color: a.tx.status === "lost" ? "var(--red)" : PROTO_COLOR[a.tx.proto] ?? "#8e8e93", proto: a.tx.proto, id: a.tx.id });
    }
    if (app.mode === "simulation" && !app.animating.length) {
      // Show frames waiting to be delivered next to their source.
      const pending = [...app.net.inFlight.values()].filter((tx) => app.filters.has(tx.proto));
      const seen = new Map<string, number>();
      for (const tx of pending) {
        const from = app.device(tx.from);
        const to = app.device(tx.to);
        if (!from || !to) continue;
        const key = tx.from + tx.to;
        const n = seen.get(key) ?? 0;
        seen.set(key, n + 1);
        const k = 0.22 + n * 0.06;
        out.push({ x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, color: PROTO_COLOR[tx.proto] ?? "#8e8e93", proto: tx.proto, id: tx.id });
      }
    }
    return out;
  }

  // Keep animation frames flowing while envelopes move.
  $effect(() => {
    if (!app.animating.length) return;
    let raf = 0;
    const tick = () => {
      app.bump();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });

  const picker = $derived(portPicker ? app.device(portPicker.device) : undefined);
  const pendingDev = $derived(app.pendingConnect ? app.device(app.pendingConnect.device) : app.pendingPdu ? app.device(app.pendingPdu) : undefined);
  const cursor = $derived(app.placing ? "copy" : app.tool === "connect" || app.tool === "pdu" ? "crosshair" : app.tool === "delete" ? "not-allowed" : app.tool === "note" ? "text" : "default");

  function ipLabel(d: Device): string {
    const any = d as unknown as { active?: { ip: string }; stack?: { interfaces(): { ip?: string; isUp(): boolean }[] } };
    if (any.active) return any.active.ip;
    return "";
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === " " && !(e.target as HTMLElement).closest("input,textarea,.terminal")) spaceDown = true;
  }}
  onkeyup={(e) => {
    if (e.key === " ") spaceDown = false;
  }}
/>

<div class="wrap" bind:clientWidth={w} bind:clientHeight={h} ondragover={(e) => e.preventDefault()} ondrop={onDrop} role="application" aria-label="Topology canvas">
  <svg bind:this={svg} width={w} height={h} style:cursor onpointerdown={onPointerDown} onpointermove={onPointerMove} onpointerup={onPointerUp} onwheel={onWheel} role="presentation">
    {#if prefs.showGrid}
      <defs>
        <pattern id="grid" width={20 * app.view.zoom} height={20 * app.view.zoom} patternUnits="userSpaceOnUse" x={app.view.x} y={app.view.y}>
          <circle cx="1" cy="1" r={app.view.zoom > 0.6 ? 1 : 0.6} fill="var(--grid)" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#grid)" />
    {/if}
    <g transform="translate({app.view.x} {app.view.y}) scale({app.view.zoom})">
      {#each app.notes as n (n.id)}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <g
          class="note"
          transform="translate({n.x} {n.y})"
          onpointerdown={(e) => {
            e.stopPropagation();
            if (app.tool === "delete") {
              app.checkpoint();
              app.notes = app.notes.filter((x) => x.id !== n.id);
              return;
            }
            const p = toWorld(e.clientX, e.clientY);
            drag = { kind: "note", id: n.id, lx: p.x, ly: p.y };
            svg.setPointerCapture(e.pointerId);
          }}
          ondblclick={() => (editingNote = n.id)}
        >
          <foreignObject width={n.w ?? 220} height={n.h ?? 110}>
            {#if editingNote === n.id}
              <!-- svelte-ignore a11y_autofocus -->
              <textarea class="notetext {n.color}" bind:value={n.text} autofocus onblur={() => { editingNote = null; if (!n.text.trim()) app.notes = app.notes.filter((x) => x.id !== n.id); app.markDirty(); }} onpointerdown={(e) => e.stopPropagation()}></textarea>
            {:else}
              <div class="notetext {n.color}">{n.text || "Double-click to edit"}</div>
            {/if}
          </foreignObject>
        </g>
      {/each}

      {#each links as l (l.id)}
        {@const g = ends(l)}
        {@const st = cableStyle(l)}
        {@const sel = app.selectedLink === l.id}
        <g class="link" onpointerdown={(e) => onLinkDown(e, l)} role="presentation">
          <line x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} stroke="transparent" stroke-width="14" />
          {#if sel}<line x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} stroke="var(--accent)" stroke-width={st.width + 5} stroke-opacity="0.35" stroke-linecap="round" />{/if}
          <line x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} stroke={st.color} stroke-width={st.width} stroke-dasharray={st.dash} stroke-opacity="0.75" stroke-linecap="round" />
          {#if prefs.showLinkLights && g.len > 70}
            <circle cx={g.x1 + g.ux * 34} cy={g.y1 + g.uy * 34} r="4.2" fill={LIGHT[l.a.light]} stroke="var(--canvas)" stroke-width="1.5" />
            <circle cx={g.x2 - g.ux * 34} cy={g.y2 - g.uy * 34} r="4.2" fill={LIGHT[l.b.light]} stroke="var(--canvas)" stroke-width="1.5" />
          {/if}
          {#if prefs.showPortLabels && g.len > 120}
            <text class="plabel" x={g.x1 + g.ux * 52 + (g.uy > 0 ? 6 : -6) * Math.abs(g.ux)} y={g.y1 + g.uy * 52 + 3} text-anchor="middle">{l.a.short}</text>
            <text class="plabel" x={g.x2 - g.ux * 52 + (g.uy > 0 ? 6 : -6) * Math.abs(g.ux)} y={g.y2 - g.uy * 52 + 3} text-anchor="middle">{l.b.short}</text>
          {/if}
        </g>
      {/each}

      {#if pendingDev}
        <line class="rubber" x1={pendingDev.x} y1={pendingDev.y} x2={pointer.x} y2={pointer.y} />
      {/if}

      {#each devices as d (d.id)}
        {@const sel = app.selection.has(d.id)}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <g class="device" transform="translate({d.x} {d.y})" onpointerdown={(e) => onDevicePointerDown(e, d)}>
          {#if sel}<rect x="-34" y="-34" width="68" height="68" rx="16" class="selring" />{/if}
          {#if app.pendingConnect?.device === d.id || app.pendingPdu === d.id}<rect x="-34" y="-34" width="68" height="68" rx="16" class="pendring" />{/if}
          <DeviceGlyph kind={d.kind} size={50} x={-25} y={-28} dim={!d.powered} />
          <text class="dlabel" y="40" text-anchor="middle">{d.hostname}</text>
          {#if ipLabel(d) && app.view.zoom > 0.7}<text class="dsub" y="53" text-anchor="middle">{ipLabel(d)}</text>{/if}
          {#if !d.powered}<g transform="translate(18 -30)"><circle r="8" fill="var(--red)" /><path d="M0 -4v3.5M-2.8 -2.2a4 4 0 1 0 5.6 0" stroke="#fff" stroke-width="1.5" fill="none" stroke-linecap="round" /></g>{/if}
        </g>
      {/each}

      {#each envelopes() as env (env.id)}
        <g transform="translate({env.x - 11} {env.y - 8})" class="env">
          <rect width="22" height="16" rx="3" fill={env.color} stroke="rgba(0,0,0,.25)" stroke-width="0.6" />
          <path d="M1.5 2l9.5 7 9.5-7" stroke="rgba(255,255,255,.9)" stroke-width="1.4" fill="none" />
        </g>
      {/each}

      {#if marquee}
        <rect class="marquee" x={Math.min(marquee.x0, marquee.x1)} y={Math.min(marquee.y0, marquee.y1)} width={Math.abs(marquee.x1 - marquee.x0)} height={Math.abs(marquee.y1 - marquee.y0)} />
      {/if}
    </g>
  </svg>

  {#if !devices.length && !app.sheet}
    <div class="empty">
      <div class="emptycard">
        <Icon name="network" size={34} stroke={1.4} />
        <h2>Start building</h2>
        <p class="muted">Drag a router, switch or PC from the library, then use the Connect tool to cable them together.</p>
        <button class="btn" onclick={() => (app.sheet = "welcome")}>Open a sample lab</button>
      </div>
    </div>
  {/if}

  {#if picker && portPicker}
    <div class="picker" style="left:{Math.min(portPicker.x + 8, w - 240)}px; top:{Math.min(portPicker.y + 8, h - 300)}px" role="menu">
      <div class="phead">{picker.hostname}: choose a port</div>
      <div class="scroll plist">
        {#each picker.ports as p}
          {@const usable = !p.link && app.usablePorts(picker).includes(p)}
          <button role="menuitem" disabled={!usable} onclick={() => pickPort(p)}>
            <span class="dot" style="background:{p.link ? 'var(--gray)' : 'var(--green)'}"></span>
            <span class="pn">{p.name}</span>
            <span class="muted pm">{p.link ? "in use" : p.media}</span>
          </button>
        {/each}
      </div>
    </div>
  {/if}

  <div class="zoombar">
    <button class="btn plain icon" aria-label="Zoom out" onclick={() => (app.view = { ...app.view, zoom: Math.max(0.25, app.view.zoom / 1.2) })}><Icon name="minus" size={15} /></button>
    <button class="btn plain zl" onclick={() => (app.view = { ...app.view, zoom: 1 })} title="Actual size">{Math.round(app.view.zoom * 100)}%</button>
    <button class="btn plain icon" aria-label="Zoom in" onclick={() => (app.view = { ...app.view, zoom: Math.min(3, app.view.zoom * 1.2) })}><Icon name="plus" size={15} /></button>
  </div>
</div>

<style>
  .wrap {
    flex: 1;
    position: relative;
    overflow: hidden;
    background: var(--canvas);
    min-height: 0;
  }
  svg {
    display: block;
    touch-action: none;
  }
  .device {
    cursor: inherit;
  }
  .dlabel {
    font-size: 12px;
    font-weight: 600;
    fill: var(--label);
    paint-order: stroke;
    stroke: var(--canvas);
    stroke-width: 4px;
    stroke-linejoin: round;
  }
  .dsub {
    font-size: 10.5px;
    fill: var(--secondary);
    font-variant-numeric: tabular-nums;
    paint-order: stroke;
    stroke: var(--canvas);
    stroke-width: 4px;
  }
  .plabel {
    font-size: 9.5px;
    fill: var(--secondary);
    paint-order: stroke;
    stroke: var(--canvas);
    stroke-width: 3px;
  }
  .selring {
    fill: var(--accent-soft);
    stroke: var(--accent);
    stroke-width: 1.5;
  }
  .pendring {
    fill: none;
    stroke: var(--green);
    stroke-width: 2;
    stroke-dasharray: 4 3;
  }
  .rubber {
    stroke: var(--accent);
    stroke-width: 1.5;
    stroke-dasharray: 5 4;
    pointer-events: none;
  }
  .marquee {
    fill: var(--accent-soft);
    stroke: var(--accent);
    stroke-width: 1;
  }
  .env {
    pointer-events: none;
    filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.3));
  }
  .notetext {
    width: 100%;
    height: 100%;
    padding: 8px 10px;
    border-radius: 8px;
    font: 12px/1.4 var(--font);
    color: #1d1d1f;
    background: #fff6b3;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
    border: none;
    resize: none;
    outline: none;
    overflow: hidden;
    white-space: pre-wrap;
    user-select: text;
  }
  .notetext.blue {
    background: #d7ebff;
  }
  .notetext.green {
    background: #d9f5df;
  }
  .notetext.pink {
    background: #ffe0ea;
  }
  .empty {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    pointer-events: none;
  }
  .emptycard {
    text-align: center;
    max-width: 320px;
    color: var(--secondary);
    pointer-events: auto;
  }
  .emptycard h2 {
    color: var(--label);
    font: 600 20px var(--font-display);
    margin: 10px 0 6px;
  }
  .picker {
    position: absolute;
    width: 230px;
    background: var(--elevated);
    border-radius: 10px;
    box-shadow: var(--shadow);
    padding: 4px;
    z-index: 5;
  }
  .phead {
    font-size: 11px;
    font-weight: 600;
    color: var(--secondary);
    padding: 6px 8px 4px;
  }
  .plist {
    max-height: 260px;
  }
  .picker button {
    all: unset;
    display: flex;
    align-items: center;
    gap: 8px;
    width: calc(100% - 16px);
    padding: 4px 8px;
    border-radius: 5px;
  }
  .picker button:not(:disabled):hover {
    background: var(--accent);
    color: #fff;
  }
  .picker button:disabled {
    opacity: 0.4;
  }
  .pn {
    flex: 1;
  }
  .pm {
    font-size: 11px;
  }
  .zoombar {
    position: absolute;
    right: 12px;
    bottom: 12px;
    display: flex;
    align-items: center;
    background: var(--surface);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border-radius: 9px;
    box-shadow: var(--shadow-sm);
    padding: 2px;
  }
  .zl {
    width: 52px;
    padding: 0;
    font-variant-numeric: tabular-nums;
  }
</style>
