# Contributing to OpenPacketLab

Thanks for helping. Bug reports, lab ideas and pull requests are all welcome.

## Getting started

```sh
npm ci
npm run opl -- doctor
npm run dev
```

Before opening a pull request, run `npm run opl -- check` and add a line to
`## [Unreleased]` in `CHANGELOG.md`.

## How the code fits together

- **Engine (`src/engine`)** has no UI code and runs in Node, so it is fully
  testable. `network.ts` holds the event scheduler, links and the `Device`
  base class. Frames are plain immutable objects (`packets.ts`). Each device
  receives frames in `receive()` and schedules work with `net.schedule()`.
- **Devices (`src/engine/devices`)**: `host.ts` (PCs, servers and other end
  devices), `switch.ts`, `router.ts`, `routing.ts` (RIP, OSPF, EIGRP) and
  `acl.ts`. `ipstack.ts` is the shared IPv4 stack.
- **CLI (`src/engine/cli`)**: commands are declared in `session.ts` with a
  small syntax language, for example
  `"ip route <net:ip> <mask:mask> <hop:ip>"`, `{a|b}` for choices, and
  `<n:num:1-4094>` for ranges. The parser handles abbreviations, `?`, Tab,
  and `no` forms. `show.ts` renders `show` output.
- **UI (`src/ui`)**: Svelte 5. `state.svelte.ts` owns the network and the
  editor state; components never mutate the engine except through it or the
  CLI.

## Adding a CLI command

1. Add a `d({ modes, syntax, help, run })` entry in `src/engine/cli/session.ts`.
2. If it changes configuration, make sure `runningConfig()` in `show.ts`
   prints it back so it survives save and reload.
3. Add a test in `tests/cli.test.ts`.

## Adding a protocol

1. Add the packet type to `packets.ts` (and to `ALL_PROTOCOLS` so simulation
   mode can filter it).
2. Implement it on the device, using `this.every()` for timers.
3. Add an engine test in `tests/engine.test.ts` using the `Lab` helper.

## Design

The interface follows Apple's Human Interface Guidelines: clarity, deference
to content, system colors and typography, and standard controls. Keep new UI
consistent with the tokens in `src/ui/styles.css` and draw icons in the same
24 px line style as `Icon.svelte`. All artwork must be original.

## License

By contributing you agree that your contributions are licensed under the
Apache License 2.0.
