'use strict';

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
    if (typeof src === 'string' && src.length <= MAX_IMAGE_BYTES * 1.4) return [{ src, alt: resource.name || resource.title || 'Grok 返回的图片' }];
  }
  return content.content ? imagesFromContent(content.content) : [];
}

function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.toString('ascii', 0, 2) === 'BM') return 'image/bmp';
  if (bytes.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/.test(bytes.toString('ascii', 8, 32))) return 'image/avif';
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return 'image/x-icon';
  if (/^(?:\uFEFF)?\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(bytes.subarray(0, 4096).toString('utf8'))) return 'image/svg+xml';
  throw new Error('文件不是支持的图片格式');
}

async function resolveImage(src, cwd, sessionDirectory) {
  if (typeof src !== 'string' || !src.trim() || src.length > MAX_IMAGE_BYTES * 1.4) throw new Error('无效的图片地址');
  src = src.trim();
  if (/^https?:\/\//i.test(src)) {
    const url = new URL(src);
    if (url.username || url.password) throw new Error('图片地址不能包含登录凭据');
    return { src: url.href };
  }
  if (/^data:/i.test(src)) {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/\r\n]*={0,2})$/i.exec(src);
    if (!match || !MIME_TYPES.has(match[1].toLowerCase())) throw new Error('不支持的内嵌图片');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('图片不能超过 20 MB');
    const mime = imageMime(bytes);
    return { src: `data:${mime};base64,${bytes.toString('base64')}` };
  }
  // Only local files in this workspace or its Grok session cache are exposed.
  // Resolve symlinks before containment checks and reject network/UNC paths.
  let file;
  if (/^file:/i.test(src)) {
    const url = new URL(src);
    if (url.hostname) throw new Error('不支持网络文件路径');
    file = fileURLToPath(url);
  } else {
    try { file = decodeURIComponent(src); } catch { file = src; }
  }
  if (/^(?:\\\\|\/\/)/.test(file) || (/:/.test(file) && !/^[a-z]:[\\/][^:]*$/i.test(file))) throw new Error('不支持的图片地址');
  if (!/\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i.test(file)) throw new Error('不支持的图片格式');
  const roots = [];
  for (const directory of [cwd, sessionDirectory].filter(Boolean)) {
    try { roots.push(await fs.realpath(directory)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let target;
  for (const root of roots) {
    try { target = await fs.realpath(path.resolve(root, file)); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!target) throw Object.assign(new Error('找不到图片文件，文件可能已移动或删除'), { code: 'ENOENT' });
  if (!roots.some(root => {
    const relative = path.relative(root, target);
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  })) throw new Error('图片不在这段对话的工作目录或图片缓存内');
  const handle = await fs.open(target, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new Error('图片不能超过 20 MB');
    const bytes = await handle.readFile();
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('图片不能超过 20 MB');
    return { src: `data:${imageMime(bytes)};base64,${bytes.toString('base64')}` };
  } finally { await handle.close(); }
}

module.exports = { imagesFromContent, resolveImage, imageMime };
