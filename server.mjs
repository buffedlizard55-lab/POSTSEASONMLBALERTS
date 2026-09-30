#!/usr/bin/env node
/* ============================================================================
 * server.mjs — HTTP server for MLB Live PBP with persistent feed logging.
 *
 * Serves static web assets and provides a shared persistence backend for
 * reviews, challenges, official-scorer pending rulings, and scoring changes.
 *
 * Persisted state lives in data/feed-log-<YYYY-MM-DD>.json so that any
 * client/browser visiting the website immediately receives all tracked
 * entries, scoring changes, and baselines across browsers and sessions.
 * ==========================================================================*/

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_DIR = __dirname;
const DATA_DIR = path.join(REPO_DIR, 'data');
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8000;
const HOST = '0.0.0.0';

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  // Audio: the alert sound slot. Without these, a committed
  // assets/audio/cha-ching.mp3 is served as application/octet-stream and some
  // browsers refuse to decode it, silently falling back to the synthesizer.
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.weba': 'audio/webm',
  '.webm': 'audio/webm',
};

/* ------------------------------------------------------ the alert-sound slot
 * The site's alert prefers a REAL cash-register recording installed at
 * assets/audio/cha-ching.{mp3,wav,ogg,m4a} and falls back to the synthesized
 * cha-ching when there is none. These endpoints let that recording be
 * installed by uploading it (from sound-lab.html) instead of by hand-editing
 * the repository, and let a page ask what is currently installed.
 *
 * Everything is confined to AUDIO_DIR with a whitelisted extension, so an
 * upload can never write outside the audio slot or overwrite site code.
 */
const AUDIO_DIR = path.join(REPO_DIR, 'assets', 'audio');
const AUDIO_STEM = 'cha-ching';
/** Extension -> the Content-Type the client should have sent. */
const AUDIO_EXTS = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
};
/** Same order and same extensions the client probes, so an install is found. */
const AUDIO_CANDIDATES = ['.mp3', '.wav', '.ogg', '.m4a'];
const AUDIO_MAX_BYTES = 12 * 1024 * 1024;   // a 1-2 s alert is far smaller

/** The installed recording, or null. First candidate in probe order wins. */
function installedAlertSound() {
  for (const ext of AUDIO_CANDIDATES) {
    const file = path.join(AUDIO_DIR, `${AUDIO_STEM}${ext}`);
    try {
      const stats = fs.statSync(file);
      if (stats.isFile() && stats.size > 0) {
        return {
          path: `assets/audio/${AUDIO_STEM}${ext}`,
          ext,
          bytes: stats.size,
          mimeType: AUDIO_EXTS[ext] || 'application/octet-stream',
          modifiedAt: stats.mtimeMs,
        };
      }
    } catch (_) { /* not installed under this extension */ }
  }
  return null;
}

/** Pick an extension from the upload's filename or Content-Type. */
function audioExtFor(name, contentType) {
  const fromName = path.extname(String(name || '')).toLowerCase();
  if (AUDIO_EXTS[fromName]) return fromName;
  const byType = Object.keys(AUDIO_EXTS).find((ext) => AUDIO_EXTS[ext] === String(contentType || '').split(';')[0].trim().toLowerCase());
  return byType || null;
}

/**
 * Which audio container these bytes are, or null when they are not a
 * recognizable one. Checked by magic bytes, because the alternative — a
 * "looks binary" heuristic — rejects real audio: the first 512 bytes of a
 * 16-bit PCM WAV are the 44-byte header plus quiet samples, i.e. dense in
 * bytes below 0x09, which any control-character test reads as "not media".
 */
function detectAudioContainer(bytes) {
  if (bytes.length < 12) return null;
  const ascii = (from, len) => bytes.toString('ascii', from, from + len);
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'wav';
  if (ascii(0, 4) === 'OggS') return 'ogg';
  if (ascii(0, 4) === 'fLaC') return 'flac';
  if (ascii(0, 3) === 'ID3') return 'mp3 (ID3-tagged)';
  if (ascii(4, 4) === 'ftyp') return 'mp4/m4a';
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'mp3/aac (ADTS)';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'webm';
  return null;
}

/**
 * True when the bytes are a text document rather than audio. This exists
 * because some static hosts answer an unknown path with index.html at status
 * 200; without it the browser would try to decode a web page and fail
 * confusingly instead of falling back cleanly to the synthesizer.
 *
 * An unrecognized file is only rejected on two independent signs: a text
 * prefix, or a head that is almost entirely printable ASCII. Real audio is
 * never almost entirely printable ASCII, so a container this server does not
 * know about is still accepted and left for the browser to decode.
 */
function looksLikeText(bytes) {
  const head = bytes.subarray(0, Math.min(512, bytes.length));
  let text = '';
  for (let i = 0; i < head.length; i++) text += String.fromCharCode(head[i]);
  if (/^\s*(<!doctype html|<html|<head|<\?xml|\{|\[)/i.test(text)) return true;
  let printable = 0;
  for (let i = 0; i < head.length; i++) {
    const b = head[i];
    if (b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e)) printable += 1;
  }
  return printable / head.length > 0.97;
}

function sendJSON(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });
  res.end(body);
}

function sendError(res, statusCode, message) {
  sendJSON(res, statusCode, { error: message });
}

function getLogFilePath(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  return path.join(DATA_DIR, `feed-log-${dateStr}.json`);
}

function readLogFromDisk(dateStr) {
  const filePath = getLogFilePath(dateStr);
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[server] failed to read feed log for ${dateStr}:`, err);
    return null;
  }
}

/**
 * Merge an incoming feed log into an existing disk log idempotently.
 * Preserves all distinct rows, baselines, history chains, and irregularities.
 */
function mergeFeedLogPayloads(existing, incoming, dateStr) {
  const now = Date.now();
  if (!existing || typeof existing !== 'object' || existing.v !== 1) {
    return {
      v: 1,
      date: dateStr,
      savedAt: now,
      entries: Array.isArray(incoming.entries) ? incoming.entries : [],
      order: Array.isArray(incoming.order) ? incoming.order : [],
      snapshots: (incoming.snapshots && typeof incoming.snapshots === 'object') ? incoming.snapshots : {},
      irregularities: (incoming.irregularities && typeof incoming.irregularities === 'object') ? incoming.irregularities : {},
      grace: (incoming.grace && typeof incoming.grace === 'object') ? incoming.grace : {},
      settled: Array.isArray(incoming.settled) ? incoming.settled : [],
    };
  }

  // Merge entries by key: gamePk:review.id
  const entryMap = new Map();
  const orderList = [];

  function makeKey(entry) {
    if (!entry || !entry.review) return null;
    return `${entry.gamePk}:${entry.review.id || entry.review.atBatIndex || ''}`;
  }

  (Array.isArray(existing.entries) ? existing.entries : []).forEach((e) => {
    const k = makeKey(e);
    if (!k) return;
    entryMap.set(k, e);
    if (!orderList.includes(k)) orderList.push(k);
  });

  (Array.isArray(incoming.entries) ? incoming.entries : []).forEach((e) => {
    const k = makeKey(e);
    if (!k) return;
    const prev = entryMap.get(k);
    if (!prev) {
      entryMap.set(k, e);
      if (!orderList.includes(k)) orderList.push(k);
    } else {
      // Merge: prefer most complete / latest seen
      const mergedEntry = {
        gamePk: e.gamePk || prev.gamePk,
        review: { ...prev.review, ...e.review },
        firstSeen: Math.min(prev.firstSeen || e.firstSeen || now, e.firstSeen || prev.firstSeen || now),
        lastSeen: Math.max(prev.lastSeen || 0, e.lastSeen || 0, now),
        matchupLabel: e.matchupLabel || prev.matchupLabel || null,
      };
      // For scoring change: preserve longer history if present
      if (prev.review && prev.review.history && (!e.review.history || e.review.history.length < prev.review.history.length)) {
        mergedEntry.review.history = prev.review.history;
      }
      entryMap.set(k, mergedEntry);
    }
  });

  // Merge snapshots (per gamePk -> atBatIndex)
  const mergedSnapshots = { ...(existing.snapshots || {}) };
  if (incoming.snapshots && typeof incoming.snapshots === 'object') {
    Object.keys(incoming.snapshots).forEach((gamePk) => {
      mergedSnapshots[gamePk] = {
        ...(mergedSnapshots[gamePk] || {}),
        ...(incoming.snapshots[gamePk] || {}),
      };
    });
  }

  // Merge irregularities (per gamePk -> notes array)
  const mergedIrregularities = { ...(existing.irregularities || {}) };
  if (incoming.irregularities && typeof incoming.irregularities === 'object') {
    Object.keys(incoming.irregularities).forEach((gamePk) => {
      const prevNotes = mergedIrregularities[gamePk] || [];
      const newNotes = incoming.irregularities[gamePk] || [];
      const combined = [...prevNotes];
      newNotes.forEach((n) => {
        if (typeof n === 'string' && !combined.includes(n)) combined.push(n);
      });
      mergedIrregularities[gamePk] = combined.slice(-30);
    });
  }

  // Merge grace
  const mergedGrace = { ...(existing.grace || {}), ...(incoming.grace || {}) };

  // Merge settled
  const settledSet = new Set([
    ...(Array.isArray(existing.settled) ? existing.settled : []),
    ...(Array.isArray(incoming.settled) ? incoming.settled : []),
  ]);

  return {
    v: 1,
    date: dateStr,
    savedAt: now,
    entries: orderList.map((k) => entryMap.get(k)).filter(Boolean),
    order: orderList,
    snapshots: mergedSnapshots,
    irregularities: mergedIrregularities,
    grace: mergedGrace,
    settled: [...settledSet],
  };
}

/* --------------------------------------------------------------- push (SSE)
 * Live tail of the shared feed log. Polling it (GET /api/feed-log) leaves a
 * window of up to the poll interval between "another browser/session wrote an
 * entry" and "this page sees it" — 15s in the shipped client. A Server-Sent
 * Events stream pushes each accepted write to every connected page
 * immediately, so the Replay Feed's rows and the scoreboard's scoring-change
 * chips appear as soon as ANY browser observed them, with no polling at all
 * (the client keeps its ordinary poll as a fallback when a stream cannot be
 * established — e.g. the static GitHub Pages deployment, where this endpoint
 * does not exist).
 */
const sseClients = new Set(); // { res, date }

function sseWrite(res, chunk) {
  try {
    return res.write(chunk);
  } catch (_) {
    return false;
  }
}

/** Push one merged log payload to every stream watching that date. */
function broadcastFeedLog(dateStr, payload) {
  if (!sseClients.size) return 0;
  let body;
  try {
    body = JSON.stringify(payload);
  } catch (err) {
    console.warn(`[server] could not serialize the feed log for push:`, err);
    return 0;
  }
  const frame = `event: feed-log\ndata: ${body}\n\n`;
  let sent = 0;
  sseClients.forEach((client) => {
    if (client.date !== dateStr) return;
    if (sseWrite(client.res, frame)) sent += 1;
  });
  return sent;
}

function writeLogToDisk(dateStr, payload) {
  const filePath = getLogFilePath(dateStr);
  if (!filePath) return false;
  try {
    const existing = readLogFromDisk(dateStr);
    const merged = mergeFeedLogPayloads(existing, payload, dateStr);
    const serialized = JSON.stringify(merged, null, 2);
    // Write atomically via temporary file
    const tempPath = `${filePath}.tmp.${Date.now()}`;
    fs.writeFileSync(tempPath, serialized, 'utf8');
    fs.renameSync(tempPath, filePath);

    // Update index
    const indexPath = path.join(DATA_DIR, 'feed-log-index.json');
    let index = {};
    if (fs.existsSync(indexPath)) {
      try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) || {}; } catch (_) {}
    }
    index[dateStr] = merged.savedAt;
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');
    return merged;
  } catch (err) {
    console.error(`[server] failed to write feed log for ${dateStr}:`, err);
    return false;
  }
}

const server = http.createServer((req, res) => {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;

  // --- API Endpoints ---

  // Health check
  if (pathname === '/api/health') {
    sendJSON(res, 200, { status: 'ok', uptime: process.uptime() });
    return;
  }

  // GET /api/feed-log/stream?date=YYYY-MM-DD — Server-Sent Events tail of the log.
  if (pathname === '/api/feed-log/stream' && req.method === 'GET') {
    const dateStr = reqUrl.searchParams.get('date');
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      sendError(res, 400, 'date query parameter in YYYY-MM-DD format is required');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Proxies (and some dev servers) buffer responses by default; these two
      // headers ask them not to, so frames are flushed as they are written.
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    // Ask the browser's EventSource to reconnect after 3s, and tell the client
    // the date this stream is for (so a late/duplicate frame is ignorable).
    sseWrite(res, `retry: 3000\nevent: connected\ndata: {"date":"${dateStr}"}\n\n`);
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    const client = { res, date: dateStr };
    sseClients.add(client);
    // Heartbeat: keeps intermediaries from timing the connection out and lets
    // a dead peer be noticed without waiting for a write.
    const heartbeat = setInterval(() => { sseWrite(res, ': hb\n\n'); }, 20000);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();
    const cleanup = () => {
      clearInterval(heartbeat);
      sseClients.delete(client);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
    // An initial snapshot, so a page that connects while another browser is
    // active adopts the current log immediately (the client merges it
    // idempotently, exactly like its ordinary GET).
    const current = readLogFromDisk(dateStr);
    if (current) sseWrite(res, `event: feed-log\ndata: ${JSON.stringify(current)}\n\n`);
    return;
  }

  // GET /api/feed-log?date=YYYY-MM-DD or /api/log?date=YYYY-MM-DD
  if ((pathname === '/api/feed-log' || pathname === '/api/log') && req.method === 'GET') {
    const dateStr = reqUrl.searchParams.get('date');
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      sendError(res, 400, 'date query parameter in YYYY-MM-DD format is required');
      return;
    }
    const log = readLogFromDisk(dateStr);
    if (log) {
      sendJSON(res, 200, log);
    } else {
      // Return empty valid structure if not yet created on disk
      sendJSON(res, 200, {
        v: 1,
        date: dateStr,
        savedAt: Date.now(),
        entries: [],
        order: [],
        snapshots: {},
        irregularities: {},
        grace: {},
        settled: [],
      });
    }
    return;
  }

  // POST /api/feed-log or /api/log
  if ((pathname === '/api/feed-log' || pathname === '/api/log') && req.method === 'POST') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 50 * 1024 * 1024) { // 50MB protection
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        if (!payload || typeof payload !== 'object' || payload.v !== 1 || !payload.date || !/^\d{4}-\d{2}-\d{2}$/.test(payload.date)) {
          sendError(res, 400, 'Invalid payload: must be object with v: 1 and valid date (YYYY-MM-DD)');
          return;
        }
        const saved = writeLogToDisk(payload.date, payload);
        if (saved) {
          // Push the merged log to every open page for this date BEFORE the
          // POST response: the write is already durable, so another session's
          // page can show the new entry while this one is still being
          // acknowledged. (The posting page also receives it; its merge is
          // idempotent and produces no re-render.)
          const pushed = broadcastFeedLog(payload.date, saved);
          sendJSON(res, 200, {
            ok: true,
            date: payload.date,
            savedAt: saved.savedAt,
            entriesCount: saved.entries.length,
            pushed,
          });
        } else {
          sendError(res, 500, 'Failed to save feed log to disk');
        }
      } catch (err) {
        sendError(res, 400, `JSON parse error: ${err.message}`);
      }
    });
    return;
  }

  // GET /api/alert-sound — what recording is installed, if any.
  if (pathname === '/api/alert-sound' && req.method === 'GET') {
    const installed = installedAlertSound();
    sendJSON(res, 200, {
      installed: !!installed,
      sound: installed,
      candidates: AUDIO_CANDIDATES.map((ext) => `assets/audio/${AUDIO_STEM}${ext}`),
      maxBytes: AUDIO_MAX_BYTES,
      accepted: Object.keys(AUDIO_EXTS),
    });
    return;
  }

  // POST /api/alert-sound — install a recording. The body is the raw file
  // (not multipart), so the Sound Lab can send exactly the bytes the user
  // dropped. The extension comes from ?name= or the Content-Type.
  if (pathname === '/api/alert-sound' && req.method === 'POST') {
    const ext = audioExtFor(reqUrl.searchParams.get('name'), req.headers['content-type']);
    if (!ext) {
      sendError(res, 400,
        `unsupported audio type — pass ?name=file.${Object.keys(AUDIO_EXTS).map((e) => e.slice(1)).join('|')} ` +
        'or an audio/* Content-Type');
      return;
    }
    const chunks = [];
    let total = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      total += chunk.length;
      if (total > AUDIO_MAX_BYTES) {
        aborted = true;
        sendError(res, 413, `audio file too large (limit ${AUDIO_MAX_BYTES} bytes)`);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        const bytes = Buffer.concat(chunks);
        if (bytes.length < 512) {
          sendError(res, 400, 'that is too short to be an audio file (under 512 bytes)');
          return;
        }
        if (looksLikeText(bytes)) {
          sendError(res, 415, 'that looks like an HTML or text page, not an audio file');
          return;
        }
        const container = detectAudioContainer(bytes);
        fs.mkdirSync(AUDIO_DIR, { recursive: true });
        const target = path.join(AUDIO_DIR, `${AUDIO_STEM}${ext}`);
        // Atomic write, like the feed log: a half-written alert file would
        // decode-fail in the browser and silently drop back to the synthesizer.
        const tempPath = `${target}.tmp.${Date.now()}`;
        fs.writeFileSync(tempPath, bytes);
        fs.renameSync(tempPath, target);
        // Only one recording can be the alert, and the client probes in a
        // fixed order; remove the other extensions so the newest upload is
        // unambiguously the one that plays.
        AUDIO_CANDIDATES.forEach((other) => {
          if (other === ext) return;
          try { fs.unlinkSync(path.join(AUDIO_DIR, `${AUDIO_STEM}${other}`)); } catch (_) {}
        });
        const installed = installedAlertSound();
        console.log(`[server] installed alert sound: ${installed.path} ` +
          `(${installed.bytes} bytes, container ${container || 'unrecognized'})`);
        sendJSON(res, 200, {
          ok: true,
          installed: true,
          sound: installed,
          // Reported so an unrecognized container is visible rather than
          // silently written; the browser still gets to try to decode it.
          container: container || 'unrecognized — saved anyway, the browser decides',
          note: 'reload any open tab to hear it; commit assets/audio/ to ship it',
        });
      } catch (err) {
        sendError(res, 500, `could not save the alert sound: ${err.message}`);
      }
    });
    return;
  }

  // DELETE /api/alert-sound — remove the recording, restoring the synthesizer.
  if (pathname === '/api/alert-sound' && req.method === 'DELETE') {
    let removed = 0;
    Object.keys(AUDIO_EXTS).forEach((ext) => {
      try { fs.unlinkSync(path.join(AUDIO_DIR, `${AUDIO_STEM}${ext}`)); removed += 1; } catch (_) {}
    });
    sendJSON(res, 200, { ok: true, installed: false, removed });
    return;
  }

  // --- Static File Serving ---
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendError(res, 405, 'Method not allowed');
    return;
  }

  let safePath = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[\/\\])+/, '');
  if (safePath === '/' || safePath === '') safePath = '/index.html';
  if (safePath === '/reviews') safePath = '/reviews.html';
  if (safePath === '/game') safePath = '/game.html';

  const filePath = path.join(REPO_DIR, safePath);

  // Security check: ensure path is within REPO_DIR
  if (!filePath.startsWith(REPO_DIR)) {
    sendError(res, 403, 'Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // 404 fallback: if asking for an html page, check 404.html
      const notFoundPath = path.join(REPO_DIR, '404.html');
      if (fs.existsSync(notFoundPath)) {
        res.writeHead(404, {
          'Content-Type': 'text/html; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        fs.createReadStream(notFoundPath).pipe(res);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
      }
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[MLB Live PBP Server] listening on http://${HOST}:${PORT}`);
  console.log(`[MLB Live PBP Server] Serving ${REPO_DIR}`);
  console.log(`[MLB Live PBP Server] Feed log persistence directory: ${DATA_DIR}`);
  const alertSound = installedAlertSound();
  console.log(`[MLB Live PBP Server] Alert sound: ${alertSound ? alertSound.path : 'not installed — the synthesized cha-ching is in use'}`);
  console.log(`[MLB Live PBP Server] Sound Lab: http://${HOST}:${PORT}/sound-lab.html`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
