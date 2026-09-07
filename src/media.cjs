'use strict';

const { createI18n } = require('./i18n.js');
const defaultT = createI18n(() => 'zh-CN');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/avif', 'image/bmp', 'image/x-icon']);

function imagesFromContent(content) {
  if (Array.isArray(content)) return content.flatMap(imagesFromContent);
  if (!content || typeof content !== 'object') return [];
  const resource = content.type === 'resource' ? content.resource : content;
  const mime = resource?.mimeType;
  if ((content.type === 'image' || content.type === 'resource' || content.type === 'resource_link') && MIME_TYPES.has(mime)) {
    const data = resource.data || resource.blob;
    const src = typeof data === 'string' ? `data:${mime};base64,${data}` : resource.uri;
    if (typeof src === 'string' && src.length <= MAX_IMAGE_BYTES * 1.4) return [{ src, alt: resource.name || resource.title || 'Grok 返回的图片', altIsDefault: !resource.name && !resource.title }];
  }
  return content.content ? imagesFromContent(content.content) : [];
}

function imageMime(bytes, t = defaultT) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.toString('ascii', 0, 2) === 'BM') return 'image/bmp';
  if (bytes.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/.test(bytes.toString('ascii', 8, 32))) return 'image/avif';
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return 'image/x-icon';
  if (/^(?:\uFEFF)?\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(bytes.subarray(0, 4096).toString('utf8'))) return 'image/svg+xml';
  throw new Error(t('文件不是支持的图片格式'));
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function comparableDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return '';
  if (process.platform === 'win32') value = value.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
  value = path.resolve(value);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

async function findSessionImageDirectory(grokHome, cwd, sessionId) {
  if (!comparableDirectory(grokHome) || !comparableDirectory(cwd) || typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) return undefined;
  // Grok uses RFC 3986 names for short CWDs, and slug/hash names plus a .cwd
  // metadata file for longer ones. Locate only this workspace and this session.
  const safeDirectory = async (directory, root) => {
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
      const resolved = await fs.realpath(directory);
      return isWithin(root, resolved) ? resolved : undefined;
    } catch { return undefined; }
  };
  try {
    const home = await fs.realpath(grokHome);
    const sessions = await safeDirectory(path.join(home, 'sessions'), home);
    if (!sessions) return undefined;
    const cwdValues = new Set([cwd]);
    try { cwdValues.add(await fs.realpath(cwd)); } catch { /* A moved workspace can still have cached images. */ }
    if (process.platform === 'win32') for (const value of [...cwdValues]) cwdValues.add(value.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, ''));
    const expected = new Set([...cwdValues].map(comparableDirectory));
    const checked = new Set();
    const findIn = async directory => {
      checked.add(path.basename(directory));
      const workspace = await safeDirectory(directory, sessions);
      return workspace ? safeDirectory(path.join(workspace, sessionId), workspace) : undefined;
    };
    for (const value of cwdValues) {
      const encoded = encodeURIComponent(value).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
      if (encoded.length > 255) continue;
      const found = await findIn(path.join(sessions, encoded));
      if (found) return found;
    }
    for (const entry of await fs.readdir(sessions, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || checked.has(entry.name)) continue;
      const directory = await safeDirectory(path.join(sessions, entry.name), sessions);
      if (!directory) continue;
      let storedCwd = '';
      try { storedCwd = decodeURIComponent(entry.name); } catch {}
      if (!comparableDirectory(storedCwd)) {
        // Bound this metadata read and reject links; no conversation or auth file
        // is consulted to find a cache, and unreadable caches stay optional.
        const metadata = path.join(directory, '.cwd');
        try {
          const stat = await fs.lstat(metadata);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768 || !isWithin(directory, await fs.realpath(metadata))) continue;
          const handle = await fs.open(metadata, 'r');
          try {
            const bytes = Buffer.alloc(32769);
            const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
            if (bytesRead > 32768) continue;
            storedCwd = bytes.subarray(0, bytesRead).toString('utf8').trim();
          } finally { await handle.close(); }
        } catch { continue; }
      }
      let key = comparableDirectory(storedCwd);
      if (!key) continue;
      if (!expected.has(key)) {
        try { key = comparableDirectory(await fs.realpath(storedCwd)); } catch { continue; }
      }
      if (!expected.has(key)) continue;
      const found = await findIn(directory);
      if (found) return found;
    }
  } catch { /* Cache lookup must not prevent loading a workspace image. */ }
  return undefined;
}

async function resolveImage(src, cwd, sessionDirectory, t = defaultT) {
  if (typeof src !== 'string' || !src.trim() || src.length > MAX_IMAGE_BYTES * 1.4) throw new Error(t('无效的图片地址'));
  src = src.trim();
  if (/^https?:\/\//i.test(src)) {
    const url = new URL(src);
    if (url.username || url.password) throw new Error(t('图片地址不能包含登录凭据'));
    return { src: url.href };
  }
  if (/^data:/i.test(src)) {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/\r\n]*={0,2})$/i.exec(src);
    if (!match || !MIME_TYPES.has(match[1].toLowerCase())) throw new Error(t('不支持的内嵌图片'));
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error(t('图片不能超过 20 MB'));
    const mime = imageMime(bytes, t);
    return { src: `data:${mime};base64,${bytes.toString('base64')}` };
  }
  // Only local files in this workspace or its Grok session cache are exposed.
  // Resolve symlinks before containment checks and reject network/UNC paths.
  let files;
  if (/^file:/i.test(src)) {
    const url = new URL(src);
    if (url.hostname) throw new Error(t('不支持网络文件路径'));
    files = [fileURLToPath(url)];
  } else {
    // CLI content can contain literal filenames such as "change%20chart.png".
    // Prefer that exact file, then accept URI-encoded Markdown paths as a fallback.
    files = [src];
    try { const decoded = decodeURIComponent(src); if (decoded !== src) files.push(decoded); } catch {}
  }
  files = files.filter(file => !/^(?:\\\\|\/\/)/.test(file) && (!/:/.test(file) || /^[a-z]:[\\/][^:]*$/i.test(file)));
  if (!files.length) throw new Error(t('不支持的图片地址'));
  files = files.filter(file => /\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i.test(file));
  if (!files.length) throw new Error(t('不支持的图片格式'));
  const roots = [];
  for (const directory of [cwd, sessionDirectory].filter(Boolean)) {
    try { roots.push(await fs.realpath(directory)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let target;
  search: for (const root of roots) {
    for (const file of files) {
      try { target = await fs.realpath(path.resolve(root, file)); break search; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  if (!target) throw Object.assign(new Error(t('找不到图片文件，文件可能已移动或删除')), { code: 'ENOENT' });
  if (!roots.some(root => isWithin(root, target))) throw new Error(t('图片不在这段对话的工作目录或图片缓存内'));
  const handle = await fs.open(target, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new Error(t('图片不能超过 20 MB'));
    const bytes = await handle.readFile();
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error(t('图片不能超过 20 MB'));
    return { src: `data:${imageMime(bytes, t)};base64,${bytes.toString('base64')}` };
  } finally { await handle.close(); }
}

module.exports = { imagesFromContent, resolveImage, imageMime, findSessionImageDirectory };
