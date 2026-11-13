// Watchtower core: looks at what a release changes compared with the previous version and
// says whether a watcher should flag it during the public window. No Node APIs, so the CLI
// and the dashboard run exactly the same rules.
//
// The rules are plain and deterministic. They only look at what is NEW in this version,
// because a package that always spawned processes is not suspicious.

const utf8 = (bytes) => new TextDecoder('utf-8').decode(bytes);

const SEVERITY = { low: 1, medium: 2, high: 3 };
const LIFECYCLE = ['preinstall', 'install', 'postinstall'];
const CODE_FILE = /\.(c?js|mjs|ts|json|sh|bat|ps1|cmd|py)$/i;
const MAX_FILE = 512 * 1024;

const CODE_RULES = [
  { id: 'process-exec', severity: 'medium', re: /child_process|\b(?:execSync|spawnSync|execFileSync)\b|\bspawn\s*\(|\bexec\s*\(/, what: 'starts other programs' },
  { id: 'network', severity: 'medium', re: /require\(\s*['"](?:node:)?(?:https?|net|dns|dgram|tls)['"]\s*\)|from\s+['"](?:node:)?(?:https?|net|dns|dgram|tls)['"]|\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket/, what: 'talks to the network' },
  { id: 'dynamic-eval', severity: 'medium', re: /\beval\s*\(|new\s+Function\s*\(|\bvm\.runIn/, what: 'runs code built at runtime' },
  { id: 'secret-access', severity: 'high', re: /\.npmrc|\.ssh\b|id_rsa|\.aws[\\/]credentials|wallet\.dat|keystore|process\.env\.(?:NPM_TOKEN|GITHUB_TOKEN|GH_TOKEN|AWS_[A-Z_]+|NODE_AUTH_TOKEN)/, what: 'reads credentials or wallet files' },
  { id: 'obfuscation', severity: 'medium', re: /(?:\\x[0-9a-fA-F]{2}){20,}|['"][A-Za-z0-9+/=]{400,}['"]/, what: 'contains an encoded or obfuscated blob' },
];

function packageJson(files) {
  const f = files.find((x) => x.path === 'package.json');
  if (!f) return {};
  try {
    return JSON.parse(utf8(f.content));
  } catch {
    return {};
  }
}

function codeText(files) {
  return files
    .filter((f) => CODE_FILE.test(f.path) && f.content.length <= MAX_FILE)
    .map((f) => ({ path: f.path, text: utf8(f.content) }));
}

function firstMatch(sources, re) {
  for (const s of sources) {
    const m = re.exec(s.text);
    if (m) {
      const line = s.text.slice(0, m.index).split('\n').length;
      const lines = s.text.split('\n');
      return { path: s.path, line, snippet: lines[line - 1].trim().slice(0, 200) };
    }
  }
  return null;
}

const present = (sources, re) => sources.some((s) => re.test(s.text));

/**
 * Compare a new tarball with the previous one (or null for a first release).
 * Returns { verdict: 'flag' | 'review' | 'ok', findings: [...], baseline: boolean }.
 */
export function analyzeFiles(next, prev = null) {
  const baseline = Boolean(prev);
  const findings = [];
  const add = (severity, rule, detail, where) => findings.push({ severity, rule, detail, ...(where || {}) });

  const pn = packageJson(next);
  const pp = prev ? packageJson(prev) : {};

  // Lifecycle scripts run on every install.
  for (const hook of LIFECYCLE) {
    const now = pn.scripts?.[hook];
    if (!now) continue;
    const before = pp.scripts?.[hook];
    if (before === now) continue;
    const download = /\b(curl|wget|powershell|iwr|Invoke-WebRequest)\b|node\s+-e|base64|\|\s*(ba)?sh\b/i.test(now);
    const sev = download ? 'high' : baseline ? 'high' : 'medium';
    add(sev, 'lifecycle-script', `${before ? 'changes' : 'adds'} the ${hook} script: ${now.slice(0, 160)}`, { path: 'package.json' });
  }

  // Dependencies.
  const depsOf = (p) => ({ ...(p.dependencies || {}), ...(p.optionalDependencies || {}) });
  const nowDeps = depsOf(pn);
  const oldDeps = depsOf(pp);
  for (const [name, spec] of Object.entries(nowDeps)) {
    if (nowDeps[name] === oldDeps[name]) continue;
    if (/^(git\+|git:|https?:|github:|file:)/.test(String(spec))) {
      add('high', 'dependency-url', `depends on ${name} from a URL: ${String(spec).slice(0, 120)}`, { path: 'package.json' });
    } else if (baseline && !(name in oldDeps)) {
      add('low', 'new-dependency', `adds the dependency ${name}`, { path: 'package.json' });
    }
  }

  // Code that appears in this version and was absent from the last one.
  const nowCode = codeText(next);
  const oldCode = prev ? codeText(prev) : [];
  const appeared = new Set();
  for (const rule of CODE_RULES) {
    if (!present(nowCode, rule.re)) continue;
    if (baseline && present(oldCode, rule.re)) continue;
    appeared.add(rule.id);
    const where = firstMatch(nowCode, rule.re);
    // With no earlier version to compare, code alone is only a hint.
    const severity = baseline ? rule.severity : rule.severity === 'high' ? 'medium' : 'low';
    add(severity, rule.id, `${baseline ? 'now ' : ''}${rule.what}`, where || undefined);
  }
  if (appeared.has('secret-access') && appeared.has('network')) {
    add('high', 'exfiltration-shape', 'reads credentials and talks to the network in the same release');
  }

  // New files that run: bin entries and shell scripts.
  if (prev) {
    const had = new Set(prev.map((f) => f.path));
    const added = next.filter((f) => !had.has(f.path));
    const exec = added.filter((f) => /\.(sh|bat|ps1|cmd)$/i.test(f.path) || (f.mode & 0o111) !== 0);
    if (exec.length) add('medium', 'new-executable', `adds executable files: ${exec.slice(0, 5).map((f) => f.path).join(', ')}`);
    const oldSize = prev.reduce((n, f) => n + f.content.length, 0) || 1;
    const newSize = next.reduce((n, f) => n + f.content.length, 0);
    if (newSize > oldSize * 4 && newSize - oldSize > 100 * 1024) add('low', 'size-jump', `grows from ${oldSize} to ${newSize} bytes`);
  }

  const top = Math.max(0, ...findings.map((f) => SEVERITY[f.severity]));
  const verdict = top >= SEVERITY.high ? 'flag' : top >= SEVERITY.medium ? 'review' : 'ok';
  return { verdict, findings, baseline };
}

/** One text a flag can carry (the contract allows up to 500 characters). */
export function flagReason(report, limit = 480) {
  const high = report.findings.filter((f) => f.severity === 'high');
  const parts = (high.length ? high : report.findings).map((f) => `${f.rule}: ${f.detail}`);
  let out = `Watchtower: ${parts.join('; ')}`;
  if (out.length > limit) out = out.slice(0, limit - 3) + '...';
  return out;
}

export function describeReport(report) {
  if (!report.findings.length) return `verdict ${report.verdict}: no new risky behaviour found${report.baseline ? '' : ' (no earlier version to compare with)'}`;
  const lines = [`verdict ${report.verdict}${report.baseline ? '' : ' (no earlier version to compare with)'}`];
  for (const f of report.findings) {
    lines.push(`  ${f.severity.padEnd(6)} ${f.rule}: ${f.detail}${f.path ? `  [${f.path}${f.line ? ':' + f.line : ''}]` : ''}`);
  }
  return lines.join('\n');
}

