// Static enforcement of docs/linkedin-integration-design.md's "compliance
// boundary" (#308). Each `checkRuleN` function below implements exactly one
// of the six prohibitions and returns every violation it finds - it never
// throws on a clean tree and never skips a rule because a file happens not
// to exist (an empty scan directory legitimately produces zero violations,
// which is not the same thing as skipping the rule).
//
// Implementation choice: AST-walking over `docs/linkedin-integration-design.md`'s
// own text with `ts.createSourceFile`, in the same spirit as the source-text
// assertions #303 already added to `linkedin-dom.test.ts`. A custom eslint
// rule was the other option; a test wins here because three of the six rules
// need cross-file reasoning (deriving the content-script set from
// `manifest.config.ts`, tracing a value from a `linkedin-dom.ts` accessor to
// a later `.click()`, walking the call graph reachable from a
// `chrome.alarms` handler) that a single-file eslint rule cannot express
// without a custom multi-pass program, while a plain module with the
// TypeScript compiler API expresses each in a few dozen lines and is testable
// in isolation against fixtures.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

export type RuleId = 1 | 2 | 3 | 4 | 5 | 6;

export type Violation = {
  rule: RuleId;
  file: string;
  message: string;
};

const EXCLUDED_DIRS: Record<string, true> = {
  node_modules: true,
  dist: true,
  '.svelte-kit': true,
  build: true,
};
const NETWORK_TARGET_RE = /linkedin|licdn/i;
const CLICK_OR_SUBMIT_RE = /click|submit/i;
const CLICK_SUBMIT_METHODS: Record<string, true> = { click: true, submit: true };

function makeViolation(rule: RuleId, file: string, detail: string): Violation {
  const rel = path.isAbsolute(file) ? path.relative(process.cwd(), file) : file;
  return { rule, file: rel, message: `linkedin-compliance rule ${rule}: ${rel} ${detail}` };
}

function trim(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function walkFiles(dir: string, extensions: string[]): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS[entry.name]) continue;
      out.push(...walkFiles(full, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

function extractScriptBlocks(svelteSource: string): string {
  const blocks: string[] = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svelteSource))) blocks.push(m[1]);
  return blocks.join('\n');
}

function parseSource(file: string): ts.SourceFile {
  const raw = fs.readFileSync(file, 'utf8');
  const text = file.endsWith('.svelte') ? extractScriptBlocks(raw) : raw;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function unwrap(expr: ts.Expression): ts.Expression {
  let cur = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(cur)) {
      cur = cur.expression;
    } else if (ts.isNonNullExpression(cur)) {
      cur = cur.expression;
    } else if (ts.isAsExpression(cur)) {
      cur = cur.expression;
    } else {
      return cur;
    }
  }
}

/** Resolves a relative import specifier to a file on disk. Bare specifiers
 * (packages, `chrome`, `vitest`, ...) are intentionally not resolved. */
export function resolveModuleFile(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const stripped = base.replace(/\.(js|jsx|ts|tsx)$/, '');
  const candidates = [
    `${stripped}.ts`,
    `${stripped}.tsx`,
    `${stripped}.svelte`,
    base,
    path.join(base, 'index.ts'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rule 1: no fetch/XMLHttpRequest/sendBeacon whose target mentions linkedin/licdn.
// ---------------------------------------------------------------------------
export function checkNetworkTargets(scanDir: string): Violation[] {
  const violations: Violation[] = [];
  for (const file of walkFiles(scanDir, ['.ts', '.svelte'])) {
    const sf = parseSource(file);
    const usesXhr = /new\s+XMLHttpRequest\b/.test(sf.text);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (ts.isIdentifier(callee) && callee.text === 'fetch' && node.arguments.length > 0) {
          const target = node.arguments[0].getText(sf);
          if (NETWORK_TARGET_RE.test(target)) {
            violations.push(
              makeViolation(
                1,
                file,
                `calls fetch(${trim(target)}) whose target mentions "linkedin"/"licdn"`,
              ),
            );
          }
        } else if (ts.isPropertyAccessExpression(callee)) {
          const method = callee.name.text;
          if (method === 'open' && usesXhr && node.arguments.length > 1) {
            const target = node.arguments[1].getText(sf);
            if (NETWORK_TARGET_RE.test(target)) {
              violations.push(
                makeViolation(
                  1,
                  file,
                  `calls XMLHttpRequest#open(..., ${trim(target)}) whose target mentions "linkedin"/"licdn"`,
                ),
              );
            }
          } else if (method === 'sendBeacon') {
            const objectText = callee.expression.getText(sf);
            if (/\bnavigator\b/.test(objectText)) {
              const target = node.arguments[0]?.getText(sf) ?? '';
              if (NETWORK_TARGET_RE.test(target)) {
                violations.push(
                  makeViolation(
                    1,
                    file,
                    `calls navigator.sendBeacon(${trim(target)}, ...) whose target mentions "linkedin"/"licdn"`,
                  ),
                );
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Rule 2: no document.cookie/chrome.cookies/localStorage/sessionStorage read
// inside a file registered as a LinkedIn content script in manifest.config.ts.
// ---------------------------------------------------------------------------
type ManifestContentScript = { matches?: string[]; js?: string[] };
type ManifestShape = { content_scripts?: ManifestContentScript[]; host_permissions?: string[] };

async function loadManifest(manifestPath: string): Promise<ManifestShape> {
  // manifestPath is runtime-selected: the real check points it at
  // extension/manifest.config.ts, but the rule-2/rule-6 fixture tests below
  // point it at inert fixture manifests, so the specifier cannot be static.
  const mod = (await import(pathToFileURL(manifestPath).href)) as { default?: ManifestShape };
  if (!mod.default) {
    throw new Error(
      `${manifestPath} has no default export - cannot derive the compliance boundary from it`,
    );
  }
  return mod.default;
}

/**
 * The LinkedIn content-script file set. Derived, never hardcoded, from the two
 * ways a script can actually reach linkedin.com:
 *
 * 1. a static `content_scripts` block in manifest.config.ts whose `matches`
 *    mention a linkedin/licdn origin;
 * 2. a `chrome.scripting.registerContentScripts` call whose `matches` mention
 *    one, with each `js` entry resolved back through the import that produced
 *    it (crxjs hands the built path over a `?script` import, so the array holds
 *    an identifier rather than a literal).
 *
 * The second source exists because of a hole this rule shipped with. #348
 * registered the first real LinkedIn content script dynamically, precisely so
 * the LinkedIn grant stays optional (#317), which took it out of the static
 * array this function used to be the whole of - so the rule scanned nothing and
 * passed by omission, on exactly the file it exists for. #308 says the check
 * must never be skippable on some inputs; a scan set that silently empties is
 * that, in a slower form.
 */
export async function linkedinContentScriptFiles(
  manifestPath: string,
  sourceRoot?: string,
): Promise<string[]> {
  const manifest = await loadManifest(manifestPath);
  const dir = path.dirname(manifestPath);
  const files = new Set<string>();
  for (const entry of manifest.content_scripts ?? []) {
    const isLinkedIn = (entry.matches ?? []).some((m) => NETWORK_TARGET_RE.test(m));
    if (!isLinkedIn) continue;
    for (const js of entry.js ?? []) files.add(path.resolve(dir, js));
  }
  for (const file of dynamicallyRegisteredLinkedinScripts(sourceRoot ?? path.join(dir, 'src'))) {
    files.add(file);
  }
  return [...files];
}

/** Every file a `chrome.scripting.registerContentScripts` call registers against
 * a linkedin/licdn match, anywhere under `sourceRoot`. */
function dynamicallyRegisteredLinkedinScripts(sourceRoot: string): string[] {
  const found = new Set<string>();
  if (!fs.existsSync(sourceRoot)) return [];
  for (const file of walkFiles(sourceRoot, ['.ts'])) {
    const sf = parseSource(file);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        /registerContentScripts$/.test(unwrap(node.expression).getText(sf)) &&
        node.arguments.length > 0
      ) {
        const arg = unwrap(node.arguments[0]);
        const entries = ts.isArrayLiteralExpression(arg) ? arg.elements : [arg];
        for (const entry of entries) {
          const obj = unwrap(entry);
          if (!ts.isObjectLiteralExpression(obj)) continue;
          const prop = (name: string) =>
            obj.properties.find(
              (p): p is ts.PropertyAssignment =>
                ts.isPropertyAssignment(p) && p.name.getText(sf) === name,
            );
          const matches = prop('matches');
          if (!matches || !NETWORK_TARGET_RE.test(matches.initializer.getText(sf))) continue;
          const js = prop('js');
          if (!js) continue;
          const jsArr = unwrap(js.initializer);
          const elements = ts.isArrayLiteralExpression(jsArr) ? jsArr.elements : [jsArr];
          for (const el of elements) {
            const resolved = resolveScriptReference(sf, file, unwrap(el));
            if (resolved) found.add(resolved);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return [...found];
}

/** Resolve a `js: [x]` entry to a source file: a string literal relative to the
 * extension root, or an identifier whose import specifier names one (crxjs's
 * `./content/foo.ts?script`). */
function resolveScriptReference(
  sf: ts.SourceFile,
  file: string,
  expr: ts.Expression,
): string | null {
  const fromSpecifier = (spec: string): string | null => {
    const clean = spec.replace(/\?(script|iife|worker).*$/, '');
    const candidate = path.resolve(path.dirname(file), clean);
    for (const p of [candidate, `${candidate}.ts`, candidate.replace(/\.js$/, '.ts')]) {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    }
    return null;
  };
  if (ts.isStringLiteral(expr)) return fromSpecifier(expr.text);
  if (!ts.isIdentifier(expr)) return null;
  let resolved: string | null = null;
  ts.forEachChild(sf, (node) => {
    if (resolved || !ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) {
      return;
    }
    const clause = node.importClause;
    const namedHere =
      clause?.name?.text === expr.text ||
      (clause?.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.some((e) => e.name.text === expr.text));
    if (namedHere) resolved = fromSpecifier(node.moduleSpecifier.text);
  });
  return resolved;
}

export async function checkContentScriptStorageReads(
  manifestPath: string,
  sourceRoot?: string,
): Promise<Violation[]> {
  const violations: Violation[] = [];
  const root = sourceRoot ?? path.join(path.dirname(manifestPath), 'src');
  const files = await linkedinContentScriptFiles(manifestPath, root);

  // The net under the derivation above. A file whose own name says LinkedIn but
  // which neither the manifest nor a dynamic registration accounts for is not a
  // file this rule may pass over in silence: either it reaches linkedin.com by a
  // third route nobody has told this checker about, or it is dead code claiming
  // to be a content script. Both are worth a red build, and the alternative is
  // the hole #348 walked into - a scan set that quietly went empty.
  if (fs.existsSync(root)) {
    const accounted = new Set(files.map((f) => path.resolve(f)));
    for (const file of walkFiles(path.join(root, 'content'), ['.ts'])) {
      if (!/linkedin/i.test(path.basename(file))) continue;
      if (path.basename(file) === 'linkedin-dom.ts') continue; // selectors, not a script
      if (accounted.has(path.resolve(file))) continue;
      violations.push(
        makeViolation(
          2,
          file,
          `looks like a LinkedIn content script but is neither in manifest.config.ts's content_scripts nor registered by a chrome.scripting.registerContentScripts call this checker can see, so rule 2 would never scan it`,
        ),
      );
    }
  }

  for (const file of files) {
    if (!fs.existsSync(file)) {
      violations.push(
        makeViolation(
          2,
          file,
          `is registered in manifest.config.ts as a LinkedIn content script but does not exist on disk`,
        ),
      );
      continue;
    }
    const sf = parseSource(file);
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node)) {
        const chain = node.getText(sf);
        if (/\bdocument\s*\.\s*cookie\b/.test(chain)) {
          violations.push(makeViolation(2, file, `reads document.cookie (${trim(chain)})`));
        } else if (/\bchrome\s*\.\s*cookies\b/.test(chain)) {
          violations.push(makeViolation(2, file, `uses chrome.cookies (${trim(chain)})`));
        } else if (
          // `localStorage.getItem('li_at')` is the form this violation actually
          // takes, and it used to fall through every branch: the identifier
          // check below skips anything whose parent is a property access, and
          // the two patterns above only name cookies. A rule that catches a
          // bare `localStorage` but not `localStorage.getItem` catches the
          // spelling nobody writes.
          ts.isIdentifier(node.expression) &&
          (node.expression.text === 'localStorage' || node.expression.text === 'sessionStorage')
        ) {
          violations.push(makeViolation(2, file, `reads ${node.expression.text} (${trim(chain)})`));
        }
      } else if (ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node.parent)) {
        if (node.text === 'localStorage' || node.text === 'sessionStorage') {
          violations.push(makeViolation(2, file, `reads ${node.text}`));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Rule 3: no .click()/.submit()/dispatchEvent(click|submit) on a node
// obtained from extension/src/content/shared/linkedin-dom.ts.
// ---------------------------------------------------------------------------
function tracesToAccessor(
  expr: ts.Expression,
  accessorNames: Set<string>,
  tainted: Set<string>,
): boolean {
  let cur = unwrap(expr);
  while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
    cur = unwrap(cur.expression);
  }
  if (ts.isCallExpression(cur)) {
    const callee = unwrap(cur.expression);
    return ts.isIdentifier(callee) && accessorNames.has(callee.text);
  }
  if (ts.isIdentifier(cur)) return tainted.has(cur.text);
  return false;
}

function importedLocalNames(
  sf: ts.SourceFile,
  file: string,
  targetModulePath: string,
): Set<string> {
  const names = new Set<string>();
  const targetResolved = path.resolve(targetModulePath);
  ts.forEachChild(sf, (node) => {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier) ||
      !node.importClause
    )
      return;
    const resolved = resolveModuleFile(file, node.moduleSpecifier.text);
    if (!resolved || path.resolve(resolved) !== targetResolved) return;
    const nb = node.importClause.namedBindings;
    if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) names.add(el.name.text);
    if (nb && ts.isNamespaceImport(nb)) names.add(nb.name.text);
    if (node.importClause.name) names.add(node.importClause.name.text);
  });
  return names;
}

function collectTaintedVariables(sf: ts.SourceFile, accessorNames: Set<string>): Set<string> {
  const tainted = new Set<string>();
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        !tainted.has(node.name.text) &&
        tracesToAccessor(node.initializer, accessorNames, tainted)
      ) {
        tainted.add(node.name.text);
        changed = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (!changed) break;
  }
  return tainted;
}

export function checkSyntheticInteractions(scanDir: string, domModulePath: string): Violation[] {
  const violations: Violation[] = [];
  const domResolved = path.resolve(domModulePath);
  for (const file of walkFiles(scanDir, ['.ts', '.svelte'])) {
    if (path.resolve(file) === domResolved) continue; // #303 already covers the module itself
    const sf = parseSource(file);
    const accessorNames = importedLocalNames(sf, file, domModulePath);
    if (accessorNames.size === 0) continue;
    const tainted = collectTaintedVariables(sf, accessorNames);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const callee = node.expression;
        const method = callee.name.text;
        if (
          CLICK_SUBMIT_METHODS[method] &&
          tracesToAccessor(callee.expression, accessorNames, tainted)
        ) {
          violations.push(
            makeViolation(3, file, `calls .${method}() on a node obtained from linkedin-dom.ts`),
          );
        } else if (method === 'dispatchEvent') {
          const arg0 = node.arguments[0];
          const argText = arg0 ? arg0.getText(sf) : '';
          if (
            CLICK_OR_SUBMIT_RE.test(argText) &&
            tracesToAccessor(callee.expression, accessorNames, tainted)
          ) {
            violations.push(
              makeViolation(
                3,
                file,
                `calls dispatchEvent(${trim(argText)}) (a click/submit) on a node obtained from linkedin-dom.ts`,
              ),
            );
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Rule 4: no chrome.alarms handler reachable from a LinkedIn code path.
// ---------------------------------------------------------------------------
type ImportInfo = { file: string | null; exportedName: string };
type ModuleInfo = {
  file: string;
  sf: ts.SourceFile;
  functions: Map<string, ts.Node>;
  imports: Map<string, ImportInfo>;
};

function buildModuleInfo(file: string): ModuleInfo {
  const sf = parseSource(file);
  const functions = new Map<string, ts.Node>();
  const imports = new Map<string, ImportInfo>();
  ts.forEachChild(sf, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      functions.set(node.name.text, node);
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const init = unwrap(decl.initializer);
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
          functions.set(decl.name.text, init);
      }
    } else if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.importClause
    ) {
      const resolved = resolveModuleFile(file, node.moduleSpecifier.text);
      const nb = node.importClause.namedBindings;
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          const exportedName = (el.propertyName ?? el.name).text;
          imports.set(el.name.text, { file: resolved, exportedName });
        }
      }
      if (nb && ts.isNamespaceImport(nb))
        imports.set(nb.name.text, { file: resolved, exportedName: '*' });
      if (node.importClause.name)
        imports.set(node.importClause.name.text, { file: resolved, exportedName: 'default' });
    }
  });
  return { file, sf, functions, imports };
}

function collectCalledNames(
  unit: ts.Node,
): Array<{ kind: 'id'; name: string } | { kind: 'prop'; obj: string; prop: string }> {
  const calls: Array<{ kind: 'id'; name: string } | { kind: 'prop'; obj: string; prop: string }> =
    [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isIdentifier(callee)) {
        calls.push({ kind: 'id', name: callee.text });
      } else if (ts.isPropertyAccessExpression(callee)) {
        const obj = unwrap(callee.expression);
        if (ts.isIdentifier(obj))
          calls.push({ kind: 'prop', obj: obj.text, prop: callee.name.text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(unit);
  return calls;
}

/** BFS over the call graph reachable from `start`, resolving only relative
 * (project-local) imports. Returns the first file whose path mentions
 * "linkedin" that the graph reaches, or null if none does. */
function bfsReachesLinkedinFile(
  start: { file: string; node: ts.Node },
  infoCache: Map<string, ModuleInfo>,
): string | null {
  const getInfo = (file: string): ModuleInfo => {
    const key = path.resolve(file);
    let info = infoCache.get(key);
    if (!info) {
      info = buildModuleInfo(file);
      infoCache.set(key, info);
    }
    return info;
  };
  const visited = new Set<string>();
  const queue: Array<{ file: string; node: ts.Node }> = [start];
  let steps = 0;
  while (queue.length > 0 && steps < 1000) {
    steps++;
    const { file, node } = queue.shift()!;
    if (/linkedin/i.test(file)) return file;
    const nodeKey = ts.isSourceFile(node) ? 'sf' : `${node.pos}:${node.end}`;
    const key = `${path.resolve(file)}::${nodeKey}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const info = getInfo(file);
    for (const call of collectCalledNames(node)) {
      if (call.kind === 'id') {
        const local = info.functions.get(call.name);
        if (local) {
          queue.push({ file, node: local });
          continue;
        }
        const imp = info.imports.get(call.name);
        if (imp?.file) {
          if (/linkedin/i.test(imp.file)) return imp.file;
          const targetInfo = getInfo(imp.file);
          const fn =
            imp.exportedName !== '*' ? targetInfo.functions.get(imp.exportedName) : undefined;
          queue.push({ file: imp.file, node: fn ?? targetInfo.sf });
        }
      } else {
        const imp = info.imports.get(call.obj);
        if (imp?.file) {
          if (/linkedin/i.test(imp.file)) return imp.file;
          const targetInfo = getInfo(imp.file);
          const fn = targetInfo.functions.get(call.prop);
          queue.push({ file: imp.file, node: fn ?? targetInfo.sf });
        }
      }
    }
  }
  return null;
}

export function checkAlarmsReachability(scanDir: string): Violation[] {
  const violations: Violation[] = [];
  const infoCache = new Map<string, ModuleInfo>();
  for (const file of walkFiles(scanDir, ['.ts'])) {
    const info = ((): ModuleInfo => {
      const cached = buildModuleInfo(file);
      infoCache.set(path.resolve(file), cached);
      return cached;
    })();
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const callee = node.expression;
        if (
          callee.name.text === 'addListener' &&
          /\balarms\s*\.\s*onAlarm\b/.test(callee.getText(info.sf))
        ) {
          const handlerArg = node.arguments[0];
          let start: { file: string; node: ts.Node } | null = null;
          if (handlerArg) {
            const h = unwrap(handlerArg);
            if (ts.isArrowFunction(h) || ts.isFunctionExpression(h)) {
              start = { file, node: h };
            } else if (ts.isIdentifier(h)) {
              const local = info.functions.get(h.text);
              if (local) {
                start = { file, node: local };
              } else {
                const imp = info.imports.get(h.text);
                if (imp?.file) start = { file: imp.file, node: buildModuleInfo(imp.file).sf };
              }
            }
          }
          if (start) {
            const hit = bfsReachesLinkedinFile(start, infoCache);
            if (hit) {
              violations.push(
                makeViolation(
                  4,
                  file,
                  `registers a chrome.alarms.onAlarm handler whose call graph reaches LinkedIn code through ${path.relative(process.cwd(), hit)}`,
                ),
              );
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(info.sf);
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Rule 5: shared/src/platforms/linkedin/ is parsing and mapping only - no
// network call of any kind belongs there.
// ---------------------------------------------------------------------------
export function checkLinkedinPlatformNetworkCalls(platformDir: string): Violation[] {
  const violations: Violation[] = [];
  const NETWORK_IMPORT_RE = /^(node:)?(https?|undici)$/;
  for (const file of walkFiles(platformDir, ['.ts'])) {
    const sf = parseSource(file);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression);
        if (ts.isIdentifier(callee) && callee.text === 'fetch') {
          violations.push(
            makeViolation(
              5,
              file,
              `calls fetch(...) - this directory must stay parsing and mapping only`,
            ),
          );
        } else if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'sendBeacon') {
          violations.push(
            makeViolation(
              5,
              file,
              `calls navigator.sendBeacon(...) - this directory must stay parsing and mapping only`,
            ),
          );
        }
      } else if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'XMLHttpRequest'
      ) {
        violations.push(
          makeViolation(
            5,
            file,
            `constructs XMLHttpRequest - this directory must stay parsing and mapping only`,
          ),
        );
      } else if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        if (NETWORK_IMPORT_RE.test(node.moduleSpecifier.text)) {
          violations.push(
            makeViolation(
              5,
              file,
              `imports "${node.moduleSpecifier.text}" - this directory must stay parsing and mapping only`,
            ),
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Rule 6 (repo-level): `linkedin` must never appear in manifest.config.ts's
// host_permissions - it stays an optional, on-demand grant (#317).
// ---------------------------------------------------------------------------
export async function checkHostPermissions(manifestPath: string): Promise<Violation[]> {
  const manifest = await loadManifest(manifestPath);
  const violations: Violation[] = [];
  for (const entry of manifest.host_permissions ?? []) {
    if (NETWORK_TARGET_RE.test(entry)) {
      violations.push(
        makeViolation(
          6,
          manifestPath,
          `host_permissions includes "${entry}" - linkedin must stay an optional grant, never a blanket permission`,
        ),
      );
    }
  }
  return violations;
}

export type RepoPaths = {
  extensionSrcDir: string;
  manifestPath: string;
  linkedinDomPath: string;
  linkedinPlatformDir: string;
};

export function defaultRepoPaths(repoRoot: string): RepoPaths {
  return {
    extensionSrcDir: path.join(repoRoot, 'extension', 'src'),
    manifestPath: path.join(repoRoot, 'extension', 'manifest.config.ts'),
    linkedinDomPath: path.join(
      repoRoot,
      'extension',
      'src',
      'content',
      'shared',
      'linkedin-dom.ts',
    ),
    linkedinPlatformDir: path.join(repoRoot, 'shared', 'src', 'platforms', 'linkedin'),
  };
}

export async function checkAll(paths: RepoPaths): Promise<Violation[]> {
  return [
    ...checkNetworkTargets(paths.extensionSrcDir),
    ...(await checkContentScriptStorageReads(paths.manifestPath, paths.extensionSrcDir)),
    ...checkSyntheticInteractions(paths.extensionSrcDir, paths.linkedinDomPath),
    ...checkAlarmsReachability(paths.extensionSrcDir),
    ...checkLinkedinPlatformNetworkCalls(paths.linkedinPlatformDir),
    ...(await checkHostPermissions(paths.manifestPath)),
  ];
}
