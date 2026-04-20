import express from 'express';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync, readdirSync } from 'fs';
import { join, dirname, extname, relative } from 'path';
import { createAuthMiddleware } from '../../auth/middleware.js';
import { checkStorageAccess } from './policy.js';

/**
 * MIME type lookup from file extension.
 */
const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.csv': 'text/csv',
};

function guessMimeType(filePath) {
  const ext = extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * Recursively list all files under a directory, relative to the base.
 */
function listFilesRecursive(dir, base, prefix = '') {
  const results = [];
  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.endsWith('.__meta__')) continue;
    const fullPath = join(dir, entry.name);
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(fullPath, base, relPath));
    } else {
      const stat = statSync(fullPath);
      results.push({
        key: relPath,
        size: stat.size,
        lastModified: stat.mtime.toISOString(),
      });
    }
  }
  return results;
}

/**
 * Build S3 ListObjectsV2-compatible XML response.
 */
function buildListXml(bucketName, prefix, files, maxKeys) {
  const truncated = files.length > maxKeys;
  const items = files.slice(0, maxKeys);

  const contents = items
    .map(
      (f) => `  <Contents>
    <Key>${escapeXml(f.key)}</Key>
    <LastModified>${f.lastModified}</LastModified>
    <Size>${f.size}</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${escapeXml(bucketName)}</Name>
  <Prefix>${escapeXml(prefix || '')}</Prefix>
  <MaxKeys>${maxKeys}</MaxKeys>
  <IsTruncated>${truncated}</IsTruncated>
  <KeyCount>${items.length}</KeyCount>
${contents}
</ListBucketResult>`;
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Create an Express app serving an S3-compatible storage API backed by the local filesystem.
 *
 * Routes:
 *   PUT    /:bucket/* → write file
 *   GET    /:bucket/* → read file (or list if ?prefix= query param on bucket root)
 *   DELETE /:bucket/* → delete file
 *   HEAD   /:bucket/* → check existence + metadata
 *   GET    /:bucket?prefix=&max-keys= → list objects
 *
 * @param {object} config - Merged config object
 * @param {string} [apiKey] - API key for auth middleware
 * @returns {express.Express}
 */
export function createStorageServer(config, apiKey) {
  const app = express();
  const storageDir = config.storageDir;
  const storageConfig = config.storageConfig || null;

  // Ensure storage directory exists
  mkdirSync(storageDir, { recursive: true });

  // CORS for local dev
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, x-amz-content-sha256, x-amz-date');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, ETag, x-amz-request-id');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (_req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });

  // Auth middleware (if apiKey provided)
  if (apiKey) {
    app.use(createAuthMiddleware(apiKey));
  }

  // Raw body parser for file uploads
  app.use(express.raw({ type: '*/*', limit: '50mb' }));

  // LIST objects — GET /:bucket with query params
  app.get('/:bucket', (req, res) => {
    const prefix = req.query.prefix || '';
    const maxKeys = parseInt(req.query['max-keys'] || '1000', 10);
    const bucket = req.params.bucket;

    // Check access
    if (storageConfig && apiKey) {
      const access = checkStorageAccess(prefix || '*', 'list', req.authContext, storageConfig);
      if (!access.allowed) {
        return res.status(403).type('xml').send(
          `<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>${access.reason}</Message></Error>`
        );
      }
    }

    const baseDir = join(storageDir, bucket);
    const searchDir = prefix ? join(baseDir, prefix) : baseDir;

    // If prefix points to a specific directory, list inside it
    // Otherwise list from base and filter by prefix
    let files;
    if (prefix && existsSync(searchDir) && statSync(searchDir).isDirectory()) {
      files = listFilesRecursive(searchDir, baseDir, prefix);
    } else if (prefix) {
      // Filter files whose key starts with the prefix
      files = listFilesRecursive(baseDir, baseDir).filter((f) => f.key.startsWith(prefix));
    } else {
      files = listFilesRecursive(baseDir, baseDir);
    }

    res.type('application/xml').send(buildListXml(bucket, prefix, files, maxKeys));
  });

  // PUT — write file
  app.put('/:bucket/*splat', (req, res) => {
    const bucket = req.params.bucket;
    const key = req.params.splat.join('/');

    // Check access
    if (storageConfig && apiKey) {
      const access = checkStorageAccess(key, 'write', req.authContext, storageConfig);
      if (!access.allowed) {
        return res.status(403).type('xml').send(
          `<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>${access.reason}</Message></Error>`
        );
      }
    }

    const filePath = join(storageDir, bucket, key);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, req.body);

    // Store content-type as a sidecar metadata file
    const contentType = req.headers['content-type'];
    if (contentType) {
      const metaPath = filePath + '.__meta__';
      writeFileSync(metaPath, JSON.stringify({ contentType }));
    }

    res.setHeader('ETag', `"${Date.now().toString(16)}"`);
    res.status(200).send();
  });

  // GET — read file
  app.get('/:bucket/*splat', (req, res) => {
    const bucket = req.params.bucket;
    const key = req.params.splat.join('/');

    // Check access
    if (storageConfig && apiKey) {
      const access = checkStorageAccess(key, 'get', req.authContext, storageConfig);
      if (!access.allowed) {
        return res.status(403).type('xml').send(
          `<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>${access.reason}</Message></Error>`
        );
      }
    }

    const filePath = join(storageDir, bucket, key);
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      return res.status(404).type('xml').send(
        `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>`
      );
    }

    // Read stored content-type or guess from extension
    const metaPath = filePath + '.__meta__';
    let contentType;
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
        contentType = meta.contentType;
      } catch {
        contentType = guessMimeType(filePath);
      }
    } else {
      contentType = guessMimeType(filePath);
    }

    const data = readFileSync(filePath);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', data.length);
    res.setHeader('ETag', `"${statSync(filePath).mtime.getTime().toString(16)}"`);
    res.send(data);
  });

  // DELETE — delete file
  app.delete('/:bucket/*splat', (req, res) => {
    const bucket = req.params.bucket;
    const key = req.params.splat.join('/');

    // Check access
    if (storageConfig && apiKey) {
      const access = checkStorageAccess(key, 'delete', req.authContext, storageConfig);
      if (!access.allowed) {
        return res.status(403).type('xml').send(
          `<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>${access.reason}</Message></Error>`
        );
      }
    }

    const filePath = join(storageDir, bucket, key);
    if (existsSync(filePath) && !statSync(filePath).isDirectory()) {
      unlinkSync(filePath);
      // Clean up metadata file
      const metaPath = filePath + '.__meta__';
      if (existsSync(metaPath)) {
        unlinkSync(metaPath);
      }
    }

    // S3 returns 204 even if key didn't exist
    res.status(204).send();
  });

  // HEAD — check existence + metadata
  app.head('/:bucket/*splat', (req, res) => {
    const bucket = req.params.bucket;
    const key = req.params.splat.join('/');

    const filePath = join(storageDir, bucket, key);
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      return res.status(404).send();
    }

    const stat = statSync(filePath);
    const metaPath = filePath + '.__meta__';
    let contentType;
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
        contentType = meta.contentType;
      } catch {
        contentType = guessMimeType(filePath);
      }
    } else {
      contentType = guessMimeType(filePath);
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('ETag', `"${stat.mtime.getTime().toString(16)}"`);
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
    res.status(200).send();
  });

  return app;
}
