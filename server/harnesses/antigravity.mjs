/**
 * Antigravity adapter (fork addition).
 *
 * Reads the desktop app's session store — a file tree, not one database:
 *
 *   <home>/.gemini/antigravity/
 *     conversations/<uuid>.db        one SQLite db per conversation (~30 files).
 *                                     Payload tables are PROTOBUF BLOBS with no
 *                                     descriptors shipped, so the db is never
 *                                     opened: only its size (building mass) and
 *                                     mtime (recency) are read, via stat.
 *     brain/<uuid>/.system_generated/logs/transcript_full.jsonl
 *                                     line 0 is the first prompt (preview/title
 *                                     fallback); records carry created_at.
 *     annotations/<uuid>.pbtxt       tiny text protos: optional title:"...",
 *                                     last_user_view_time seconds, pinned.
 *     agyhub_summaries_proto.pb      binary summary index: uuid -> display
 *                                     title, workspace file:///... path(s),
 *                                     branch, agent id + display name. Parsed
 *                                     with a descriptor-free field walker
 *                                     (stable field paths, see below).
 *
 * Two sources, merged per scan (local wins — it IS the live store):
 *
 *   1. Local store (UNION MEMBER). Same copy-never mechanics as the other
 *      adapters: dbs are stat'ed, transcript HEADS are read (never whole
 *      files), everything is mtime-cached per ground rules. Point at one
 *      with ANTIGRAVITY_DATA_DIR or leave unset for this machine's default.
 *
 *   2. Remote snapshot (PRIMARY on a colony host). The store lives on another
 *      machine; one SSH PowerShell pass emits a MANIFEST (db stats, inlined
 *      annotations, the summary index as base64, transcript first-lines as
 *      base64) into a local snapshot file. The pull is signature-gated — a
 *      cheap stat runs at most once per STAT_TTL window, the bulk pull only
 *      when the signature changed, at most once per PULL_MIN window, in the
 *      background so a scan never blocks. A single remote pass is
 *      self-consistent, so unlike a db+wal sequential copy there is no torn
 *      pair to guard against; a failed parse or empty manifest discards the
 *      set and the previous snapshot keeps serving.
 *      Config: ANTIGRAVITY_SSH_TARGET, ANTIGRAVITY_REMOTE_PATH
 *      (default `.gemini/antigravity`, forward slashes). Snapshots live under
 *      ANTIGRAVITY_SNAPSHOT_DIR, else the user cache dir, else the tmpdir.
 *
 * The app keeps no archive concept anywhere (no flag, no trash dir), so
 * setArchived says so per the interface and the colony keeps its own mark.
 * There is no verified deep link, so openThread/newSession say so too.
 * appStartedAt is omitted: with no outside write to stomp, there is no
 * memory-rewrite guard to drive.
 *
 * Annotation-only uuids (no db, no brain transcript) are deleted-conversation
 * leftovers — the app leaves orphan .pbtxt files behind on delete — and are
 * SKIPPED: a real conversation always has a db (created on first user
 * message) or a brain transcript.
 * Summary-index-only uuids (no db, brain, or annotation anywhere) are
 * SKIPPED: the index retains entries for deleted conversations, and without
 * any backing file they are not threads worth showing.
 *
 * GAPS (labeled, not papered over): unread is always false (read.json
 * comparison not wired); hasError is always false (would need transcript
 * tails); running is a 5-minute recency heuristic; model is opportunistic
 * (parsed from a settings-change line in the first prompt, else ''); the
 * summary field paths are descriptor-free and fall back gracefully when the
 * app ships a new shape; branch-less home-directory sessions group under a
 * 'home' project; sub-agent uuids that collide with conversation ids dedupe
 * naturally by uuid.
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { listFiles, num, readHead } from '../lib/fsutil.mjs'
import {
  noteRemoteSeen,
  remoteHostLabel,
  remoteSeenIso,
  withRemoteTopology,
} from './remote-stat.mjs'

/* ---------------------------------------------------------------- config */

const numEnv = (name, fallback) => {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

/** This machine's Antigravity data home (never written to, only read). */
function dataHome() {
  const explicit = (process.env.ANTIGRAVITY_DATA_DIR || '').trim()
  if (explicit) return explicit
  return path.join(os.homedir(), '.gemini', 'antigravity')
}

function snapshotDir() {
  const explicit = (process.env.ANTIGRAVITY_SNAPSHOT_DIR || '').trim()
  if (explicit) return explicit
  const cache = (process.env.XDG_CACHE_HOME || '').trim()
  if (cache) return path.join(cache, 'bot-crossing', 'antigravity')
  const home = os.homedir()
  if (home) return path.join(home, '.cache', 'bot-crossing', 'antigravity')
  return path.join(os.tmpdir(), 'bot-crossing-antigravity')
}

const SNAP_DIR = snapshotDir()
const SNAP_MANIFEST = path.join(SNAP_DIR, 'remote-manifest.json')
const SNAP_META = path.join(SNAP_DIR, 'remote-manifest.meta.json')

/**
 * The remote store, pulled over SSH. Operator environment, never the repo:
 * no machine names, LAN IPs, or SSH usernames live in this file.
 */
function remoteConfig() {
  const target = (process.env.ANTIGRAVITY_SSH_TARGET || '').trim()
  if (!target) return null
  if (!/^[^@\s]+@[^@\s:]+$/.test(target)) {
    warnThrottled('target', `ignoring malformed snapshot SSH target (${target.length} chars)`)
    return null
  }
  const remotePath = (process.env.ANTIGRAVITY_REMOTE_PATH || '.gemini/antigravity').trim()
  if (!/^[A-Za-z0-9._/\\:-]+$/.test(remotePath) || remotePath.includes('..')) {
    warnThrottled('path', 'ignoring unsafe ANTIGRAVITY_REMOTE_PATH')
    return null
  }
  return { target, remotePath }
}

/* ------------------------------------------------------- throttled warns */

/**
 * The UI polls /api/threads every few seconds; an unreachable remote must not
 * spam the journal on every poll. One line per key per minute is enough.
 */
const lastWarnAt = new Map()
function warnThrottled(key, msg) {
  const now = Date.now()
  if (now - (lastWarnAt.get(key) || 0) < 60 * 1000) return
  lastWarnAt.set(key, now)
  console.warn(`bot-crossing: antigravity ${msg}`)
}

/* ------------------------------------------------- descriptor-free proto */

/**
 * Minimal protobuf walker: varint tags + length-delimited fields only (all
 * this index uses). Returns [fieldNumber, value] with value a number for
 * varints or a Buffer for embedded bytes. Unknown wire types throw, and the
 * caller treats that as "shape changed" and falls back — never as fatal.
 */
function readVarint(buf, off) {
  let v = 0n
  let shift = 0n
  for (let i = off; i < buf.length && i - off < 10; i++) {
    const c = BigInt(buf[i])
    v |= (c & 0x7fn) << shift
    if (!(c & 0x80n)) return { v: Number(v), next: i + 1 }
    shift += 7n
  }
  throw new Error('bad varint')
}

function protoFields(buf) {
  const out = []
  let o = 0
  while (o < buf.length) {
    const t = readVarint(buf, o)
    o = t.next
    const field = t.v >>> 3
    const wire = t.v & 7
    if (wire === 0) {
      const q = readVarint(buf, o)
      o = q.next
      out.push([field, q.v])
    } else if (wire === 2) {
      const q = readVarint(buf, o)
      o = q.next
      out.push([field, buf.subarray(o, o + q.v)])
      o += q.v
    } else {
      throw new Error(`unexpected wire type ${wire}`)
    }
  }
  return out
}

const utf8 = (b) => globalThis.Buffer.from(b).toString('utf8')
const isText = (b) => b.length > 0 && b.length <= 400 && [...b].every((c) => c >= 32 && c < 127)

/** First short printable string in a message's field n, else ''. */
function fieldStr(msg, n) {
  for (const [f, v] of protoFields(msg)) {
    if (f === n && typeof v !== 'number' && isText(v)) return utf8(v)
  }
  return ''
}

/** All embedded messages in a message's field n. */
function fieldMsgs(msg, n) {
  const out = []
  for (const [f, v] of protoFields(msg)) {
    if (f === n && typeof v !== 'number') out.push(v)
  }
  return out
}

/** {seconds, nanos} pair message -> epoch ms, 0 when implausible. */
function msgTimestamp(msg) {
  let seconds = 0
  let nanos = 0
  try {
    for (const [f, v] of protoFields(msg)) {
      if (typeof v !== 'number') continue
      if (f === 1) seconds = v
      else if (f === 2) nanos = v
    }
  } catch {
    return 0
  }
  if (seconds < 1_000_000_000 || seconds > 4_000_000_000) return 0
  const ms = seconds * 1000 + Math.floor(nanos / 1e6)
  if (ms > Date.now() + 3600 * 1000) return 0 // unlabeled block: never from the future
  return ms
}

/**
 * The summary index, verified against a live file (fields below are what the
 * app actually ships; anything else is ignored):
 *   record = { 1: conversation uuid, 2: info }
 *   info   = { 1: display title, 9: { 1,2: workspace file:// URI, 4: branch },
 *              17: { 1: { 1,2: workspace, 4: branch }, 7: workspace,
 *                     8: { 1: agent id, 2: agent display name }, 4: agent id },
 *              3/7/10/15.7: timestamp pairs }
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function parseSummaryIndex(bytes) {
  const index = new Map()
  let records = []
  try {
    records = fieldMsgs(bytes, 1)
  } catch {
    return index
  }
  for (const rec of records) {
    let uuid = ''
    let info = null
    try {
      for (const [f, v] of protoFields(rec)) {
        if (f === 1 && typeof v !== 'number' && isText(v) && UUID_RE.test(utf8(v))) uuid = utf8(v)
        else if (f === 2 && typeof v !== 'number') info = v
      }
    } catch {
      continue
    }
    if (!uuid || !info) continue
    const entry = { title: '', workspace: '', branch: '', agent: '', updatedAt: 0 }
    try {
      entry.title = fieldStr(info, 1)
      for (const w of fieldMsgs(info, 9)) {
        entry.workspace = entry.workspace || fieldStr(w, 1) || fieldStr(w, 2)
        entry.branch = entry.branch || fieldStr(w, 4)
      }
      for (const s17 of fieldMsgs(info, 17)) {
        for (const w1 of fieldMsgs(s17, 1)) {
          entry.workspace = entry.workspace || fieldStr(w1, 1) || fieldStr(w1, 2)
          entry.branch = entry.branch || fieldStr(w1, 4)
        }
        entry.workspace = entry.workspace || fieldStr(s17, 7)
        for (const a8 of fieldMsgs(s17, 8)) {
          entry.agent = entry.agent || fieldStr(a8, 2) || fieldStr(a8, 1)
        }
        entry.agent = entry.agent || fieldStr(s17, 4)
        for (const t2 of fieldMsgs(s17, 2)) {
          const t = msgTimestamp(t2)
          if (t > entry.updatedAt) entry.updatedAt = t
        }
      }
      for (const n of [3, 7, 10]) {
        for (const tmsg of fieldMsgs(info, n)) {
          const t = msgTimestamp(tmsg)
          if (t > entry.updatedAt) entry.updatedAt = t
        }
      }
      for (const m15 of fieldMsgs(info, 15)) {
        for (const tmsg of fieldMsgs(m15, 7)) {
          const t = msgTimestamp(tmsg)
          if (t > entry.updatedAt) entry.updatedAt = t
        }
      }
    } catch {
      /* new shape — keep whatever was extracted before it */
    }
    index.set(uuid, entry)
  }
  return index
}

/* ------------------------------------------------------- small-file reads */

/**
 * annotations/<uuid>.pbtxt — e.g.
 *   title:"Fix the login redirect"
 *   last_user_view_time:{seconds:1788204050 nanos:530000000}
 *   pinned:false
 * title is optional; view time is the last-focused signal.
 */
function parseAnnotation(text) {
  let title = ''
  let viewed = 0
  try {
    const tm = /title:\s*"((?:[^"\\]|\\.)*)"/.exec(text)
    if (tm) title = tm[1].replace(/\\(.)/g, '$1')
    const vm = /last_user_view_time:\s*\{\s*seconds:\s*(\d+)/.exec(text)
    if (vm) viewed = num(vm[1]) * 1000
  } catch {
    /* malformed — title stays '', viewed stays 0 */
  }
  return { title, viewed }
}

/** Strip the <TAG>...</TAG> wrappers the app puts around prompts. */
function cleanPrompt(s) {
  return String(s)
    .replace(/<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Line 0 of transcript_full.jsonl:
 * {"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT",
 *  "status":"DONE","created_at":"2026-09-03T15:43:27Z","content":"<USER_REQUEST>\n..."}
 * Full-parse when intact, regex fallback on a truncated head — either way the
 * created_at sits at the START of the line, so even a capped head yields it.
 */
function parseTranscriptHead(line) {
  let createdAt = 0
  let content = ''
  if (line) {
    try {
      const obj = JSON.parse(line)
      if (obj && typeof obj === 'object') {
        if (obj.created_at) {
          const t = Date.parse(obj.created_at)
          if (Number.isFinite(t)) createdAt = t
        }
        if (typeof obj.content === 'string') content = obj.content
      }
    } catch {
      /* truncated or mid-write head — regex fallback below */
    }
    if (!createdAt) {
      const m = /"created_at"\s*:\s*"([^"]+)"/.exec(line)
      if (m) {
        const t = Date.parse(m[1])
        if (Number.isFinite(t)) createdAt = t
      }
    }
    if (!content) {
      const m = /"content"\s*:\s*"((?:[^"\\]|\\.){0,2000})/.exec(line)
      if (m) {
        try {
          content = JSON.parse(`"${m[1]}"`)
        } catch {
          // Truncated head: unescape what we can (newline/quote/backslash),
          // trading a rare literal-backslash edge for readable previews.
          content = m[1]
            .replace(/\\n/g, ' ')
            .replace(/\\r/g, ' ')
            .replace(/\\t/g, ' ')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\')
        }
      }
    }
  }
  // The app wraps the actual prompt in <USER_REQUEST>...</USER_REQUEST>,
  // followed by metadata/settings blocks. The request is the preview; when
  // the wrapper is absent (older shape), fall back to the whole content.
  // Either way the created_at sits at the START of the line, so even a
  // capped head yields it.
  let prompt = content
  if (content) {
    const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i.exec(content)
    if (m && m[1].trim()) {
      prompt = m[1]
    } else {
      // Capped head cut off before the closing tag: drop the dangling opener.
      prompt = prompt.replace(/^\s*<(USER_REQUEST|ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>\s*/i, '')
    }
  }
  // Opportunistic: the first prompt often records the selected model in a
  // settings-change line ("... Model Selection` from None to Gemini 3.8 Flash
  // (High). ..."). The delimiter needs its trailing space — version dots
  // ("3.8") must not read as the end of the name. Anything else leaves ''.
  let model = ''
  if (line) {
    const m = /Model Selection` from [^`]+? to ([A-Z][^(]{2,60}?)(?: \(|\. |$)/.exec(line)
    if (m) model = m[1].trim()
  }
  return { createdAt, preview: cleanPrompt(prompt).slice(0, 280), model }
}

/**
 * Workspace file:// URI -> { project, projectPath }. Both URI spellings the
 * app ships (file:///d:/... and file:///d%3A/...) converge after decoding;
 * the drive letter is upper-cased so two spellings never split one plot.
 * A bare user home (no branch, no repo) groups under a 'home' project.
 */
function projectOfWorkspace(uri) {
  if (!uri || typeof uri !== 'string') return { project: '', projectPath: '' }
  let p = uri
  try {
    p = decodeURIComponent(uri)
  } catch {
    /* keep raw */
  }
  p = p.replace(/^file:\/\/\//i, '').replace(/\\/g, '/')
  p = p.replace(/^([a-z]):\//, (_, d) => `${d.toUpperCase()}:/`)
  if (/^[A-Za-z]:\/Users\/[^/]+$/.test(p)) return { project: 'home', projectPath: p }
  const segs = p.split('/').filter(Boolean)
  return { project: segs.length ? segs[segs.length - 1] : '', projectPath: p }
}

/* ------------------------------------------------------------ local store */

const HEAD_BYTES = 8192
/** Transcript heads are expensive to re-read, so keep them until the file changes. */
const headCache = new Map()
const annCache = new Map()
let summaryCache = { key: '', index: new Map() }

async function cachedSummaryIndex(home) {
  const file = path.join(home, 'agyhub_summaries_proto.pb')
  let stat = null
  try {
    stat = await fsp.stat(file)
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return new Map()
  } catch {
    return new Map()
  }
  const key = `${stat.mtimeMs}:${stat.size}`
  if (summaryCache.key === key) return summaryCache.index
  let index = new Map()
  try {
    index = parseSummaryIndex(await fsp.readFile(file))
  } catch {
    index = new Map()
  }
  summaryCache = { key, index }
  return index
}

async function cachedAnnotation(file, stat) {
  const key = `${file} ${stat.mtimeMs}:${stat.size}`
  const hit = annCache.get(file)
  if (hit && hit.key === key) return hit.parsed
  let parsed = { title: '', viewed: 0 }
  try {
    if (stat.size <= 64 * 1024) parsed = parseAnnotation(await fsp.readFile(file, 'utf8'))
  } catch {
    /* mid-write — title stays '' */
  }
  if (annCache.size > 2000) annCache.clear()
  annCache.set(file, { key, parsed })
  return parsed
}

async function cachedTranscriptHead(file) {
  let stat = null
  try {
    stat = await fsp.stat(file)
    if (!stat.isFile() || stat.size === 0) return null
  } catch {
    return null
  }
  const key = `${file} ${stat.mtimeMs}:${stat.size}`
  const hit = headCache.get(file)
  if (hit && hit.key === key) return hit.parsed
  let parsed = null
  try {
    const head = await readHead(file, HEAD_BYTES)
    const line = head.split('\n')[0] || ''
    if (line.trim().startsWith('{')) parsed = parseTranscriptHead(line)
  } catch {
    parsed = null
  }
  if (headCache.size > 2000) headCache.clear()
  headCache.set(file, { key, parsed })
  return parsed
}

const txCandidates = (home, uuid) => [
  path.join(home, 'brain', uuid, '.system_generated', 'logs', 'transcript_full.jsonl'),
  path.join(home, 'brain', uuid, '.system_generated', 'logs', 'transcript.jsonl'),
]

async function transcriptHead(home, uuid) {
  for (const file of txCandidates(home, uuid)) {
    const head = await cachedTranscriptHead(file)
    if (head) return head
  }
  return null
}

/**
 * Every uuid the local store knows, keyed by uuid: db stats (stat only — the
 * db itself is never opened, its payloads are descriptor-less protobuf),
 * annotation, summary entry, transcript head. One bad file never fails the
 * pass; annotation-only uuids (no db/brain) are first-class records.
 * Summary-index-only uuids (no db, brain dir, or annotation) are deleted
 * conversations the index retained — pruned, never threads.
 */
async function readLocal(home) {
  const records = new Map()
  const ensure = (uuid) => {
    let r = records.get(uuid)
    if (!r) {
      r = { dbSize: 0, dbMtime: 0, ann: null, sum: null, tx: null }
      records.set(uuid, r)
    }
    return r
  }
  const convDir = path.join(home, 'conversations')
  for (const file of await listFiles(convDir, (n) => n.endsWith('.db'))) {
    const uuid = path.basename(file, '.db')
    if (!UUID_RE.test(uuid)) continue
    try {
      const stat = await fsp.stat(file)
      if (!stat.isFile()) continue
      const r = ensure(uuid)
      r.dbSize = stat.size
      r.dbMtime = Math.floor(stat.mtimeMs)
      try {
        const wst = await fsp.stat(file + '-wal')
        if (wst.isFile() && wst.mtimeMs > r.dbMtime) r.dbMtime = Math.floor(wst.mtimeMs)
      } catch {
        /* fully checkpointed — the db mtime is the recency */
      }
    } catch {
      /* vanished mid-scan — skip */
    }
  }
  const annDir = path.join(home, 'annotations')
  const annFiles = await listFiles(annDir, (n) => n.endsWith('.pbtxt'))
  for (const file of annFiles.slice(0, 2000)) {
    const uuid = path.basename(file, '.pbtxt')
    if (!UUID_RE.test(uuid)) continue
    try {
      const stat = await fsp.stat(file)
      if (!stat.isFile()) continue
      ensure(uuid).ann = await cachedAnnotation(file, stat)
    } catch {
      /* vanished mid-scan — skip */
    }
  }
  const index = await cachedSummaryIndex(home)
  for (const [uuid, entry] of index) {
    if (!UUID_RE.test(uuid)) continue
    ensure(uuid).sum = entry
  }
  for (const uuid of records.keys()) {
    const head = await transcriptHead(home, uuid)
    if (head) records.get(uuid).tx = head
  }
  // The summary index retains entries for deleted conversations, and the app
  // leaves orphan annotation files behind on delete: an annotation-only uuid
  // is a deleted-conversation leftover, not a thread. A real conversation
  // always has a db (created on first user message) or a brain transcript —
  // prune anything with neither so ghosts never reach the colony.
  for (const [uuid, rec] of [...records]) {
    if (!rec.dbSize && !rec.tx) records.delete(uuid)
  }
  return records
}

async function storePresent(home) {
  for (const sub of ['conversations', 'annotations']) {
    try {
      const stat = await fsp.stat(path.join(home, sub))
      if (stat.isDirectory()) return true
    } catch {
      /* next candidate */
    }
  }
  try {
    const stat = await fsp.stat(path.join(home, 'agyhub_summaries_proto.pb'))
    if (stat.isFile()) return true
  } catch {
    /* no store */
  }
  return false
}

/* ------------------------------------------------- remote snapshot pull */

/** Minimum gap between bulk pulls — the store ticks on every app write. */
function pullMinMs() {
  return numEnv('ANTIGRAVITY_PULL_MIN_SECONDS', 180) * 1000
}

function statTTLMs() {
  return numEnv('ANTIGRAVITY_STAT_TTL_SECONDS', 60) * 1000
}

/** PowerShell single-line pass: stats only, no file contents. */
function statScript(rel) {
  const q = rel.replace(/'/g, "''")
  return (
    `$ErrorActionPreference='SilentlyContinue';` +
    `$r=Join-Path $env:USERPROFILE '${q}';` +
    `$d=Get-ChildItem -LiteralPath (Join-Path $r 'conversations') -Filter '*.db' -File;` +
    `$mx=0;$tb=0;foreach ($f in $d){$tb+=$f.Length;if($f.LastWriteTimeUtc.Ticks -gt $mx){$mx=$f.LastWriteTimeUtc.Ticks}};` +
    `$a=Get-ChildItem -LiteralPath (Join-Path $r 'annotations') -Filter '*.pbtxt' -File;` +
    `$am=0;foreach ($f in $a){if($f.LastWriteTimeUtc.Ticks -gt $am){$am=$f.LastWriteTimeUtc.Ticks}};` +
    `$s=Get-Item -LiteralPath (Join-Path $r 'agyhub_summaries_proto.pb');$ss=0;$st=0;` +
    `if($s){$ss=$s.Length;$st=$s.LastWriteTimeUtc.Ticks};` +
    `Write-Output ('SIG|'+@($d).Count+'|'+$tb+'|'+$mx+'|'+@($a).Count+'|'+$ss+'|'+$st+'|'+$am)`
  )
}

/**
 * PowerShell single-line pass: the whole snapshot in one stdout. One remote
 * pass is self-consistent by construction. Base64 throughout so free text
 * (titles, prompts) can never break the line protocol.
 */
function manifestScript(rel) {
  const q = rel.replace(/'/g, "''")
  return (
    `$ErrorActionPreference='SilentlyContinue';` +
    `$r=Join-Path $env:USERPROFILE '${q}';Write-Output 'MANIFEST1';` +
    `$d=Get-ChildItem -LiteralPath (Join-Path $r 'conversations') -Filter '*.db' -File;` +
    `foreach ($f in $d){$w=Get-Item -LiteralPath ($f.FullName+'-wal');$ws=0;if($w){$ws=$w.Length};` +
    `Write-Output ('DB|'+$f.BaseName+'|'+$f.Length+'|'+$f.LastWriteTimeUtc.Ticks+'|'+$ws)};` +
    `$a=Get-ChildItem -LiteralPath (Join-Path $r 'annotations') -Filter '*.pbtxt' -File;` +
    `foreach ($f in $a){$t=Get-Content -LiteralPath $f.FullName -Raw;if(!$t){$t=''};` +
    `Write-Output ('ANN|'+$f.BaseName+'|'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t)))};` +
    `$s=Join-Path $r 'agyhub_summaries_proto.pb';` +
    `Write-Output ('SUM|'+[Convert]::ToBase64String([IO.File]::ReadAllBytes($s)));` +
    `$b=Join-Path $r 'brain';$dirs=Get-ChildItem -LiteralPath $b -Directory;` +
    `foreach ($dd in $dirs){$tp=Join-Path $dd.FullName '.system_generated\\logs\\transcript_full.jsonl';` +
    `$L=Get-Content -LiteralPath $tp -TotalCount 1;if($L){if($L.Length -gt 1500){$L=$L.Substring(0,1500)};` +
    `Write-Output ('TX|'+$dd.Name+'|'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($L)))}};` +
    // The last brain dir with no transcript leaves a failed Get-Content as
    // the final statement, which stdin-mode PowerShell reports as exit 1
    // despite complete output — so pin the exit code explicitly. A genuinely
    // broken script never reaches here and still fails loudly.
    `exit 0`
  )
}

const sshArgs = (cfg) => ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', cfg.target, 'powershell -NoProfile -Command -']

let statCache = { at: 0, sig: '', ok: false }

/**
 * Colony-host stamp of the last successful remote contact (stat success or
 * fresh pull). Survives failed scans so unreachable threads keep a stale
 * lastSeenAt instead of losing it; the persisted pull time covers restarts.
 */
let lastRemoteSeenAt = 0

const remoteHost = () => remoteHostLabel(['ANTIGRAVITY_REMOTE_HOST_LABEL', 'REMOTE_HOST_LABEL'])

function remoteTopology() {
  let metaAt = 0
  try {
    const meta = readRemoteMeta()
    if (meta && Number.isFinite(Number(meta.pulledAt))) metaAt = Number(meta.pulledAt)
  } catch {
    /* no meta yet — stamp stays memory-only */
  }
  return { host: remoteHost(), lastSeenAt: remoteSeenIso(statCache, lastRemoteSeenAt, metaAt) }
}

function remoteStat(cfg, force = false) {
  const now = Date.now()
  if (!force && now - statCache.at < statTTLMs() && statCache.sig) return statCache
  let sig = ''
  let ok = false
  try {
    const out = spawnSync('ssh', sshArgs(cfg), {
      input: statScript(cfg.remotePath),
      encoding: 'utf8',
      timeout: 25000,
      windowsHide: true,
    })
    if (out.status === 0 && out.stdout) {
      for (const line of String(out.stdout).split('\n')) {
        const m = line.replace(/\r/g, '').match(/^SIG\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)$/)
        if (m) {
          sig = m.slice(1).join('|')
          ok = true
        }
      }
    }
  } catch {
    ok = false
  }
  // Cache negatives too (sig '' + ok false still records `at`): an
  // unreachable remote costs one slow scan per STAT_TTL, not one per poll.
  statCache = { at: now, sig: ok ? sig : statCache.sig, ok }
  if (ok) lastRemoteSeenAt = noteRemoteSeen(statCache, lastRemoteSeenAt)
  return statCache
}

/** Ticks (UTC, .NET epoch) -> epoch ms. */
const ticksToMs = (ticks) => Math.floor(num(ticks) / 10000 - 62135596800000)

function parseManifestText(text) {
  const manifest = { dbs: {}, ann: {}, sum: '', tx: {} }
  let marked = false
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r/g, '')
    if (line === 'MANIFEST1') {
      marked = true
      continue
    }
    const pipe = line.indexOf('|')
    if (pipe < 0) continue
    const kind = line.slice(0, pipe)
    const rest = line.slice(pipe + 1)
    try {
      if (kind === 'DB') {
        const [uuid, size, mtime, wal] = rest.split('|')
        if (uuid && UUID_RE.test(uuid)) manifest.dbs[uuid] = { size: num(size), mtime: ticksToMs(mtime), wal: num(wal) }
      } else if (kind === 'ANN') {
        const i = rest.indexOf('|')
        if (i > 0) {
          const uuid = rest.slice(0, i)
          if (UUID_RE.test(uuid)) manifest.ann[uuid] = rest.slice(i + 1)
        }
      } else if (kind === 'SUM') {
        if (/^[A-Za-z0-9+/=]+$/.test(rest.trim()) && rest.length > 100) manifest.sum = rest.trim()
      } else if (kind === 'TX') {
        const i = rest.indexOf('|')
        if (i > 0) {
          const uuid = rest.slice(0, i)
          if (UUID_RE.test(uuid)) manifest.tx[uuid] = rest.slice(i + 1)
        }
      }
    } catch {
      /* one bad line never fails the manifest */
    }
  }
  if (!marked) throw new Error('remote manifest missing marker')
  if (!Object.keys(manifest.dbs).length && !Object.keys(manifest.ann).length && !manifest.sum) {
    throw new Error('remote manifest empty')
  }
  return manifest
}

const b64utf8 = (b64) => globalThis.Buffer.from(b64, 'base64').toString('utf8')

/** Manifest records into the same shape readLocal() returns. */
function manifestRecords(manifest) {
  const records = new Map()
  const ensure = (uuid) => {
    let r = records.get(uuid)
    if (!r) {
      r = { dbSize: 0, dbMtime: 0, ann: null, sum: null, tx: null }
      records.set(uuid, r)
    }
    return r
  }
  for (const [uuid, db] of Object.entries(manifest.dbs)) {
    const r = ensure(uuid)
    r.dbSize = db.size
    r.dbMtime = db.mtime
  }
  for (const [uuid, b64] of Object.entries(manifest.ann)) {
    try {
      ensure(uuid).ann = parseAnnotation(b64utf8(b64))
    } catch {
      /* skip that annotation */
    }
  }
  if (manifest.sum) {
    try {
      const index = parseSummaryIndex(globalThis.Buffer.from(manifest.sum, 'base64'))
      for (const [uuid, entry] of index) ensure(uuid).sum = entry
    } catch {
      /* summary stays absent — titles fall back */
    }
  }
  for (const [uuid, b64] of Object.entries(manifest.tx)) {
    try {
      const head = parseTranscriptHead(b64utf8(b64))
      if (head.preview || head.createdAt) ensure(uuid).tx = head
    } catch {
      /* skip that head */
    }
  }
  // Same prune as readLocal: annotation-only uuids are deleted-conversation
  // leftovers (the app leaves orphan .pbtxt files behind on delete) — a real
  // conversation always has a db or a brain transcript.
  for (const [uuid, rec] of [...records]) {
    if (!rec.dbSize && !rec.tx) records.delete(uuid)
  }
  return records
}

function readSnapshotFile(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!raw || typeof raw !== 'object' || !raw.manifest) throw new Error('snapshot has no manifest')
  return manifestRecords(raw.manifest)
}

function readRemoteMeta() {
  try {
    const raw = JSON.parse(fs.readFileSync(SNAP_META, 'utf8'))
    if (raw && typeof raw === 'object' && typeof raw.sig === 'string') return raw
  } catch {
    /* no meta yet — first pull */
  }
  return null
}

function snapshotReady(meta, sig) {
  if (!meta || meta.sig !== sig) return false
  try {
    return fs.statSync(SNAP_MANIFEST).isFile()
  } catch {
    return false
  }
}

let pullInFlight = false
let lastPullAttempt = 0

function finishPull(sig, text) {
  pullInFlight = false
  let manifest
  try {
    manifest = parseManifestText(text)
  } catch (err) {
    warnThrottled('pull-parse', `snapshot pull unusable (${err.message}) — keeping previous snapshot`)
    return
  }
  // Verify before publish: the summary must still decode and the records
  // must still build. A mid-write pull that fails here is discarded and the
  // previous snapshot keeps serving until the next window retries.
  try {
    const records = manifestRecords(manifest)
    if (!records.size) throw new Error('no records')
  } catch (err) {
    warnThrottled('pull-verify', `snapshot pull failed verification (${err.message}) — keeping previous snapshot`)
    return
  }
  try {
    fs.mkdirSync(SNAP_DIR, { recursive: true })
    const next = `${SNAP_MANIFEST}.next`
    fs.writeFileSync(next, JSON.stringify({ v: 1, pulledAt: Date.now(), manifest }))
    fs.renameSync(next, SNAP_MANIFEST)
    fs.writeFileSync(SNAP_META, JSON.stringify({ sig, pulledAt: Date.now() }))
    lastRemoteSeenAt = Date.now()
    const n = Object.keys(manifest.dbs).length + Object.keys(manifest.ann).length
    console.warn(`bot-crossing: antigravity snapshot refreshed (${Object.keys(manifest.dbs).length} dbs, ${Object.keys(manifest.ann).length} annotations)`)
    void n
  } catch (err) {
    warnThrottled('pull-swap', `snapshot pull could not go live (${err.message}) — keeping previous snapshot`)
  }
}

/**
 * Start a background manifest pull. Never blocks the scan: the previous
 * snapshot (or local-only, on first run) keeps serving until the new copy
 * verifies and swaps in.
 */
function startBackgroundPull(cfg, sig) {
  if (pullInFlight) return
  const now = Date.now()
  if (now - lastPullAttempt < pullMinMs()) return
  lastPullAttempt = now
  pullInFlight = true
  let child
  try {
    child = spawn('ssh', sshArgs(cfg), { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  } catch (err) {
    pullInFlight = false
    warnThrottled('pull-spawn', `snapshot pull could not start (${err.message})`)
    return
  }
  let text = ''
  let tooBig = false
  try {
    child.stdin.write(manifestScript(cfg.remotePath))
    child.stdin.end()
  } catch {
    pullInFlight = false
    try {
      child.kill()
    } catch {
      /* already gone */
    }
    return
  }
  const timer = setTimeout(() => {
    tooBig = true
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }, 120000)
  child.stdout.on('data', (chunk) => {
    if (tooBig) return
    text += chunk.toString('utf8')
    if (text.length > 32 * 1024 * 1024) {
      tooBig = true
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }
  })
  child.on('error', () => {
    clearTimeout(timer)
    pullInFlight = false
  })
  child.on('close', (code) => {
    clearTimeout(timer)
    // The manifest verifies before publish, so a nonzero exit with complete
    // output still lands (Windows stdin-mode exit codes are flaky — see the
    // `exit 0` note on manifestScript). Only an empty or truncated pull fails.
    if (tooBig || !text) {
      pullInFlight = false
      if (!tooBig) warnThrottled('pull-ssh', 'snapshot pull failed (remote busy) — keeping previous snapshot')
      return
    }
    if (code !== 0) warnThrottled('pull-code', `snapshot pull exited ${code} with output — verifying anyway`)
    finishPull(sig, text)
  })
}

/**
 * Local path of the remote snapshot manifest, or '' when there is nothing
 * usable. Kicks off a background refresh when stale — the scan uses whatever
 * is on disk meanwhile, so a down remote degrades to the last snapshot
 * instead of breaking the scan.
 */
function ensureRemoteSnapshot() {
  const cfg = remoteConfig()
  if (!cfg) return ''
  let stat
  try {
    stat = remoteStat(cfg)
  } catch {
    stat = { ok: false, sig: '' }
  }
  const meta = readRemoteMeta()
  if (stat.ok && stat.sig) {
    if (snapshotReady(meta, stat.sig)) return SNAP_MANIFEST
    startBackgroundPull(cfg, stat.sig)
    // Stale-but-present snapshot still serves while the refresh flies.
    try {
      if (fs.statSync(SNAP_MANIFEST).isFile()) return SNAP_MANIFEST
    } catch {
      /* first pull still running — local-only this scan */
    }
    return ''
  }
  // Remote unreachable: last snapshot stands in, whatever its age.
  if (meta) {
    try {
      if (fs.statSync(SNAP_MANIFEST).isFile()) return SNAP_MANIFEST
    } catch {
      /* snapshot vanished — nothing to serve */
    }
  }
  return ''
}

/* ---------------------------------------------------------- merge + scan */

/** Updated within this window counts as working right now. */
const RECENT_WINDOW_MS = 5 * 60 * 1000

function toThread(uuid, rec, remote) {
  const sum = rec.sum || {}
  const ann = rec.ann || {}
  const tx = rec.tx || {}
  const title = sum.title || ann.title || tx.preview || 'Untitled thread'
  const { project, projectPath } = projectOfWorkspace(sum.workspace || '')
  const createdAt = num(tx.createdAt) || num(sum.updatedAt) || num(rec.dbMtime)
  const lastActivityAt = Math.max(num(rec.dbMtime), num(ann.viewed), num(sum.updatedAt), num(tx.createdAt))
  return {
    id: `antigravity:${uuid}`,
    title,
    preview: tx.preview || '',
    project: project || 'unknown',
    projectPath,
    worktree: '',
    cwd: projectPath,
    gitBranch: sum.branch || '',
    model: tx.model || '',
    effort: '',
    createdAt,
    lastActivityAt,
    lastFocusedAt: num(ann.viewed),
    running: Date.now() - lastActivityAt < RECENT_WINDOW_MS,
    unread: false,
    hasError: false,
    archived: false,
    sizeBytes: num(rec.dbSize) || 500,
    source: rec.dbSize ? (remote ? 'db-remote' : 'db') : 'annotation-only',
    canOpen: false,
    canArchive: false,
    ref: { conversationId: uuid, via: remote ? 'snapshot' : 'local' },
  }
}

async function detect() {
  if (remoteConfig()) return true
  try {
    return await storePresent(dataHome())
  } catch {
    return false
  }
}

async function scanThreads() {
  const byId = new Map()
  const snapFile = ensureRemoteSnapshot()
  if (snapFile) {
    try {
      for (const [uuid, rec] of readSnapshotFile(snapFile)) byId.set(uuid, { rec, remote: true })
    } catch (err) {
      warnThrottled('remote-scan', `remote snapshot unreadable (${err.message}) — keeping previous on next pull`)
    }
  }
  const home = dataHome()
  try {
    if (await storePresent(home)) {
      for (const [uuid, rec] of await readLocal(home)) byId.set(uuid, { rec, remote: false })
    }
  } catch (err) {
    warnThrottled('local-scan', `local store unreadable (${err.message})`)
  }
  if (!byId.size) {
    if (!remoteConfig() && !(await storePresent(home))) {
      throw new Error('No Antigravity store found (set ANTIGRAVITY_SSH_TARGET or ANTIGRAVITY_DATA_DIR)')
    }
    throw new Error('No Antigravity store readable right now')
  }
  // Remote threads carry the shared topology fields; local threads stay
  // exactly as today (no host/lastSeenAt/remote keys at all).
  const topology = remoteTopology()
  return [...byId].map(([uuid, { rec, remote }]) => {
    const thread = toThread(uuid, rec, remote)
    return remote ? withRemoteTopology(thread, topology) : thread
  })
}

/* ---------------------------------------------------------------- actions */

function openThread() {
  return { ok: false, error: 'Antigravity threads open in the desktop app — no link scheme verified yet.' }
}

function newSession() {
  return { ok: false, error: 'Antigravity sessions start in the desktop app, not from the colony.' }
}

async function setArchived() {
  return { ok: false, error: 'Antigravity has no archive concept — the colony keeps its own archive mark.' }
}

export default {
  id: 'antigravity',
  name: 'Antigravity',
  detect,
  scanThreads,
  openThread,
  newSession,
  setArchived,
}
