import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const requiredPdfCommands = ['pdflatex', 'pdftoppm', 'pdfinfo', 'pdftotext'];
const requiredLatexPackages = [
  'titlesec',
  'marvosym',
  'enumitem',
  'hyperref',
  'fancyhdr',
  'tabularx',
  'lato',
  'fontawesome5',
];

function readRepositoryFile(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

function writeExecutable(filePath: string, contents: string): void {
  writeFileSync(filePath, contents, 'utf8');
  if (process.platform !== 'win32') chmodSync(filePath, 0o755);
}

describe('one-command setup scripts', () => {
  it.each(['scripts/setup.sh', 'scripts/setup.ps1'])(
    '%s verifies the PDF toolchain and project checks',
    (scriptPath) => {
      const script = readRepositoryFile(scriptPath);
      for (const command of requiredPdfCommands) {
        expect(script).toContain(command);
      }
      for (const latexPackage of requiredLatexPackages) {
        expect(script).toContain(latexPackage);
      }

      expect(script).toContain('pnpm');
      expect(script).toContain('typecheck');
      expect(script).toContain('test');
      expect(script).toContain('init-db');
      expect(script).toContain('LaTeX template dependency smoke test passed');
    },
  );

  it('pins one Corepack pnpm release and uses it on every platform', () => {
    const packageJson = JSON.parse(readRepositoryFile('package.json')) as { packageManager?: string };
    const linux = readRepositoryFile('scripts/setup.sh');
    const windows = readRepositoryFile('scripts/setup.ps1');

    expect(packageJson.packageManager).toMatch(/^pnpm@10\.15\.1\+sha512\.[a-f0-9]{128}$/);
    expect(linux).toContain("PNPM_VERSION='10.15.1'");
    expect(windows).toContain("$PinnedPnpmVersion = '10.15.1'");
    expect(linux).not.toContain('latest-10');
    expect(windows).not.toContain('latest-10');
  });

  it('uses a hash-locked Python virtual environment without modifying system Python', () => {
    const lock = readRepositoryFile('requirements-pdf.lock');
    const linux = readRepositoryFile('scripts/setup.sh');
    const windows = readRepositoryFile('scripts/setup.ps1');

    for (const requirement of ['PyMuPDF==', 'reportlab==', 'pdfplumber==', 'pypdf==']) {
      expect(lock).toContain(requirement);
    }
    expect(lock.match(/--hash=sha256:/g)?.length).toBeGreaterThan(100);
    for (const script of [linux, windows]) {
      expect(script).toContain('local/python-venv');
      expect(script).toContain('--require-hashes');
      expect(script).toContain('--only-binary=:all:');
      expect(script).not.toContain('--break-system-packages');
    }
  });

  it('repairs Windows WinGet paths and preinstalls MiKTeX template packages', () => {
    const script = readRepositoryFile('scripts/setup.ps1');

    expect(script).toContain('Resolve-PdfToolPaths');
    expect(script).toContain('MiKTeX.MiKTeX');
    expect(script).toContain('oschwartz10612.Poppler');
    expect(script).toContain("@('packages', 'require')");
    expect(script).toContain('Test-PythonPdfLibraries');
  });

  it('compiles a disposable template smoke-test document on Linux', () => {
    const script = readRepositoryFile('scripts/setup.sh');

    expect(script).toContain('mktemp -d');
    expect(script).toContain('smoke.tex');
    expect(script).toContain('-halt-on-error');
    expect(script).toContain('latex_template_packages_available');
    expect(script).toContain('kpsewhich');
  });

  it.runIf(process.platform === 'win32')('parses the Windows setup script with PowerShell', () => {
    const command = [
      "$tokens=$null;$errors=$null;",
      "[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path 'scripts/setup.ps1'),[ref]$tokens,[ref]$errors)|Out-Null;",
      "if($errors.Count){$errors|ForEach-Object{$_.Message};exit 1}",
    ].join(' ');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
      cwd: process.cwd(), encoding: 'utf8',
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it.runIf(process.platform === 'linux')('executes the Linux setup flow with controlled tool doubles', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'jobbot-setup-linux-'));
    const bin = path.join(root, 'bin');
    const log = path.join(root, 'commands.log');
    mkdirSync(bin);
    writeExecutable(path.join(bin, 'node'), '#!/usr/bin/env bash\necho v20.19.0\n');
    writeExecutable(path.join(bin, 'pnpm'), [
      '#!/usr/bin/env bash',
      'if [ "${1:-}" = "--version" ]; then echo 10.15.1; exit 0; fi',
      'printf "%s\\n" "$*" >> "$JOBBOT_SETUP_LOG"',
      '',
    ].join('\n'));
    writeExecutable(path.join(bin, 'kpsewhich'), '#!/usr/bin/env bash\necho "/fake/${1:-package}"\n');
    writeExecutable(path.join(bin, 'pdflatex'), [
      '#!/usr/bin/env bash',
      'if [ "${1:-}" = "--version" ]; then echo "pdfTeX test"; exit 0; fi',
      'for arg in "$@"; do case "$arg" in -output-directory=*) out="${arg#*=}" ;; esac; done',
      'mkdir -p "$out"',
      'touch "$out/smoke.pdf"',
      '',
    ].join('\n'));
    for (const command of ['pdftoppm', 'pdfinfo', 'pdftotext']) {
      writeExecutable(path.join(bin, command), `#!/usr/bin/env bash\necho "${command} test"\n`);
    }
    writeExecutable(path.join(bin, 'python3'), [
      '#!/usr/bin/env bash',
      'if [ "${1:-}" = "-m" ] && [ "${2:-}" = "venv" ] && [ "${3:-}" != "--help" ]; then',
      '  mkdir -p "$3/bin"',
      '  cp "$0" "$3/bin/python"',
      '  chmod +x "$3/bin/python"',
      'fi',
      '',
    ].join('\n'));

    try {
      const result = spawnSync('bash', [path.join(process.cwd(), 'scripts', 'setup.sh')], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`,
          JOBBOT_SETUP_LOG: log,
          JOBBOT_SETUP_PYTHON_VENV: path.join(root, 'python-venv'),
        },
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      const calls = readFileSync(log, 'utf8');
      expect(calls).toContain('install --frozen-lockfile');
      expect(calls).toContain('jobbot init-db');
      expect(calls).toContain('typecheck');
      expect(calls).toContain('test');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'win32')('executes the Windows setup flow with controlled tool doubles', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'jobbot-setup-windows-'));
    const bin = path.join(root, 'bin');
    const log = path.join(root, 'commands.log');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'node.cmd'), '@echo off\r\necho v20.19.0\r\n', 'utf8');
    writeFileSync(path.join(bin, 'pnpm.cmd'), [
      '@echo off',
      'if "%1"=="--version" (echo 10.15.1& exit /b 0)',
      'echo %*>>"%JOBBOT_SETUP_LOG%"',
      'exit /b 0',
      '',
    ].join('\r\n'), 'utf8');

    try {
      const result = spawnSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(process.cwd(), 'scripts', 'setup.ps1'), '-SkipSystemDependencies',
      ], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`,
          JOBBOT_SETUP_LOG: log,
        },
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      const calls = readFileSync(log, 'utf8');
      expect(calls).toContain('install --frozen-lockfile');
      expect(calls).toContain('jobbot init-db');
      expect(calls).toContain('typecheck');
      expect(calls).toContain('test');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
