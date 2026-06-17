// CLI HUD source: bind the shared renderer to the probe's SSE stream.
//
// This is the only file that knows the data arrives over Server-Sent Events. The
// rendering (hud-render.js), markup (index.html), and styling are transport-neutral,
// so an extension or the direct HUD can reuse them by feeding the same renderer
// methods from its own source instead of an EventSource.

import { mountHud } from './hud-dom.js';
import { createHudRenderer } from './hud-render.js';

const hud = createHudRenderer(mountHud());

const source = new EventSource('/events');
source.addEventListener('open', () => hud.setLive(true));
source.addEventListener('error', () => hud.setLive(false));
source.addEventListener('info', e => hud.renderInfo(JSON.parse(e.data)));
source.addEventListener('target', e => hud.renderTarget(JSON.parse(e.data)));
source.addEventListener('sample', e => hud.renderSample(JSON.parse(e.data)));
source.addEventListener('status', e => hud.setStatus(JSON.parse(e.data).message));

window.addEventListener('resize', () => hud.redraw());
