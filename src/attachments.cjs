'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { fileURLToPath } = require('node:url');
const { imageMime, isReadTool, readLocalBytes } = require('./media.cjs');
const { downloadPublicResource } = require('./resource-download.cjs');
const { createI18n } = require('./i18n.js');
const { lexer, walkTokens } = require('./renderer/vendor/marked.umd.js');
const defaultT = createI18n('en');
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const TYPES = { '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.pdf': 'application/pdf', '.zip': 'application/zip', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.html': 'text/html', '.js': 'text/javascript', '.py': 'text/x-python' };
const within = (root, target) => { const rel = path.relative(root, target); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };

function safeName(value) {
  let name = String(value || 'attachment').split(/[\\/]/).pop().replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 160) || 'attachment';
  if (/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = '_' + name;
  return name;
}

function sourceName(uri) {
  if (typeof uri !== 'string' || !uri || /^data:/i.test(uri)) return '';
  let value = uri;
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri) && !/^[a-z]:[\\/]/i.test(uri)) {
    try { value = new URL(uri).pathname; } catch { return ''; }
  }
  value = value.split(/[\\/]/).pop();
  try { value = decodeURIComponent(value); } catch {}
  return value ? safeName(value) : '';
}

function decodeBase64(data, t = defaultT) {
  if (typeof data !== 'string' || data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error(t('附件数据无效或超过 20 MB'));
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > MAX_ATTACHMENT_BYTES || bytes.toString('base64') !== data) throw new Error(t('附件数据无效或超过 20 MB'));
  return bytes;
}

async function stageAttachments(files, directory, { fromPaths = false, t = defaultT } = {}) {
  if (!Array.isArray(files) || !files.length || files.length > MAX_ATTACHMENTS) throw new Error(t('每条消息最多添加 10 个附件'));
  const result = [];
  const created = [];
  let total = 0;
  await fs.mkdir(directory, { recursive: true });
  const root = await fs.realpath(directory);
  try {
    for (const file of files) {
      if (fromPaths && (typeof file !== 'string' || !path.isAbsolute(file))) throw new Error(t('无效的附件'));
      if (!fromPaths && (!file || typeof file.name !== 'string')) throw new Error(t('无效的附件'));
      const name = safeName(fromPaths ? file : file.name);
      const bytes = fromPaths ? await readLocalBytes(file, undefined, t, true) : decodeBase64(file.data, t);
      total += bytes.length;
      if (total > MAX_TOTAL_BYTES) throw new Error(t('每条消息的附件总大小不能超过 50 MB'));
      let mimeType;
      try { mimeType = imageMime(bytes); } catch { mimeType = TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream'; }
      const id = randomUUID();
      const folder = path.join(root, id);
      await fs.mkdir(folder); created.push(folder);
      const src = path.join(folder, name);
      await fs.writeFile(src, bytes, { flag: 'wx', mode: 0o600 });
      result.push({ id, name, mimeType, size: bytes.length, src, ...(mimeType.startsWith('image/') ? { previewSrc: `data:${mimeType};base64,${bytes.toString('base64')}` } : {}) });
    }
    return result;
  } catch (error) {
    for (const folder of created) if (within(root, folder) && folder !== root) await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function attachmentsFromContent(content) {
  if (Array.isArray(content)) return content.flatMap(attachmentsFromContent);
  if (!content || typeof content !== 'object') return [];
  if (content.type !== 'resource_link' && content.type !== 'resource') return content.content ? attachmentsFromContent(content.content) : [];
  const resource = content.type === 'resource' ? content.resource : content;
  if (!resource || /^image\//i.test(resource.mimeType || '')) return [];
  const mimeType = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(resource.mimeType || '') ? resource.mimeType : 'application/octet-stream';
  let src = resource.uri;
  let size = resource.size;
  if (typeof resource.text === 'string') {
    const bytes = Buffer.from(resource.text, 'utf8');
    if (bytes.length > MAX_ATTACHMENT_BYTES) return [];
    src = `data:${mimeType};base64,${bytes.toString('base64')}`; size = bytes.length;
  } else if (typeof resource.blob === 'string') {
    try { const bytes = decodeBase64(resource.blob); src = `data:${mimeType};base64,${bytes.toString('base64')}`; size = bytes.length; } catch { return []; }
  }
  if (typeof src !== 'string' || !src || src.length > MAX_ATTACHMENT_BYTES * 1.4) return [];
  const fileName = sourceName(resource.uri);
  const name = safeName(resource.name || resource.title || fileName || 'attachment');
  const id = createHash('sha256').update(src).update('\0').update(name).digest('hex').slice(0, 32);
  return [{ id, name, fileName: fileName || name, mimeType, src, ...(Number.isFinite(size) && size >= 0 ? { size } : {}) }];
}

function attachmentsFromText(text) {
  const result = [];
  // Use the same bundled Markdown parser as the renderer: balanced parentheses,
  // reference links and escaped filenames must resolve to the link users see.
  walkTokens(lexer(String(text || '')), token => {
    if (token.type !== 'link') return;
    const uri = token.href;
    if (!uri || uri.startsWith('#')) return;
    if (/\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico)(?:[?#]|$)/i.test(uri)) return;
    if (/^https?:/i.test(uri) && !/\.(?:pdf|docx?|xlsx?|pptx?|zip|tar|gz|csv|tsv|txt|md|json|xml|html?|py|js|cjs|ts|mp3|wav|mp4)(?:[?#]|$)/i.test(uri)) return;
    if (!/^https?:/i.test(uri) && /:/.test(uri) && !/^(?:file:|[a-z]:[\\/])/i.test(uri)) return;
    result.push(...attachmentsFromContent({ type: 'resource_link', uri, name: token.text || undefined, mimeType: TYPES[path.extname(sourceName(uri)).toLowerCase()] }));
  });
  return result;
}

function attachmentsFromTools(tools) {
  return (Array.isArray(tools) ? tools : []).filter(tool => !isReadTool(tool)).flatMap(tool =>
    attachmentsFromContent(tool?.content).map(attachment => ({ ...attachment, origin: 'tool', toolCallId: tool.toolCallId })));
}

function restoreMessageAttachments(message) {
  const tools = Array.isArray(message.tools) ? message.tools : [];
  const outputs = message.role === 'assistant' ? attachmentsFromTools(tools) : [];
  const explicit = message.role === 'assistant' ? attachmentsFromText(message.text).map(attachment => ({ ...attachment, origin: 'assistant' })) : [];
  const readSources = new Set(tools.filter(isReadTool).flatMap(tool => attachmentsFromContent(tool.content)).map(attachment => attachment.src));
  const outputSources = new Set([...outputs, ...explicit].map(attachment => attachment.src));
  const saved = (Array.isArray(message.attachments) ? message.attachments : []).filter(attachment => typeof attachment?.id === 'string' && typeof attachment.src === 'string'
    && (message.role !== 'assistant' || attachment.origin === 'assistant' || !readSources.has(attachment.src) || outputSources.has(attachment.src)));
  // Old clients promoted read results into reply attachments. Remove those
  // echoes while preserving uploads, generated files and explicit reply links.
  return [...new Map([...outputs, ...saved, ...explicit].map(attachment => [attachment.id, attachment])).values()];
}

async function resolveAttachment(src, directories, t = defaultT, fetcher) {
  if (typeof src !== 'string' || !src.trim()) throw new Error(t('无效的附件'));
  src = src.trim();
  if (/^data:/i.test(src)) {
    const match = /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,([\s\S]*)$/i.exec(src);
    if (!match) throw new Error(t('无效的附件'));
    return decodeBase64(match[1], t);
  }
  if (/^https?:\/\//i.test(src)) {
    return downloadPublicResource(src, { t, fetcher });
  }
  let files = [src];
  if (/^file:/i.test(src)) {
    const url = new URL(src);
    if (url.hostname) throw new Error(t('不支持的附件地址'));
    files = [fileURLToPath(url)];
  } else {
    try { const decoded = decodeURIComponent(src); if (decoded !== src) files.push(decoded); } catch {}
  }
  files = files.filter(file => !/^(?:\\\\|\/\/)/.test(file) && (!file.includes(':') || /^[a-z]:[\\/][^:]*$/i.test(file)));
  if (!files.length) throw new Error(t('不支持的附件地址'));
  const roots = [];
  for (const directory of directories.filter(Boolean)) { try { roots.push(await fs.realpath(directory)); } catch {} }
  for (const root of roots) for (const file of files) {
    let target;
    try { target = await fs.realpath(path.resolve(root, file)); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; throw error; }
    if (!roots.some(allowed => within(allowed, target))) throw new Error(t('附件不在这段对话允许的目录内'));
    return readLocalBytes(target, roots, t, true);
  }
  throw new Error(t('找不到附件文件，文件可能已移动或删除'));
}

module.exports = { MAX_ATTACHMENT_BYTES, MAX_TOTAL_BYTES, MAX_ATTACHMENTS, safeName, stageAttachments, attachmentsFromContent, attachmentsFromText, attachmentsFromTools, restoreMessageAttachments, resolveAttachment };
