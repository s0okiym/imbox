import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
/** Build-time allowlist: no runtime API request can add a body to the shell cache. */
export function shellWorker(): Plugin {
  return {
    name: 'imbox-static-shell',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const assets = [
        '/',
        '/manifest.webmanifest',
        '/imbox-icon.svg',
        ...Object.keys(bundle)
          .filter((name) => name.startsWith('assets/') && /\.(?:js|css|woff2?)$/.test(name))
          .map((name) => '/' + name),
      ].sort();
      const hash = createHash('sha256');
      for (const name of Object.keys(bundle).sort()) {
        const item = bundle[name]!;
        hash.update(name).update(item.type === 'chunk' ? item.code : item.source);
      }
      const template = readFileSync(new URL('./service-worker.js', import.meta.url), 'utf8');
      hash.update(template);
      const config = `const SHELL_CACHE = ${JSON.stringify('imbox-shell-' + hash.digest('hex').slice(0, 20))};\nconst SHELL_ASSETS = ${JSON.stringify(assets)};`;
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: template.replace('/* __IMBOX_SHELL_CONFIG__ */', config),
      });
    },
  };
}
