import pluginImp from '@graysonlang/esp/esbuild-plugin-imp';
import { runBuild } from '@graysonlang/esp/esbuild-runner';

// Builds the demo page under example/ — the scratch WebGL/WebGPU harness used to exercise
// and document the probe. (The HUD is a separate concern: served by the cdp-gpu-hud bin,
// launched via `npm run gpu:hud` or the "GPU HUD (isolated)" launch config — not from this
// esbuild invoker.) The package's own library (src/*.mjs, the CLI) is plain Node.
function getOptions(args, verbose, logger) {
  return {
    assetNames: '[name]',
    bundle: true,
    entryPoints: {
      main: 'example/main.js',
    },
    format: 'esm',
    loader: {
      '.html': 'file',
    },
    outdir: 'www',
    plugins: [
      pluginImp({ logger, verbose }),
    ],
    target: ['esnext'],
    ...args,
  };
}

runBuild(getOptions);
