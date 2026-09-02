import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const requiredPdfCommands = ['pdflatex', 'pdftoppm', 'pdfinfo', 'pdftotext'];
const requiredLatexPackages = [
  'titlesec', 'marvosym', 'enumitem', 'hyperref', 'fancyhdr',
  'tabularx', 'lato', 'fontawesome5',
];

function repositoryPath(relativePath: string): string {
  return new URL(`../${relativePath}`, import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1');
}

function readRepositoryFile(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

function writeExecutable(filePath: string, contents: string): void {
  writeFileSync(filePath, contents, 'utf8');
  if (process.platform !== 'win32') chmodSync(filePath, 0o755);
}

describe('one-command setup scripts', () => {
  it.each(['scripts/setup.sh', 'scripts/setup.ps1'])(
    '%s verifies the real PDF toolchain and project checks',
    (scriptPath) => {
      const script = readRepositoryFile(scriptPath);
      for (const command of requiredPdfCommands) expect(script).toContain(command);
      for (const latexPackage of requiredLatexPackages) expect(script).toContain(latexPackage);
      for (const command of ['typecheck', 'test', 'init-db']) expect(script).toContain(command);
      expect(script).toContain('LaTeX template dependency smoke test passed');
    },
  );

  it('uses the pinned pnpm through Corepack without installing global shims', () => {
    const packageJson = JSON.parse(readRepositoryFile('package.json')) as { packageManager?: string };
    const scripts = [readRepositoryFile('scripts/setup.sh'), readRepositoryFile('scripts/setup.ps1')];
    expect(packageJson.packageManager).toMatch(/^pnpm@10\.15\.1\+sha512\.[a-f0-9]{128}$/);
    for (const script of scripts) {
      expect(script).toContain('10.15.1');
      expect(script).toContain('corepack');
      expect(script).not.toContain('corepack enable');
      expect(script).not.toContain('corepack prepare');
    }
  });

  it('does not install unused Python PDF packages', () => {
    const contents = [
      readRepositoryFile('scripts/setup.sh'), readRepositoryFile('scripts/setup.ps1'),
      readRepositoryFile('README.md'), readRepositoryFile('README_zh.md'),
    ].join('\n');
    for (const unused of [
      'requirements-pdf.lock', 'python-venv', 'python3-venv',
      'PyMuPDF', 'reportlab', 'pdfplumber', 'pypdf', '--break-system-packages',
    ]) expect(contents).not.toContain(unused);
    expect(existsSync(repositoryPath('requirements-pdf.lock'))).toBe(false);
  });

  it('repairs Windows WinGet paths and preinstalls MiKTeX template packages', () => {
    const script = readRepositoryFile('scripts/setup.ps1');
    expect(script).toContain('Resolve-PdfToolPaths');
    expect(script).toContain('MiKTeX.MiKTeX');
    expect(script).toContain('oschwartz10612.Poppler');
    expect(script).toContain("@('packages', 'require')");
  });

  it('compiles a disposable template smoke-test document on Linux', () => {
    const script = readRepositoryFile('scripts/setup.sh');
    for (const marker of ['mktemp -d', 'smoke.tex', '-halt-on-error', 'kpsewhich']) {
      expect(script).toContain(marker);
    }
  });

  it.runIf(process.platform === 'win32')('parses the Windows setup script with PowerShell', () => {
    const command = [
      '$tokens=$null;$errors=$null;',
      "[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path 'scripts/setup.ps1'),[ref]$tokens,[ref]$errors)|Out-Null;",
      'if($errors.Count){$errors|ForEach-Object{$_.Message};exit 1}',
    ].join(' ');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
      cwd: process.cwd(), encoding: 'utf8',
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it.runIf(process.platform === 'linux')(
    'executes Linux setup and its printed UI command without a system pnpm shim',
    () => {
      const root = mkdtempSync(path.join(tmpdir(), 'jobbot-setup-linux-'));
      const bin = path.join(root, 'bin');
      const log = path.join(root, 'commands.log');
      mkdirSync(bin);
      writeExecutable(path.join(bin, 'node'), '#!/usr/bin/env bash\necho v20.19.0\n');
      writeExecutable(path.join(bin, 'corepack'), [
        '#!/usr/bin/env bash',
        'if [ "${1:-}" = "pnpm" ] && [ "${2:-}" = "--version" ]; then echo 10.15.1; exit 0; fi',
        'printf "corepack %s\\n" "$*" >> "$JOBBOT_SETUP_LOG"',
        '',
      ].join('\n'));
      writeExecutable(path.join(bin, 'kpsewhich'), '#!/usr/bin/env bash\nexit 1\n');
      writeExecutable(path.join(bin, 'id'), '#!/usr/bin/env bash\necho 1000\n');
      writeExecutable(path.join(bin, 'sudo'), '#!/usr/bin/env bash\nprintf "sudo %s\\n" "$*" >> "$JOBBOT_SETUP_LOG"\n');
      writeExecutable(path.join(bin, 'pdflatex'), [
        '#!/usr/bin/env bash',
        'if [ "${1:-}" = "--version" ]; then echo "pdfTeX test"; exit 0; fi',
        'for arg in "$@"; do case "$arg" in -output-directory=*) out="${arg#*=}" ;; esac; done',
        'mkdir -p "$out"; touch "$out/smoke.pdf"',
        '',
      ].join('\n'));
      for (const command of ['pdftoppm', 'pdfinfo', 'pdftotext']) {
        writeExecutable(path.join(bin, command), `#!/usr/bin/env bash\necho "${command} test"\n`);
      }

      try {
        const result = spawnSync('bash', [path.join(process.cwd(), 'scripts', 'setup.sh')], {
          cwd: root,
          encoding: 'utf8',
          env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, JOBBOT_SETUP_LOG: log },
        });
        expect(result.status, result.stderr || result.stdout).toBe(0);
        expect(result.stdout).toContain('Start the UI:  corepack pnpm jobbot ui');
        const calls = readFileSync(log, 'utf8');
        for (const call of [
          'corepack pnpm install --frozen-lockfile', 'corepack pnpm jobbot init-db',
          'corepack pnpm typecheck', 'corepack pnpm test',
        ]) expect(calls).toContain(call);
        expect(calls).not.toContain('enable');
        expect(calls).not.toContain('prepare');

        const ui = spawnSync(path.join(bin, 'corepack'), ['pnpm', 'jobbot', 'ui'], {
          env: { ...process.env, JOBBOT_SETUP_LOG: log }, encoding: 'utf8',
        });
        expect(ui.status).toBe(0);
        expect(readFileSync(log, 'utf8')).toContain('corepack pnpm jobbot ui');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === 'linux')('cleans the Linux LaTeX smoke directory after failure', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'jobbot-setup-linux-failure-'));
    const bin = path.join(root, 'bin');
    const smokeParent = path.join(root, 'smoke');
    mkdirSync(bin); mkdirSync(smokeParent);
    writeExecutable(path.join(bin, 'node'), '#!/usr/bin/env bash\necho v20.19.0\n');
    writeExecutable(path.join(bin, 'corepack'), '#!/usr/bin/env bash\nif [ "$1" = pnpm ] && [ "$2" = --version ]; then echo 10.15.1; fi\n');
    writeExecutable(path.join(bin, 'kpsewhich'), '#!/usr/bin/env bash\necho "/fake/${1:-package}"\n');
    writeExecutable(path.join(bin, 'pdflatex'), '#!/usr/bin/env bash\nif [ "$1" = --version ]; then echo pdfTeX; exit 0; fi\nexit 7\n');
    for (const command of ['pdftoppm', 'pdfinfo', 'pdftotext']) {
      writeExecutable(path.join(bin, command), `#!/usr/bin/env bash\necho "${command} test"\n`);
    }
    try {
      const result = spawnSync('bash', [path.join(process.cwd(), 'scripts', 'setup.sh')], {
        cwd: root, encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: smokeParent },
      });
      expect(result.status).not.toBe(0);
      expect(readdirSync(smokeParent)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'win32')(
    'executes Windows setup through Corepack with no pnpm command installed',
    () => {
      const root = mkdtempSync(path.join(tmpdir(), 'jobbot-setup-windows-'));
      const bin = path.join(root, 'bin');
      const log = path.join(root, 'commands.log');
      mkdirSync(bin);
      writeFileSync(path.join(bin, 'node.cmd'), '@echo off\r\necho v20.19.0\r\n', 'utf8');
      writeFileSync(path.join(bin, 'corepack.cmd'), [
        '@echo off',
        'if "%1 %2"=="pnpm --version" (echo 10.15.1& exit /b 0)',
        'echo corepack %*>>"%JOBBOT_SETUP_LOG%"',
        'exit /b 0',
        '',
      ].join('\r\n'), 'utf8');
      const windowsSystemPath = [
        process.env['SystemRoot'] ? path.join(process.env['SystemRoot'], 'System32') : '',
        process.env['SystemRoot'] ?? '',
      ].filter(Boolean).join(path.delimiter);
      try {
        const powershell = path.join(
          process.env['SystemRoot'] ?? 'C:\\Windows',
          'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
        );
        const result = spawnSync(powershell, [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
          path.join(process.cwd(), 'scripts', 'setup.ps1'), '-SkipSystemDependencies',
        ], {
          cwd: root, encoding: 'utf8',
          env: {
            ...process.env, PATH: `${bin}${path.delimiter}${windowsSystemPath}`,
            JOBBOT_SETUP_LOG: log,
          },
        });
        expect(result.status, result.stderr || result.stdout).toBe(0);
        expect(result.stdout).toContain('Start the UI:  corepack pnpm jobbot ui');
        const calls = readFileSync(log, 'utf8');
        for (const call of [
          'corepack pnpm install --frozen-lockfile', 'corepack pnpm jobbot init-db',
          'corepack pnpm typecheck', 'corepack pnpm test',
        ]) expect(calls).toContain(call);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
