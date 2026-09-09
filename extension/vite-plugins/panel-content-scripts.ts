import { readFileSync } from 'node:fs';
import path from 'node:path';
import { build, type Plugin, type ResolvedConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

/**
 * Builds the content scripts that render a Svelte panel, because crxjs cannot.
 *
 * `@crxjs/vite-plugin` builds every `contentScripts.standaloneFiles` entry
 * through its own nested Vite build (`createIifeConfig`, `dist/index.mjs:1397`),
 * and that build hardcodes `plugins: []`: it inherits `root`, `mode`,
 * `resolve`, `define` and `esbuild` from the outer config and nothing else. So
 * `svelte()` never runs on that path, and a script that imports a `.svelte`
 * component fails with a JSX parse error (#369).
 *
 * That path is not optional for us. A dynamically registered MV3 content
 * script cannot be an ES module, so it has to be a standalone IIFE, and
 * registering dynamically is what keeps the LinkedIn host permission optional
 * (#317). So the panel-bearing scripts are built here instead, with the same
 * IIFE shape, the same output path, and the real Svelte plugin behind them.
 *
 * Two consequences worth knowing before touching this:
 *
 *  - The script's path is a plain string at every call site rather than a
 *    `?script` import, because `?script` is crxjs's own mechanism and resolves
 *    to a file crxjs emitted. `PANEL_CONTENT_SCRIPTS` below is the single list
 *    both this build and `chrome.scripting.registerContentScripts` read.
 *  - `panel.css` has to stay plain CSS. Vite's core CSS pipeline resolves its
 *    `@import` and its `?inline` query here, but `@tailwindcss/vite` is
 *    deliberately not in this build: a Tailwind directive in that sheet would
 *    silently produce nothing. `assertNoTailwindDirectives` fails the build
 *    rather than letting that ship.
 */

// The list lives in a runtime-safe module because the background worker reads
// it too, and this file imports vite and node:fs.
export { PANEL_CONTENT_SCRIPTS, panelScriptOutput } from '../src/content/panel-scripts.js';
import { PANEL_CONTENT_SCRIPTS, panelScriptOutput } from '../src/content/panel-scripts.js';

const TAILWIND_DIRECTIVE = /^\s*@(?:tailwind|theme|source|custom-variant|apply|plugin|utility)\b/m;
const TAILWIND_IMPORT = /^\s*@import\s+['"](?:tailwindcss|tw-animate-css|.*\/tailwind\.css)['"]/m;

/**
 * The regression guard #369 asks for. A Tailwind directive in a stylesheet this
 * build touches is not a style mistake, it is a rule that will not exist at
 * runtime, and the symptom is an unstyled panel on somebody else's page rather
 * than an error.
 */
export function assertNoTailwindDirectives(cssPath: string): void {
  const css = readFileSync(cssPath, 'utf8');
  const directive = TAILWIND_DIRECTIVE.exec(css) ?? TAILWIND_IMPORT.exec(css);
  if (directive) {
    throw new Error(
      `${path.relative(process.cwd(), cssPath)} carries a Tailwind directive (${directive[0].trim()}), ` +
        'but the panel content-script build runs no Tailwind plugin (#369), so it would resolve to nothing. ' +
        'Write plain CSS here, or move the rule to a surface Tailwind actually builds.',
    );
  }
}

// A rem length, and the tokens whose own value is one. `--radius` (0.625rem),
// `--row-py` and `--row-px` come from `tokens.css`, which is a verbatim copy of
// the dashboard's `app.css` (D2) and stays one, so a panel rule that derives a
// length from them collapses exactly like a literal `rem` would.
const REM_UNIT = /(?<![\w-])\d*\.?\d+rem\b/;
const REM_TOKEN = /var\(\s*--(?:radius|row-py|row-px)\s*[,)]/;

/**
 * The regression guard #524 asks for. A `rem` in this sheet is not a style
 * choice, it is a length that resolves against the host document's root
 * element: the sheet is adopted into a shadow root on a page we do not own,
 * and linkedin.com sets `html { font-size: 10px }`, so every `rem` rendered at
 * 62.5% of its intended size (8.125px chrome, a 20px control row) while the
 * same sheet looked correct in the side panel and in every test.
 */
export function assertNoRemUnits(cssPath: string): void {
  const css = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const offender = REM_UNIT.exec(css) ?? REM_TOKEN.exec(css);
  if (offender) {
    throw new Error(
      `${path.relative(process.cwd(), cssPath)} sizes something in rem (${offender[0].trim()}), ` +
        "but this sheet is adopted into a shadow root on the host page, where rem resolves against that page's " +
        'root font size (10px on linkedin.com), not against the panel (#524). Use px, em, a percentage or a ' +
        'unitless line-height, and do not derive a length from a token whose own value is in rem.',
    );
  }
}

function safeVarName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_$]/g, '_');
}

/**
 * Runs after the main build, so crxjs has already written the manifest and its
 * own chunks and we only add files. `enforce: 'post'` plus `closeBundle` is the
 * one ordering that holds: crxjs emits during `generateBundle`/`writeBundle`,
 * and an IIFE built here during those hooks would be overwritten.
 */
export function panelContentScripts(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'pitchbox:panel-content-scripts',
    apply: 'build',
    enforce: 'post',
    configResolved(resolved) {
      config = resolved;
    },
    async closeBundle() {
      const panelCss = path.resolve(config.root, 'src/content/panel.css');
      assertNoTailwindDirectives(panelCss);
      assertNoRemUnits(panelCss);
      for (const entry of PANEL_CONTENT_SCRIPTS) {
        const outputFile = panelScriptOutput(entry);
        await build({
          configFile: false,
          root: config.root,
          mode: config.mode,
          logLevel: 'warn',
          // The only plugin the plugin-less path was missing. Tailwind stays
          // out on purpose: see the doc comment.
          plugins: [svelte()],
          resolve: config.resolve,
          define: config.define,
          build: {
            outDir: config.build.outDir,
            emptyOutDir: false,
            minify: config.build.minify,
            sourcemap: config.build.sourcemap,
            target: config.build.target,
            lib: {
              entry: path.resolve(config.root, entry),
              formats: ['iife'],
              name: safeVarName(path.basename(outputFile, '.js')),
              fileName: () => outputFile,
            },
            rollupOptions: {
              output: { entryFileNames: outputFile, inlineDynamicImports: true },
            },
          },
        });
      }
    },
  };
}
