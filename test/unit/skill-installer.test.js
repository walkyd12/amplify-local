import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installSkill, stampVersion, readVersion } from '../../src/skill-installer.js';

let tmpCwd;
let tmpSource;

function seedSourceSkills(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'amplify-local.md'),
    '---\nname: amplify-local\ndescription: test\n---\n\nbody content\n'
  );
}

beforeEach(() => {
  tmpCwd = mkdtempSync(join(tmpdir(), 'amplify-local-skill-cwd-'));
  tmpSource = mkdtempSync(join(tmpdir(), 'amplify-local-skill-src-'));
  seedSourceSkills(tmpSource);
});

describe('installSkill — project target (default)', () => {
  it('creates .claude/skills/ under cwd and writes the file', () => {
    const r = installSkill({ cwd: tmpCwd, sourceDir: tmpSource, version: '1.2.3' });
    expect(r.targetDir).toBe(join(tmpCwd, '.claude', 'skills'));
    expect(r.installed).toHaveLength(1);
    expect(r.installed[0].wrote).toBe(true);
    expect(r.installed[0].reason).toBe('new');
    const written = readFileSync(join(r.targetDir, 'amplify-local.md'), 'utf8');
    expect(readVersion(written)).toBe('1.2.3');
  });

  it('skips when the file already exists and content matches', () => {
    installSkill({ cwd: tmpCwd, sourceDir: tmpSource, version: '1.2.3' });
    const second = installSkill({ cwd: tmpCwd, sourceDir: tmpSource, version: '1.2.3' });
    expect(second.installed[0].wrote).toBe(false);
    expect(second.installed[0].reason).toBe('unchanged');
  });

  it('skips but warns when a file exists with a different version and --force is off', () => {
    installSkill({ cwd: tmpCwd, sourceDir: tmpSource, version: '1.0.0' });
    const second = installSkill({ cwd: tmpCwd, sourceDir: tmpSource, version: '1.2.3' });
    expect(second.installed[0].wrote).toBe(false);
    expect(second.installed[0].reason).toMatch(/out-of-date.*existing=1\.0\.0.*current=1\.2\.3/);
  });

  it('overwrites when force=true', () => {
    installSkill({ cwd: tmpCwd, sourceDir: tmpSource, version: '1.0.0' });
    const r = installSkill({ cwd: tmpCwd, sourceDir: tmpSource, version: '2.0.0', force: true });
    expect(r.installed[0].wrote).toBe(true);
    expect(r.installed[0].reason).toBe('overwrote');
    const written = readFileSync(join(r.targetDir, 'amplify-local.md'), 'utf8');
    expect(readVersion(written)).toBe('2.0.0');
  });

  it('dry-run reports writes but changes nothing on disk', () => {
    const r = installSkill({ cwd: tmpCwd, sourceDir: tmpSource, version: '1.0.0', dryRun: true });
    expect(r.installed[0].wrote).toBe(true);
    expect(existsSync(join(r.targetDir, 'amplify-local.md'))).toBe(false);
  });
});

describe('installSkill — user target', () => {
  it('routes to the user home directory', () => {
    // Simulate by shadowing HOME so the real home dir stays untouched.
    const fakeHome = mkdtempSync(join(tmpdir(), 'amplify-local-skill-home-'));
    const origHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const r = installSkill({ target: 'user', sourceDir: tmpSource, version: '1.0.0' });
      expect(r.targetDir).toBe(join(fakeHome, '.claude', 'skills'));
      expect(existsSync(join(r.targetDir, 'amplify-local.md'))).toBe(true);
    } finally {
      process.env.HOME = origHome;
    }
  });
});

describe('installSkill — error cases', () => {
  it('throws when the source dir is missing', () => {
    expect(() =>
      installSkill({ cwd: tmpCwd, sourceDir: '/does/not/exist', version: '1.0.0' })
    ).toThrow(/skill source not found/);
  });

  it('throws when the source dir has no markdown files', () => {
    const empty = mkdtempSync(join(tmpdir(), 'amplify-local-skill-empty-'));
    expect(() =>
      installSkill({ cwd: tmpCwd, sourceDir: empty, version: '1.0.0' })
    ).toThrow(/No skill files/);
  });
});

describe('stampVersion / readVersion', () => {
  it('stamps a fresh frontmatter entry', () => {
    const out = stampVersion('---\nname: x\n---\nbody\n', '9.9.9');
    expect(out).toMatch(/amplify_local_version: 9\.9\.9/);
    expect(readVersion(out)).toBe('9.9.9');
  });

  it('replaces an existing stamped version', () => {
    const orig = '---\nname: x\namplify_local_version: 1.0.0\n---\nbody\n';
    const out = stampVersion(orig, '2.0.0');
    expect(readVersion(out)).toBe('2.0.0');
    // and doesn't duplicate the key
    expect((out.match(/amplify_local_version:/g) || []).length).toBe(1);
  });

  it('creates frontmatter when the file has none', () => {
    const out = stampVersion('bare body\n', '3.0.0');
    expect(out.startsWith('---\namplify_local_version: 3.0.0\n---\n')).toBe(true);
    expect(readVersion(out)).toBe('3.0.0');
  });

  it('readVersion returns null when no stamp exists', () => {
    expect(readVersion('---\nname: x\n---\nbody\n')).toBeNull();
    expect(readVersion('plain body, no frontmatter')).toBeNull();
  });
});
