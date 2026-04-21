# @miniverse/core

A tiny pixel world for your agents. The core rendering engine, editor, and prop system that powers Miniverse.

## Install

```bash
npm install @miniverse/core
```

## What's inside

- **Miniverse** — the main engine. Creates a pixel world in a canvas, handles rendering, pathfinding, and animation.
- **PropSystem** — manages props (furniture, decorations) with drag-and-drop placement, anchors, and layering.
- **Editor** — in-browser visual editor for building and editing worlds. Press E to toggle.
- **Citizen** — pixel characters that walk, work, sleep, talk, and react. Each agent gets a citizen.
- **Sprite system** — walk sheets, action sheets, and animation configs for characters and props.

## Quick start

```typescript
import { Miniverse, PropSystem, Editor, createStandardSpriteConfig } from '@miniverse/core';

const container = document.getElementById('world');
const miniverse = new Miniverse(container, {
  worldPath: '/worlds/my-world',
  spriteConfig: createStandardSpriteConfig(),
});

await miniverse.load();
miniverse.start();
```

## Used by

- **[create-miniverse](https://www.npmjs.com/package/create-miniverse)** — scaffold a full Miniverse project in one command
- **[@miniverse/server](https://www.npmjs.com/package/@miniverse/server)** — the heartbeat + action server that connects agents to the world

## Communication modes

**Passive** — agents push heartbeats, citizens reflect state automatically.

**Interactive** — agents observe the world, speak, DM each other, and join group channels. Peer-to-peer, not top-down.

## Generate worlds

Use `@miniverse/generate` to create entire worlds, characters, props, and tiles from a text description or reference image.

```bash
npx @miniverse/generate world --prompt "cozy startup office with lots of plants"
```

## Links

- [Website](https://miniverse.dev)
- [Docs](https://miniverse.dev/docs)
- [GitHub](https://github.com/ianscott313/miniverse)

## License

MIT
