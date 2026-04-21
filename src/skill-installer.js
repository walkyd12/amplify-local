import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Where the shipped skill files live inside this package. */
const SOURCE_DIR = resolve(__dirname, '..', 'skills');

/** Sentinel key in the YAML frontmatter tracking which amplify-local
 * version last installed the skill. Enables "is this file stale?" checks. */
const VERSION_KEY = 'amplify_local_version';

/**
 * Install the amplify-local Claude Code skill(s) into a target directory.
 *
 * @param {object} opts
 * @param {'project'|'user'} [opts.target='project']
 *   - 'project' → <cwd>/.claude/skills/
 *   - 'user'    → ~/.claude/skills/
 * @param {boolean} [opts.force=false]  Overwrite existing skill files.
 * @param {boolean} [opts.dryRun=false] Report what would be written, don't touch the fs.
 * @param {string}  [opts.version]      Stamp this version into the frontmatter.
 * @param {string}  [opts.sourceDir]    Source override (tests).
 * @param {string}  [opts.cwd]          CWD override (tests).
 * @returns {{ targetDir, installed: [{ name, path, wrote, reason }] }}
 */
export function installSkill(opts = {}) {
  const {
    target = 'project',
    force = false,
    dryRun = false,
    version,
    sourceDir = SOURCE_DIR,
    cwd = process.cwd(),
  } = opts;

  if (!existsSync(sourceDir)) {
    throw new Error(`amplify-local skill source not found: ${sourceDir}`);
  }

  const targetDir = target === 'user'
    ? join(homedir(), '.claude', 'skills')
    : join(cwd, '.claude', 'skills');

  const files = readdirSync(sourceDir).filter(
    (f) => f.endsWith('.md') && statSync(join(sourceDir, f)).isFile()
  );
  if (files.length === 0) {
    throw new Error(`No skill files under ${sourceDir}`);
  }

  if (!dryRun) {
    mkdirSync(targetDir, { recursive: true });
  }

  const installed = [];
  for (const name of files) {
    const srcPath = join(sourceDir, name);
    const dstPath = join(targetDir, name);

    const srcContent = readFileSync(srcPath, 'utf8');
    const stamped = version ? stampVersion(srcContent, version) : srcContent;

    let wrote = false;
    let reason = '';

    if (!existsSync(dstPath)) {
      wrote = true;
      reason = 'new';
    } else {
      const existing = readFileSync(dstPath, 'utf8');
      if (existing === stamped) {
        reason = 'unchanged';
      } else if (force) {
        wrote = true;
        reason = 'overwrote';
      } else {
        const existingVersion = readVersion(existing);
        if (version && existingVersion && existingVersion !== version) {
          reason = `out-of-date (existing=${existingVersion}, current=${version}) — re-run with --force to update`;
        } else {
          reason = 'exists — re-run with --force to overwrite';
        }
      }
    }

    if (wrote && !dryRun) {
      writeFileSync(dstPath, stamped, 'utf8');
    }

    installed.push({ name, path: dstPath, wrote, reason });
  }

  return { targetDir, installed };
}

/**
 * Add (or replace) a `amplify_local_version` line inside the YAML
 * frontmatter. Assumes the first `---`-delimited block is frontmatter;
 * creates one if the file has none.
 */
export function stampVersion(content, version) {
  const fmRegex = /^---\n([\s\S]*?)\n---\n/;
  const m = content.match(fmRegex);
  const line = `${VERSION_KEY}: ${version}`;

  if (!m) {
    return `---\n${line}\n---\n\n${content}`;
  }

  const fm = m[1];
  const stamped = fm.includes(`${VERSION_KEY}:`)
    ? fm.replace(new RegExp(`${VERSION_KEY}:.*`), line)
    : fm + '\n' + line;
  return content.replace(fmRegex, `---\n${stamped}\n---\n`);
}

/**
 * Extract the stamped amplify-local version from a skill file's frontmatter.
 * Returns null if none was recorded.
 */
export function readVersion(content) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) return null;
  const vMatch = fmMatch[1].match(new RegExp(`^${VERSION_KEY}:\\s*(.*)$`, 'm'));
  return vMatch ? vMatch[1].trim() : null;
}
