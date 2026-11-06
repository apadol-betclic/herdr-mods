// Uncommitted changes (or, "vs develop", everything since the branch left origin/develop) as a tab, laid out like GitHub's "Files changed": the files as a tree on
// the left, every file's diff stacked on the right. All files start open; "Viewed" folds one
// until its diff changes again (data/my-changes/viewed.json, by repo, path and a hash of the
// diff). .dart and .json are colored as VSCode colors them (./syntax.js).
// Review: click or drag over lines (shift-click extends) to comment on them; comments wait in
// data/my-changes/review.json until "Submit review" sends them all at once to this space's agent.
// The tree's checkboxes stage files (git's own index); Commit takes the staged files when there are
// any, else everything. Each file header opens the repo in Zed at that file.
// Opened by my-tabs as `tab.new {mod: "my-changes", props: {space}}`: it shows that space's repo.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { spaces, panes, agents, props, exec, hc, readTextFile, watchFolder, theme, settings, appHome, nextCommand } from "herdr";
import * as fs from "fs/promises";
import { palette, languageOf, highlight } from "./syntax.js";

function mySpace() {
  const id = props()?.space;
  return spaces().find((s) => s.id === id) ?? spaces().find((s) => s.active);
}
// Its space's repo: where that space's first terminal is now.
function location() {
  const space = mySpace();
  const tabs = new Set((space?.tabs ?? []).map((t) => t.id));
  const cwd = panes().find((p) => tabs.has(p.tab) && p.terminal && p.cwd)?.cwd || space?.folder;
  return { cwd, on: space?.machine ?? null };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "-c", "core.quotePath=false"];
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_LINES = 3000; // per file
const IGNORED = /\/(\.git|\.dart_tool|build|\.idea|node_modules|\.gradle|Pods|\.fvm)(\/|$)/;
const MIN_GAP = 3000; // between two refreshes
// "vs develop" compares with the first of these that exists.
const BASES = ["origin/develop", "develop"];
const DATA = () => `${appHome()}/data/my-changes`;

// GitHub's diff colors, dark and light.
const GITHUB = {
  dark: { add: "#2ea04326", addNumber: "#3fb9504d", del: "#f851491a", delNumber: "#f851494d", hunk: "#388bfd1a", hunkNumber: "#388bfd33", added: "#3fb950", deleted: "#f85149", viewed: "#1f6feb", selected: "#bb800933", selectedNumber: "#bb800966" },
  light: { add: "#e6ffec", addNumber: "#ccffd8", del: "#ffebe9", delNumber: "#ffd7d5", hunk: "#ddf4ff", hunkNumber: "#b6e3ff", added: "#1a7f37", deleted: "#d1242f", viewed: "#0969da", selected: "#fff8c5", selectedNumber: "#fae17d" },
};

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

// `git diff` output, split by file. No renames, so a header is "diff --git a/X b/X".
function splitDiff(text) {
  const files = new Map();
  let cur = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git a/")) {
      const path = line.slice(13, 13 + (line.length - 16) / 2);
      cur = { lines: [], binary: false, started: false };
      files.set(path, cur);
    } else if (!cur) continue;
    else if (cur.started) cur.lines.push(line);
    else if (line.startsWith("@@")) { cur.started = true; cur.lines.push(line); }
    else if (line.startsWith("Binary files")) cur.binary = true;
  }
  for (const f of files.values()) while (f.lines.length && f.lines.at(-1) === "") f.lines.pop();
  return files;
}

// A file's diff as rows with line numbers. Colors come later, only for rows on screen (tokens()).
function diffRows(lines) {
  const rows = [];
  let old = 0, next = 0;
  for (const raw of lines.slice(0, MAX_LINES)) {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (match) { old = +match[1]; next = +match[2]; rows.push({ type: "hunk", text: raw }); continue; }
    const kind = raw[0], text = raw.slice(1).replace(/\t/g, "    ");
    if (kind === "\\") { rows.push({ type: "meta", text: raw.slice(2) }); continue; }
    if (kind === "+") rows.push({ type: "line", kind, nu: next++, text });
    else if (kind === "-") rows.push({ type: "line", kind, old: old++, text });
    else rows.push({ type: "line", kind: " ", old: old++, nu: next++, text });
  }
  if (lines.length > MAX_LINES) rows.push({ type: "meta", text: `${lines.length - MAX_LINES} more lines not shown` });
  return rows;
}

// Where a diff line is, in words an agent can find: the new file's line, or the old one's if removed.
const lineRef = (r) => (r.kind === "-" ? { side: "old", n: r.old } : { side: "new", n: r.nu });
const sameRef = (r, ref) => r.type === "line" && (ref.side === "old" ? r.kind === "-" && r.old === ref.n : r.kind !== "-" && r.nu === ref.n);
function rangeLabel(a, b) {
  const name = a.side === "old" && b.side === "old" ? "old line" : "line";
  return a.n === b.n && a.side === b.side ? `${name} ${a.n}` : `${name}s ${a.n}–${b.n}`;
}

const ROW = { file: 46, hunk: 26, line: 20, meta: 22, end: 8 };
const HEAD = 38; // a file header's bar: its row less the gap above it
const CODE_INDENT = 116; // two number columns and the +/- column
const RIGHT = 44 * 3 + 64 + 90 + 8 * 4; // a file header's counts, diffstat, Zed button and Viewed box

async function readJson(path) {
  try { return JSON.parse(await fs.readFile(path, "utf8")); } catch { return {}; }
}
function writeJson(name, value) {
  fs.mkdir(DATA(), { recursive: true }).then(() => fs.writeFile(`${DATA()}/${name}`, JSON.stringify(value))).catch(() => {});
}

export default class Changes extends View {
  init(_props, cx) {
    this.files = []; this.order = []; this.rows = []; this.treeRows = []; this.headerAt = {};
    this.message = ""; this.handle = cx.focus_handle();
    this.folded = new Set(); // paths folded by hand, not viewed
    this.treeFolded = new Set();
    this.viewed = {}; // "<root>\n<path>" -> hash of the diff when marked
    this.reviews = {}; // root -> [{ id, path, from, to, code, text }]
    this.sel = null; // { path, a, b }: indexes into that file's rows
    this.editing = null; // the comment's id being edited
    this.showTree = true;
    this.mode = localStorage.getItem("mode") === "branch" ? "branch" : "local";
    // The diff scrolls by hand, not in a virtual list: rows then take handlers of their own (a drag
    // over lines needs them) and the pointer's y maps to a row exactly. Only rows on screen are drawn.
    this.offset = 0; this.viewH = 600; this.tops = [0]; this.total = 0;
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.draft = TextareaState.new({ placeholder: "Leave a comment for the agent", rows: 3 });
    this.draft.set_auto_grow(3, 10);
    this.draft.on("change", (_e, cx) => {
      const had = Boolean(this.draftText?.trim());
      this.draftText = this.draft.value();
      if (had !== Boolean(this.draftText.trim())) cx.notify();
    });
    this.draft.on("submit", (e, cx) => { if (e.secondary) this.saveComment(cx); });
    cx.spawn(async (cx) => {
      this.viewed = await readJson(`${DATA()}/viewed.json`);
      this.reviews = await readJson(`${DATA()}/review.json`);
      this.layout(); cx.notify();
    });
    this.stagePending = new Map(); this.stageQueue = []; this.stageGen = 0;
    this.focusPath = null; // a file clicked last; scrolling hands focus back to the one at the top
    cx.spawn(async () => { for (;;) if ((await nextCommand()) === "focus") this.handle.focus(); });
    this.refresh(cx);
    cx.timer.every(30000, (cx) => this.refresh(cx));
    // While loading: show which step it's on, and if a refresh never comes back (the runtime
    // can stop a task midway), give up on it and start again rather than load forever.
    cx.timer.every(1000, (cx) => {
      if (!this.loading) return;
      if (Date.now() - this.loadingSince > 60000) { this.loading = false; this.run = null; this.note = `Refresh stalled at "${this.step}", retrying`; this.refresh(cx); }
      if (this.shownStep !== this.step) { this.shownStep = this.step; cx.notify(); }
    });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          const changed = await watchFolder(root);
          // Tools write under these all the time (the Dart analyzer, builds); none of it is a change to review.
          if (!changed.some((p) => !IGNORED.test(p))) continue;
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.busy) return;
    // A change during a refresh: one more once it's done.
    if (this.loading) { this.again = true; return; }
    // Changes come in bursts: at most one refresh every MIN_GAP, the last one always runs.
    const wait = (this.lastDone ?? 0) + MIN_GAP - Date.now();
    if (wait > 0 && this.context === this.ctx()) {
      if (!this.queued) { this.queued = true; cx.timer.after(wait, (cx) => { this.queued = false; this.refresh(cx); }); }
      return;
    }
    const { cwd, on } = location(), context = this.ctx();
    if (context !== this.context) {
      // Another mode of the same repo keeps the commit message.
      const moved = this.place !== key();
      this.context = context; this.place = key(); this.root = null; this.files = []; this.order = []; this.rows = []; this.treeRows = []; this.sel = null; this.sig = null;
      this.error = null; this.note = null; this.watched = null; this.limited = false; this.offset = 0;
      if (moved) { this.message = ""; this.input.set_value(""); }
    }
    if (!cwd) return;
    this.loading = true; this.loadingSince = Date.now(); this.step = "git rev-parse";
    const run = (this.run = {}), stageGen = this.stageGen;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (this.ctx() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.layout(); this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const branch = this.mode === "branch";
        this.step = "git status";
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        // Commits a push sends: past the upstream, or (no upstream yet) on no remote at all.
        let ahead = 0, upstream = null;
        if (!branch && head.code === 0) {
          const up = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
          upstream = up.code === 0 ? up.stdout.trim() : null;
          const count = await git(upstream ? ["rev-list", "--count", "@{u}..HEAD"] : ["rev-list", "--count", "HEAD", "--not", "--remotes"]);
          ahead = count.code === 0 ? Number(count.stdout.trim()) || 0 : 0;
        }
        let from = head.code === 0 ? "HEAD" : EMPTY_TREE;
        if (branch) {
          // Where this branch left develop: the PR's base, so develop's newer commits don't show.
          this.step = "git merge-base";
          let ref = null;
          for (const r of BASES) if ((await git(["rev-parse", "--verify", "--quiet", r])).code === 0) { ref = r; break; }
          if (!ref) throw new Error(`No ${BASES.join(" or ")} branch in this repository`);
          const base = await git(["merge-base", "HEAD", ref]);
          if (base.code !== 0) throw new Error((base.stderr || `No common commit with ${ref}`).trim());
          from = base.stdout.trim(); this.baseRef = ref;
        }
        this.step = "git diff";
        const diff = await git(["diff", from, "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames"]);
        if (diff.code !== 0) throw new Error(diff.stderr);
        this.step = "reading the diff";
        const diffs = splitDiff(diff.stdout);
        let entries = status.stdout.split("\0").filter(Boolean);
        if (branch) {
          // Committed and uncommitted changes since the base, and the new files git doesn't track yet.
          const names = await git(["diff", "--name-status", "-z", "--no-renames", from]);
          if (names.code !== 0) throw new Error(names.stderr);
          const parts = names.stdout.split("\0").filter(Boolean), list = [];
          for (let i = 0; i + 1 < parts.length; i += 2) list.push(`${parts[i][0] === "U" ? "UU" : parts[i][0] + " "} ${parts[i + 1]}`);
          entries = [...list, ...entries.filter((e) => e.startsWith("??"))];
        }
        const files = [], index = new Map();
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          // Index column: staged; a worktree column too: only part of it is.
          const staged = !branch && !fresh && !conflict && xy[0] !== " ", partial = staged && xy[1] !== " ";
          let lines = diffs.get(path)?.lines ?? [], note = diffs.get(path)?.binary ? "Binary file changed" : null;
          if (fresh) {
            const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
            if (text === null) note = "Cannot preview this file (binary, too large, or unreadable)";
            else if (text.includes("\0")) note = "Binary file";
            else if (text) {
              const body = text.replace(/\n$/, "").split("\n");
              lines = [`@@ -0,0 +1,${body.length} @@`, ...body.map((l) => `+${l}`)];
            }
          }
          if (!lines.length && !note) note = s === "D" ? "File deleted" : "No text changes";
          let add = 0, del = 0;
          for (const l of lines) { if (l[0] === "+") add++; else if (l[0] === "-") del++; }
          const old = this.files.find((f) => f.path === path);
          const h = hash(lines.join("\n") + (note ?? ""));
          // Same diff as before: keep its rows and the colors already worked out.
          const f = old && old.hash === h ? old : { path, status: s, add, del, note, hash: h, rows: diffRows(lines.map((l) => (l.length > 2000 ? l.slice(0, 2000) : l))), language: languageOf(path) };
          index.set(f, { staged, partial });
          files.push(f);
          // The runtime stops a task that computes too long without yielding.
          await cx.sleep(0);
        }
        if (this.ctx() !== context || this.run !== run) return;
        // A file staged or unstaged while this ran: git status may predate it, so its flags stay as
        // the checkbox shows them, and one more refresh follows.
        const raced = this.stageGen !== stageGen;
        if (raced) this.again = true;
        for (const f of files) {
          const shown = this.stagePending.get(f.path) ?? (raced ? this.files.find((o) => o.path === f.path) : null);
          Object.assign(f, shown ? { staged: shown.staged, partial: shown.partial } : index.get(f));
        }
        const cleared = Boolean(this.note?.startsWith("Refresh stalled"));
        if (cleared) this.note = null;
        const sig = files.map((f) => `${f.path}:${f.hash}:${f.staged}:${f.partial}`).join("\n") + `\n${ahead}:${upstream}`;
        this.ahead = ahead; this.upstream = upstream;
        // Nothing changed: no redraw (each one repaints the whole window), unless the note went.
        if (sig === this.sig && root === this.root) { this.quiet = !cleared; return; }
        this.sig = sig;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.files = files; this.limited = entries.length > 1000; this.error = null;
        // A selection on a file whose diff changed would point at other lines.
        if (this.sel && !files.includes(this.selFile)) this.sel = null;
        this.forgetStale();
        this.layout();
        this.watch(root, cx);
        this.colorize(cx);
      } catch (e) { if (this.ctx() === context) this.error = String(e); }
      finally {
        if (this.run === run) {
          this.loading = false; this.lastDone = Date.now();
          if (!this.quiet) cx.notify();
          this.quiet = false;
          if (this.again) { this.again = false; this.refresh(cx); }
        }
      }
    });
  }

  ctx() { return `${key()}\n${this.mode}`; }
  // Viewed marks are per mode: one file's diff differs between them.
  viewedPrefix() { return this.mode === "branch" ? `${this.root}\nbranch\n` : `${this.root}\n`; }
  viewedKey(f) { return this.viewedPrefix() + f.path; }
  isViewed(f) { return this.viewed[this.viewedKey(f)] === f.hash; }
  comments() { return this.reviews[this.root] ?? []; }

  // A viewed mark whose file changed (or has no changes left) is dismissed.
  forgetStale() {
    const live = new Map(this.files.map((f) => [this.viewedKey(f), f.hash]));
    let dirty = false;
    for (const [k, h] of Object.entries(this.viewed)) {
      const mine = k.startsWith(this.viewedPrefix()) && (this.mode === "branch" || !k.startsWith(`${this.root}\nbranch\n`));
      if (!mine || live.get(k) === h) continue;
      delete this.viewed[k]; dirty = true;
    }
    if (dirty) writeJson("viewed.json", this.viewed);
  }

  toggleViewed(f) {
    const k = this.viewedKey(f);
    if (this.isViewed(f)) { delete this.viewed[k]; this.folded.delete(f.path); }
    else { this.viewed[k] = f.hash; if (this.sel?.path === f.path) this.sel = null; }
    writeJson("viewed.json", this.viewed);
    this.layout();
  }

  // The tree, folders first, single-child folders joined ("lib/src"); and the files in that order.
  tree() {
    const top = { dirs: new Map(), files: [] };
    for (const f of this.files) {
      const parts = f.path.split("/"), name = parts.pop();
      let node = top;
      for (const p of parts) { if (!node.dirs.has(p)) node.dirs.set(p, { dirs: new Map(), files: [] }); node = node.dirs.get(p); }
      node.files.push({ name, f });
    }
    const rows = [], order = [];
    const walk = (node, depth, prefix, shown) => {
      for (const [name, dir] of [...node.dirs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        let label = name, n = dir, full = prefix + name;
        while (!n.files.length && n.dirs.size === 1) { const [[k, v]] = [...n.dirs]; label += `/${k}`; full += `/${k}`; n = v; }
        if (shown) rows.push({ dir: true, label, depth, full });
        walk(n, depth + 1, `${full}/`, shown && !this.treeFolded.has(full));
      }
      for (const { name, f } of node.files.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        order.push(f);
        if (shown) rows.push({ dir: false, label: name, depth, f });
      }
    };
    walk(top, 0, "", true);
    return { rows, order };
  }

  // The diff list's rows: per file a header, then (unless folded) its hunks and lines with their
  // comments under them, then the card's end.
  layout() {
    const { rows, order } = this.tree();
    this.treeRows = rows; this.order = order;
    this.rows = []; this.headerAt = {};
    const comments = this.comments();
    for (const f of order) {
      const folded = this.isViewed(f) || this.folded.has(f.path);
      const mine = comments.filter((c) => c.path === f.path);
      this.headerAt[f.path] = this.rows.length;
      this.rows.push({ type: "file", f, folded, count: mine.length });
      if (folded) continue;
      // A comment sits under its last line; one whose line is gone sits at the top, marked outdated.
      const at = new Map(mine.map((c) => [c.id, f.rows.findIndex((r) => sameRef(r, c.to))]));
      for (const c of mine) if (at.get(c.id) < 0) this.rows.push({ type: "comment", f, c, outdated: true });
      if (f.note && !f.rows.length) this.rows.push({ type: "meta", text: f.note, f });
      for (let i = 0; i < f.rows.length; i++) {
        this.rows.push({ ...f.rows[i], f, i });
        for (const c of mine) if (at.get(c.id) === i) this.rows.push({ type: "comment", f, c });
      }
      this.rows.push({ type: "end", f });
    }
    for (const r of this.rows) if (r.type === "comment") r.height = this.commentHeight(r.c);
    this.tops = [0];
    for (const r of this.rows) this.tops.push(this.tops.at(-1) + (r.height ?? ROW[r.type]));
    this.total = this.tops.at(-1) + 16;
    this.scrollTo(this.offset);
  }

  // The row at y px down the diff, or -1.
  rowAt(y) {
    let lo = 0, hi = this.rows.length - 1;
    if (hi < 0 || y < 0 || y >= this.tops.at(-1)) return -1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.tops[mid] <= y) lo = mid; else hi = mid - 1; }
    return lo;
  }

  scrollTo(y) {
    const next = Math.max(0, Math.min(y, this.total - this.viewH));
    if (next === this.offset) return false;
    this.offset = next;
    return true;
  }

  // A comment card's height: its text wrapped at the diff's width, roughly 7.3 px a character.
  commentHeight(c) {
    const perLine = Math.max(20, Math.floor((this.rowWidth() - CODE_INDENT - 40) / 7.3));
    const lines = c.text.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
    return 58 + 18 * lines;
  }

  rowKey(r) {
    return r.type === "comment" ? `c|${r.c.id}` : `${r.type}|${r.i ?? ""}|${r.f.path}`;
  }

  // Colors every file's lines in the background, a slice at a time, each side of the diff keeping
  // its own state so a block comment or a multi-line string carries on correctly. Rows not
  // colored yet draw as plain text: render never does this work.
  colorize(cx) {
    const run = (this.coloring = {}), files = this.order.filter((f) => f.language && !f.colored);
    if (!files.length) return;
    cx.spawn(async (cx) => {
      for (const f of files) {
        let old = null, now = null, n = 0;
        for (const r of f.rows) {
          if (this.coloring !== run) return;
          if (r.type === "hunk") { old = now = null; continue; }
          if (r.type !== "line") continue;
          const h = highlight(f.language, r.text, r.kind === "-" ? old : now);
          if (r.kind === "-") old = h.state;
          else if (r.kind === "+") now = h.state;
          else old = now = h.state;
          r.tokens = h.tokens;
          if (++n % 150 === 0) await cx.sleep(0);
        }
        f.colored = true;
        await cx.sleep(0);
      }
      // One redraw at the end: every redraw paints the whole window.
      if (this.coloring === run) cx.notify();
    });
  }

  // Rows get the diff area's width in px. The area reports its size zoomed, while sizes given to
  // elements are zoomed again, so it's divided back by the zoom.
  rowWidth() { return Math.max(320, Math.floor((this.diffWidth ?? 900) / (this.zoom ?? 1)) - 32); }

  jump(f, cx) {
    if (this.headerAt[f.path] === undefined) return;
    this.scrollTo(this.tops[this.headerAt[f.path]]);
    this.focusPath = f.path;
    cx.notify();
  }

  // The checkbox flips at once; git runs behind it, one file at a time (git locks the index). Staging
  // leaves the diff against HEAD as it is, so no refresh: the outcome of add / restore is known.
  // While git runs the box is dimmed and takes no clicks.
  toggleStage(f, cx) {
    if (!this.root || this.busy || this.stagePending.has(f.path)) return;
    const stage = !f.staged || f.partial;
    const args = stage ? ["add", "-A", "--", f.path]
      : this.hasHead ? ["restore", "--staged", "--", f.path] : ["rm", "--cached", "-q", "--", f.path];
    const before = { staged: f.staged, partial: f.partial }, after = { staged: stage, partial: false };
    this.stagePending.set(f.path, after);
    Object.assign(f, after);
    this.note = null;
    this.stageQueue.push({ path: f.path, args, before, root: this.root, on: this.on });
    if (!this.stageRunning) this.runStageQueue(cx);
    cx.notify();
  }

  runStageQueue(cx) {
    this.stageRunning = true;
    cx.spawn(async (cx) => {
      while (this.stageQueue.length) {
        const job = this.stageQueue.shift();
        let ok = true;
        try {
          const r = await exec("git", job.args, { cwd: job.root, on: job.on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        } catch (e) {
          ok = false;
          this.note = `Couldn't ${job.args[0] === "add" ? "stage" : "unstage"} ${job.path}: ${e}`;
        }
        this.stagePending.delete(job.path);
        this.stageGen++;
        const f = job.root === this.root ? this.files.find((o) => o.path === job.path) : null;
        if (f && !ok) Object.assign(f, job.before);
        cx.notify();
      }
      this.stageRunning = false;
    });
  }

  // Back to HEAD, both staged and unstaged changes; a file HEAD doesn't have is deleted (out of the
  // index too when it was added). Decided from git at the time, not from the list, which can be old.
  discard(f, cx) {
    const root = this.root, on = this.on, path = f.path;
    this.menu = null;
    if (!root || this.busy || this.stagePending.has(path)) return;
    this.note = null;
    cx.spawn(async (cx) => {
      const git = (args) => exec("git", args, { cwd: root, on });
      try {
        let r;
        if ((await git(["cat-file", "-e", `HEAD:${path}`])).code === 0) r = await git(["restore", "--source=HEAD", "--staged", "--worktree", "--", path]);
        else if ((await git(["ls-files", "--error-unmatch", "--", path])).code === 0) r = await git(["rm", "-f", "-q", "--", path]);
        else r = await git(["clean", "-f", "-q", "--", path]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
      } catch (e) {
        this.note = `Couldn't discard ${path}: ${e.message ?? e}`;
      }
      this.refresh(cx);
      cx.notify();
    });
  }

  // A tree file's right-click menu, drawn in the panel where the press was. Discard asks first.
  fileMenu(t, gh) {
    const m = this.menu;
    if (!m || m.pending) return null;
    const f = m.f, name = f.path.split("/").pop(), fresh = f.status === "A";
    const close = (cx) => { this.menu = null; cx.notify(); };
    const item = (id, label, color, action) => div().id(id).h(28).px(10).flex().items_center().rounded(6).cursor_pointer()
      .text_color(color).hover((s) => s.bg(t.hover)).on_click((_e, cx) => action(cx)).child(label);
    const box = v_flex().id("file-menu").absolute().left(m.x).top(m.y).w(m.confirm ? 300 : 200).p(4).rounded(8)
      .bg(t.raised).border_1().border_color(t.border).shadow_lg().text_size(12.5)
      .on_mouse_down_out((_e, cx) => close(cx))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation());
    if (!m.confirm) return box.child(item("menu-discard", fresh ? "Delete file…" : "Discard changes…", gh.deleted, (cx) => { m.confirm = true; cx.notify(); }));
    return box.p(12).gap(10)
      .child(div().font_semibold().text_color(t.foreground).child(fresh ? `Delete ${name}?` : `Discard all changes to ${name}?`))
      .child(div().text_size(12).text_color(t.muted).child(fresh
        ? "It is a new file: discarding deletes it. This can't be undone."
        : "Staged and unstaged changes are lost; the file goes back to the last commit. This can't be undone."))
      .child(h_flex().gap(8).justify_end()
        .child(div().id("discard-cancel").h(28).px(12).flex().items_center().rounded(6).border_1().border_color(t.border).cursor_pointer()
          .text_color(t.foreground).hover((s) => s.bg(t.hover)).on_click((_e, cx) => close(cx)).child("Cancel"))
        .child(div().id("discard-confirm").h(28).px(12).flex().items_center().rounded(6).cursor_pointer()
          .bg(gh.deleted).text_color("#ffffff").font_semibold().on_click((_e, cx) => { this.discard(f, cx); cx.notify(); })
          .child(fresh ? "Delete" : "Discard")));
  }

  // Zed with the repo as its project and this file open, at its first changed line.
  openInZed(f) {
    const first = f.rows.find((r) => r.type === "line" && r.kind === "+") ?? f.rows.find((r) => r.type === "line" && r.nu !== undefined);
    const file = `${this.root}/${f.path}`;
    exec("zed", f.status === "D" ? [this.root] : [this.root, first?.nu ? `${file}:${first.nu}` : file]).catch(() => {});
  }

  toggleFold(f) {
    if (this.isViewed(f)) return;
    this.folded.has(f.path) ? this.folded.delete(f.path) : this.folded.add(f.path);
    this.layout();
  }

  // Selecting lines: a press starts (shift extends, a press on the one selected line clears), moving
  // over lines of the same file extends, the release opens the comment box.
  lineDown(row, e, cx) {
    const path = row.f.path, i = row.i;
    this.focusPath = path;
    if (e.modifiers?.shift && this.sel?.path === path) this.sel = { ...this.sel, b: i };
    else if (this.sel?.path === path && this.sel.a === i && this.sel.b === i) this.sel = null;
    else this.sel = { path, a: i, b: i };
    this.editing = null;
    this.dragging = this.sel ? path : null;
    if (this.sel) this.selFile = row.f;
    cx.notify();
  }

  // Pointer moves over the diff: a selection or the scrollbar thumb being dragged follows it; near
  // the top or bottom edge a selection scrolls the diff along.
  frameMove(e, cx) {
    const zoom = this.zoom ?? 1, y = (e.local_position?.y ?? 0) / zoom;
    if (this.thumbDrag) {
      const { from, offset, ratio } = this.thumbDrag;
      if (this.scrollTo(offset + ((e.position.y - from) / zoom) * ratio)) cx.notify();
      return;
    }
    if (!this.dragging || !this.sel) return;
    let moved = false;
    if (y < 24) moved = this.scrollTo(this.offset - 20);
    else if (y > this.viewH - 24) moved = this.scrollTo(this.offset + 20);
    const r = this.rows[this.rowAt(this.offset + y)];
    if (r?.type === "line" && r.f.path === this.dragging && r.i !== this.sel.b) { this.sel = { ...this.sel, b: r.i }; moved = true; }
    if (moved) cx.notify();
  }

  frameUp(cx) {
    this.thumbDrag = null;
    if (!this.dragging) return;
    this.dragging = null;
    if (this.sel) this.draft.focus();
    cx.notify();
  }

  selRange() {
    if (!this.sel) return null;
    const f = this.files.find((f) => f.path === this.sel.path);
    if (!f) return null;
    const lo = Math.min(this.sel.a, this.sel.b), hi = Math.max(this.sel.a, this.sel.b);
    const lines = f.rows.slice(lo, hi + 1).filter((r) => r.type === "line");
    return lines.length ? { f, lo, hi, lines } : null;
  }

  saveComment(cx) {
    const text = this.draft.value().trim(), range = this.selRange();
    if (!text) return;
    const list = [...this.comments()];
    if (this.editing) {
      const c = list.find((c) => c.id === this.editing);
      if (c) c.text = text;
    } else if (range) {
      list.push({
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        path: range.f.path, from: lineRef(range.lines[0]), to: lineRef(range.lines.at(-1)),
        code: range.lines.map((r) => `${r.kind}${r.text}`), text,
      });
    } else return;
    this.reviews[this.root] = list;
    writeJson("review.json", this.reviews);
    this.sel = null; this.editing = null; this.draft.set_value(""); this.draftText = ""; this.confirming = false;
    this.layout(); cx.notify();
  }

  editComment(c) {
    this.editing = c.id; this.sel = null;
    this.draft.set_value(c.text); this.draftText = c.text; this.draft.focus();
  }

  deleteComment(c) {
    this.reviews[this.root] = this.comments().filter((x) => x.id !== c.id);
    writeJson("review.json", this.reviews);
    if (this.editing === c.id) { this.editing = null; this.draft.set_value(""); }
    this.confirming = false;
    this.layout();
  }

  cancelDraft(cx) {
    this.sel = null; this.editing = null; this.draft.set_value(""); this.draftText = ""; cx.notify();
  }

  // The agents a review can go to: this space's, the most recently active first.
  targets() {
    const space = mySpace();
    return agents().filter((a) => a.space === space?.id).sort((x, y) => y.seq - x.seq);
  }

  reviewText(list) {
    const parts = [`Code review of the uncommitted changes in ${this.root}: ${list.length} comment${list.length === 1 ? "" : "s"}. Please address each one.`];
    list.forEach((c, n) => {
      const code = c.code.slice(0, 8).map((l) => `    ${l}`).join("\n") + (c.code.length > 8 ? `\n    … (${c.code.length - 8} more lines)` : "");
      parts.push(`${n + 1}. ${c.path}, ${rangeLabel(c.from, c.to)}:\n${code}\n   ${c.text.split("\n").join("\n   ")}`);
    });
    return parts.join("\n\n");
  }

  // Two clicks: the first asks (naming the agent), the second sends every comment in one message.
  submitReview(cx) {
    const list = this.comments(), target = this.targets().find((a) => a.address === this.target) ?? this.targets()[0];
    if (!list.length || this.sending) return;
    if (!target) { this.note = "No agent in this space to send the review to"; cx.notify(); return; }
    if (!this.confirming) { this.confirming = true; cx.notify(); return; }
    this.confirming = false; this.sending = true; this.note = null;
    const text = this.reviewText(list), root = this.root;
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["send", target.address, text]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        this.reviews[root] = [];
        writeJson("review.json", this.reviews);
        this.note = `Sent ${list.length} comment${list.length === 1 ? "" : "s"} to ${target.tab_name || target.address}`;
        this.layout();
      } catch (e) { this.note = `Couldn't send the review: ${e}`; }
      finally { this.sending = false; cx.notify(); }
    });
    cx.notify();
  }

  // push: then sends it, with the commits already waiting, to the upstream (made on origin if none).
  commit(cx, push = false) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.stagePending.size || this.context !== this.ctx()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        // Staged files only when there are some, else everything.
        const steps = this.files.some((f) => f.staged) ? [["commit", "-m", message]] : [["add", "-A"], ["commit", "-m", message]];
        for (const args of steps) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (this.ctx() === context) { this.message = ""; this.input.set_value(""); }
        if (push) {
          this.pushing = true; cx.notify();
          const r = await exec("git", this.upstream ? ["push"] : ["push", "-u", "origin", "HEAD"], { cwd: root, on }).catch((e) => ({ code: 1, stderr: String(e) }));
          if (r.code !== 0) throw new Error(`committed, but the push failed: ${(r.stderr || r.stdout).trim()}`);
        }
      } catch (e) { if (this.ctx() === context) this.note = `${push ? "Commit & push" : "Commit"} failed: ${e.message ?? e}`; }
      finally { this.busy = false; this.pushing = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  statusColor(s, t, gh) {
    return s === "A" ? gh.added : s === "D" || s === "U" ? gh.deleted : t.blocked;
  }

  // GitHub's five little squares: the share of added, then deleted lines.
  diffstat(f, gh, t) {
    const total = f.add + f.del, adds = total ? Math.round((5 * f.add) / Math.max(total, 5)) : 0;
    const dels = total ? Math.min(5 - adds, Math.round((5 * f.del) / Math.max(total, 5))) : 0;
    return div().w(44).flex_none().flex().flex_row().items_center().gap(1)
      .children([0, 1, 2, 3, 4].map((i) => div().w(8).h(8).flex_none().rounded(2).bg(i < adds ? gh.added : i < adds + dels ? gh.deleted : t.border)));
  }

  header(row, t, gh) {
    return div().w(this.rowWidth()).h(ROW.file).pt(8).flex_none().child(this.headerBar(row, t, gh, ""));
  }

  // A file's header bar: in the list, and again pinned over the top of the diff (`pre` "s") while
  // that file's lines scroll under it. The focused file's bar has the accent border.
  headerBar(row, t, gh, pre) {
    const { f, folded, count } = row, parts = f.path.split("/"), name = parts.pop(), viewed = this.isViewed(f);
    const focused = this.focused?.path === f.path;
    return div().id(`${pre}head|${f.path}`).flex().flex_row().items_center().h(HEAD).px(10).gap(8).bg(t.raised).border_1().border_color(focused ? t.accent : t.border)
        .when(folded, (e) => e.rounded(6)).when(!folded, (e) => e.rounded_t(6)).cursor_pointer()
        .on_click((_e, cx) => { this.focusPath = f.path; this.toggleFold(f); cx.notify(); })
        .child(div().w(12).flex_none().text_size(11).text_color(t.dim).child(folded ? "▸" : "▾"))
        .when(f.status !== "M", (e) => e.child(div().px(5).rounded(4).text_size(10).font_semibold().text_color(this.statusColor(f.status, t, gh)).border_1().border_color(t.border)
          .child({ A: "new", D: "deleted", U: "conflict" }[f.status])))
        .child(div().flex().flex_row().items_center().flex_1().min_w(0).font_family(this.code).text_size(12)
          .child(div().flex_shrink(1).min_w(0).truncate().text_color(t.muted).child(parts.length ? `${parts.join("/")}/` : ""))
          .child(div().flex_none().font_semibold().text_color(t.foreground).child(name)))
        // Fixed widths: rows are sized by hand (see rowWidth).
        .when(count > 0, (e) => e.child(div().w(88).flex_none().text_center().rounded(9).bg(gh.viewed + "33").text_size(11).text_color(t.foreground).child(`${count} comment${count === 1 ? "" : "s"}`)))
        .when(Boolean(f.staged), (e) => e.child(div().w(56).flex_none().text_center().rounded(4).border_1().border_color(gh.added).text_size(10.5).text_color(gh.added)
          .child(f.partial ? "partly staged" : "staged")))
        .child(div().w(44).flex_none().text_right().text_size(12).font_semibold().text_color(gh.added).child(`+${f.add}`))
        .child(div().w(44).flex_none().text_size(12).font_semibold().text_color(gh.deleted).child(`−${f.del}`))
        .child(this.diffstat(f, gh, t))
        .child(div().id(`${pre}zed|${f.path}`).w(64).h(24).flex_none().px(8).rounded(6).border_1().border_color(t.border).text_size(12).text_color(t.muted)
          .when(!this.on, (e) => e.hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(`Open ${f.path} in Zed`)
            .on_click((_e, cx) => { cx.stop_propagation(); this.openInZed(f); }))
          .child("Zed ↗"))
        .child(div().id(`${pre}viewed|${f.path}`).w(90).h(24).flex_none().px(8).rounded(6).border_1().hover((s) => s.bg(t.hover))
          .tooltip(focused ? "x marks the focused file viewed" : "Mark viewed")
          .on_click((_e, cx) => { cx.stop_propagation(); this.toggleViewed(f); cx.notify(); })
          .border_color(viewed ? gh.viewed : t.border).bg(viewed ? gh.viewed + "26" : t.background)
          .text_size(12).text_color(viewed ? t.foreground : t.muted)
          .child(viewed ? "✓ Viewed" : "☐ Viewed"));
  }

  commentRow(row, t, gh) {
    const { c, outdated } = row, w = this.rowWidth();
    const editing = this.editing === c.id;
    return div().w(w).h(row.height).flex_none().border_l(1).border_r(1).border_color(t.border).bg(t.background).pl(CODE_INDENT).pr(12).py(6).child(
      v_flex().size_full().rounded(6).border_1().border_color(editing ? t.accent : t.border).bg(t.raised).overflow_hidden()
        .child(h_flex().h(28).px(10).gap(8).items_center().border_b(1).border_color(t.border).text_size(12)
          .child(div().font_semibold().text_color(t.foreground).child("You"))
          .child(div().text_color(t.muted).child(`${rangeLabel(c.from, c.to)} · pending`))
          .when(Boolean(outdated), (e) => e.child(div().px(5).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.blocked).child("outdated")))
          .child(div().flex_1())
          .child(div().id(`edit|${c.id}`).px(6).rounded(4).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { this.editComment(c); cx.notify(); }).child("Edit"))
          .child(div().id(`delete|${c.id}`).px(6).rounded(4).text_color(gh.deleted).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { this.deleteComment(c); cx.notify(); }).child("Delete")))
        .child(div().flex_1().px(10).py(6).text_size(12.5).text_color(t.foreground).child(c.text)));
  }

  diffRow(row, t, gh, pal) {
    const w = this.rowWidth(), side = (e) => e.border_l(1).border_r(1).border_color(t.border);
    if (row.type === "file") return this.header(row, t, gh);
    if (row.type === "comment") return this.commentRow(row, t, gh);
    if (row.type === "end") return side(div().w(w).h(ROW.end).flex_none().border_b(1).rounded_b(6).bg(t.background));
    if (row.type === "meta") return side(h_flex().w(w).h(ROW.meta).flex_none().px(12).items_center().bg(t.background).text_size(11).text_color(t.dim).child(row.text));
    if (row.type === "hunk") {
      return side(h_flex().w(w).h(ROW.hunk).flex_none().items_center().bg(gh.hunk).font_family(this.code).text_size(12).text_color(t.muted)
        .child(div().w(96).h_full().flex_none().bg(gh.hunkNumber))
        .child(div().flex_1().min_w(0).px(10).truncate().child(row.text)));
    }
    const { kind, old, nu } = row, lang = row.f.language, tokens = row.f.rows[row.i].tokens ?? [{ text: row.text, kind: "text" }];
    const sel = this.sel?.path === row.f.path && row.i >= Math.min(this.sel.a, this.sel.b) && row.i <= Math.max(this.sel.a, this.sel.b);
    const bg = sel ? gh.selected : kind === "+" ? gh.add : kind === "-" ? gh.del : t.background;
    const numberBg = sel ? gh.selectedNumber : kind === "+" ? gh.addNumber : kind === "-" ? gh.delNumber : t.background;
    const number = (n) => div().w(48).h_full().flex_none().px(8).text_right().text_color(t.dim).bg(numberBg).child(n === undefined ? "" : String(n));
    return side(h_flex().id(this.rowKey(row)).w(w).h(ROW.line).flex_none().items_center().bg(bg).font_family(this.code).text_size(12)
      .cursor_pointer().on_mouse_down("left", (e, cx) => this.lineDown(row, e, cx))
      .child(number(old)).child(number(nu))
      .child(div().w(20).flex_none().text_center().text_color(kind === " " ? t.dim : t.foreground).child(kind === " " ? "" : kind))
      .child(h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap()
        .children(tokens.map((tok) => div().flex_none().text_color(lang ? pal[tok.kind] ?? pal.text : t.foreground).child(tok.text)))));
  }

  // The rows on screen, placed where the offset puts them.
  viewport(t, gh, pal) {
    const first = Math.max(0, this.rowAt(this.offset)), shown = [];
    for (let i = first; i < this.rows.length && this.tops[i] < this.offset + this.viewH; i++) {
      const r = this.rows[i];
      // A row that throws would blank the whole diff without a word: it says why instead.
      try { shown.push(this.diffRow(r, t, gh, pal)); }
      catch (e) { shown.push(div().w(this.rowWidth()).h(r.height ?? ROW[r.type]).text_size(10).text_color(gh.deleted).child(`${r.type}: ${e}`)); }
    }
    return div().absolute().left(16).top(this.tops[first] - this.offset).w(this.rowWidth()).flex().flex_col().children(shown);
  }

  // The file being read: the one clicked last while it's on screen, else the one whose lines are
  // just under the top edge (the pinned header's).
  focusedFile() {
    const at = (path) => this.headerAt[path];
    if (this.focusPath && at(this.focusPath) !== undefined) {
      const h = at(this.focusPath), end = this.cardEnd(h);
      if (end > this.offset && this.tops[h] < this.offset + this.viewH) return this.rows[h].f;
    }
    return this.rows[this.rowAt(this.offset + HEAD + 2)]?.f ?? this.rows[this.rowAt(this.offset)]?.f ?? null;
  }

  // Where a file's card ends, from its header's row index.
  cardEnd(h) {
    let i = h + 1;
    while (i < this.rows.length && this.rows[i].type !== "file") i++;
    return this.tops[i];
  }

  // The header of the file at the top edge, pinned there once its own has scrolled off, and pushed
  // up by the end of its card.
  stickyHeader(t, gh) {
    const r = this.rows[this.rowAt(this.offset)], h = r && this.headerAt[r.f.path];
    if (h === undefined || this.rows[h].folded || this.offset <= this.tops[h] + ROW.file - HEAD) return null;
    const top = Math.min(0, this.cardEnd(h) - ROW.end - this.offset - HEAD);
    return div().id("sticky-head").absolute().left(16).top(top).w(this.rowWidth()).bg(t.background).shadow_md()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(this.headerBar(this.rows[h], t, gh, "s"));
  }

  // x: marks the focused file viewed (or not) and moves on to the next file.
  markFocused(cx) {
    const f = this.focused;
    if (!f) return;
    const marking = !this.isViewed(f);
    this.toggleViewed(f);
    this.focusPath = f.path;
    const h = this.headerAt[f.path];
    if (marking && h !== undefined) {
      // Focus goes to the next file by name, not by scroll: when the last files fit on screen the
      // diff can't scroll them to the top edge.
      let next = h + 1;
      while (next < this.rows.length && this.rows[next].type !== "file") next++;
      if (next < this.rows.length) { this.focusPath = this.rows[next].f.path; this.scrollTo(this.tops[next]); }
    }
    cx.notify();
  }

  scrollbar(t) {
    const room = this.total - this.viewH;
    if (room <= 0) return [];
    const thumb = Math.max(28, (this.viewH * this.viewH) / this.total), travel = this.viewH - 8 - thumb;
    return [div().id("diff-thumb").absolute().right(3).top(4 + (travel * this.offset) / room).w(7).h(thumb).rounded(4)
      .bg(this.thumbDrag ? t.muted : t.dim + "99").hover((s) => s.bg(t.muted))
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.thumbDrag = { from: e.position.y, offset: this.offset, ratio: room / Math.max(1, travel) }; cx.notify(); })];
  }

  treeRow(r, t, gh, counts) {
    const pad = 8 + r.depth * 14;
    if (r.dir) {
      const open = !this.treeFolded.has(r.full);
      return h_flex().id(`dir-${r.full}`).h(26).flex_none().pl(pad).pr(8).gap(6).items_center().rounded(6).text_color(t.muted)
        .hover((s) => s.bg(t.hover)).cursor_pointer()
        .on_click((_e, cx) => { open ? this.treeFolded.add(r.full) : this.treeFolded.delete(r.full); this.layout(); cx.notify(); })
        .child(svg(`mods/files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none())
        .child(svg("mods/files/folder.svg").size(14).flex_none())
        .child(div().flex_1().min_w(0).truncate().child(r.label));
    }
    const f = r.f, viewed = this.isViewed(f), n = counts.get(f.path) ?? 0, pending = this.stagePending.has(f.path);
    const box = div().id(`stage-${f.path}`).w(14).h(14).flex_none().rounded(3).border_1().flex().items_center().justify_center()
      .border_color(f.staged ? gh.added : t.input ?? t.border).bg(f.staged && !f.partial ? gh.added : t.background)
      .text_size(10).font_bold().text_color(f.partial ? gh.added : "#ffffff")
      .when(pending, (e) => e.opacity(0.45)).when(!pending, (e) => e.cursor_pointer())
      .tooltip(pending ? (f.staged ? "Staging…" : "Unstaging…") : f.partial ? "Partly staged: stage the rest" : f.staged ? "Unstage" : "Stage")
      .on_click((_e, cx) => { cx.stop_propagation(); this.toggleStage(f, cx); })
      .child(f.partial ? "–" : f.staged ? "✓" : "");
    return h_flex().id(`file-${f.path}`).h(26).flex_none().pl(pad).pr(8).gap(6).items_center().rounded(6)
      .text_color(viewed ? t.dim : t.foreground).hover((s) => s.bg(t.hover)).cursor_pointer()
      .on_click((_e, cx) => this.jump(f, cx))
      .when(this.mode !== "branch", (e) => e.on_mouse_down("right", () => { this.menu = { f, pending: true }; }).child(box))
      .child(svg("mods/files/file.svg").size(14).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().child(r.label))
      .when(n > 0, (e) => e.child(div().px(5).rounded(8).bg(gh.viewed + "33").text_size(10.5).text_color(t.foreground).child(String(n))))
      .when(viewed, (e) => e.child(svg("mods/workspace-chrome/check.svg").size(12).flex_none().text_color(gh.viewed)))
      .child(div().w(10).flex_none().text_size(11).text_color(this.statusColor(f.status, t, gh)).child(f.status));
  }

  // The comment box under the diff: for the selected lines, or the comment being edited.
  composer(t, gh) {
    const range = this.selRange(), editing = this.comments().find((c) => c.id === this.editing);
    if (!range && !editing) return null;
    const label = editing ? `Editing comment on ${editing.path}, ${rangeLabel(editing.from, editing.to)}`
      : `Comment on ${range.f.path}, ${rangeLabel(lineRef(range.lines[0]), lineRef(range.lines.at(-1)))}`;
    const ready = Boolean(this.draftText?.trim());
    return v_flex().flex_none().mx(16).mb(10).p(10).gap(8).rounded(8).border_1().border_color(t.accent).bg(t.raised)
      .child(h_flex().gap(8).items_center().text_size(12)
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(label))
        .child(div().text_size(11).text_color(t.dim).child("Drag over lines or shift-click to extend · ⌘↩ to add · Esc to cancel")))
      .child(div().id("comment-box").rounded(6).border_1().border_color(t.border).bg(t.background).px(8).py(4)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Textarea.new(this.draft).w_full().text_size(12.5).text_color(t.foreground)))
      .child(h_flex().gap(8).justify_end()
        .child(div().id("comment-cancel").h(28).px(12).flex().items_center().rounded(6).border_1().border_color(t.border).text_size(12).text_color(t.muted)
          .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.cancelDraft(cx)).child("Cancel"))
        .child(div().id("comment-save").h(28).px(12).flex().items_center().rounded(6).text_size(12)
          .bg(ready ? gh.added : t.border).text_color(ready ? "#ffffff" : t.dim).when(ready, (e) => e.cursor_pointer())
          .on_click((_e, cx) => this.saveComment(cx)).child(editing ? "Update comment" : "Add review comment")));
  }

  reviewBar(t, gh) {
    const list = this.comments();
    if (!list.length) return null;
    const targets = this.targets(), target = targets.find((a) => a.address === this.target) ?? targets[0];
    return h_flex().gap(8).items_center().text_size(12)
      .child(div().text_color(t.muted).child(`${list.length} pending comment${list.length === 1 ? "" : "s"}`))
      .when(targets.length > 1, (e) => e.child(div().id("review-target").px(6).py(2).rounded(5).border_1().border_color(t.border).text_color(t.muted)
        .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip("Send to another agent of this space")
        .on_click((_e, cx) => { const i = targets.indexOf(target); this.target = targets[(i + 1) % targets.length].address; this.confirming = false; cx.notify(); })
        .child(`to ${target.tab_name || target.address}`)))
      .child(div().id("review-discard").h(26).px(10).flex().items_center().rounded(6).border_1().border_color(t.border).text_color(t.muted)
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.reviews[this.root] = []; writeJson("review.json", this.reviews); this.confirming = false; this.layout(); cx.notify(); })
        .child("Discard"))
      .child(div().id("review-submit").h(26).px(10).flex().items_center().rounded(6).font_semibold()
        .bg(this.confirming ? gh.deleted : gh.added).text_color("#ffffff").cursor_pointer()
        .on_click((_e, cx) => this.submitReview(cx))
        .child(this.sending ? "Sending…" : this.confirming ? `Send ${list.length} to ${target?.tab_name || target?.address || "agent"}?` : "Submit review"));
  }

  render(cx) {
    if (this.ctx() !== this.context) this.refresh(cx);
    this.focused = this.focusedFile();
    const s = settings(); this.code = s.font_family ?? "JetBrains Mono"; this.zoom = s.zoom ?? 1;
    const t = theme(), dark = s.dark !== false, gh = dark ? GITHUB.dark : GITHUB.light, pal = palette(dark);
    const add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const seen = this.files.filter((f) => this.isViewed(f)).length;
    const counts = new Map();
    for (const c of this.comments()) counts.set(c.path, (counts.get(c.path) ?? 0) + 1);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading && !this.stagePending.size);
    const staged = this.files.filter((f) => f.staged).length;
    const empty = this.error || (this.loading ? `Loading changes… (${this.step})` : !this.root ? "No folder" : this.mode === "branch" ? `No changes since ${this.baseRef ?? BASES[0]}` : "No uncommitted changes");
    const composer = this.composer(t, gh), review = this.reviewBar(t, gh);
    const menu = this.fileMenu(t, gh);
    return v_flex().id("changes").relative().size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13).track_focus(this.handle)
      // A tree row marks the menu pending; here, with the panel's own coordinates, it gets its place.
      .on_mouse_down("right", (e, cx) => {
        if (!this.menu?.pending) return;
        const z = this.zoom ?? 1, x = (e.local_position?.x ?? 0) / z, y = (e.local_position?.y ?? 0) / z;
        const w = (e.bounds?.width ?? Infinity) / z, h = (e.bounds?.height ?? Infinity) / z;
        this.menu = { f: this.menu.f, x: Math.max(4, Math.min(x, w - 304)), y: Math.max(4, Math.min(y, h - 150)) };
        cx.notify();
      })
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.menu) { this.menu = null; cx.stop_propagation(); cx.notify(); }
        else if (e.key === "escape" && (this.sel || this.editing)) { this.cancelDraft(cx); this.handle.focus(); cx.stop_propagation(); }
        else if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
        else if (e.key === "x" && !this.typing && !this.sel && !this.editing && !e.modifiers?.control && !e.modifiers?.platform && !e.modifiers?.alt) { this.markFocused(cx); cx.stop_propagation(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(10).items_center().border_b(1).border_color(t.border)
        .child(div().id("tree-toggle").p(4).rounded(5).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.showTree = !this.showTree; cx.notify(); })
          .child(svg("mods/workspace-chrome/sidebar.svg").size(15)))
        .child(div().font_semibold().child("Changes"))
        .child(h_flex().p(2).gap(2).rounded(7).bg(t.raised).text_size(12)
          .children([["local", "Uncommitted", "Changes since the last commit"], ["branch", `vs ${(this.baseRef ?? BASES[0]).replace(/^origin\//, "")}`, `Everything this branch changes since it left ${this.baseRef ?? BASES[0]}: its commits and uncommitted work`]].map(([m, label, tip]) =>
            div().id(`mode-${m}`).h(22).px(8).flex().items_center().rounded(5).cursor_pointer().tooltip(tip)
              .bg(this.mode === m ? t.background : t.raised).text_color(this.mode === m ? t.foreground : t.muted)
              .when(this.mode !== m, (e) => e.hover((s) => s.text_color(t.foreground)))
              .on_click((_e, cx) => { if (this.mode === m) return; this.mode = m; localStorage.setItem("mode", m); this.refresh(cx); cx.notify(); })
              .child(label))))
        .child(div().text_size(12).text_color(t.muted).child(`${this.files.length} file${this.files.length === 1 ? "" : "s"}`))
        .child(div().text_size(12).font_semibold().text_color(gh.added).child(`+${add}`))
        .child(div().text_size(12).font_semibold().text_color(gh.deleted).child(`−${del}`))
        .child(div().flex_1())
        .when(this.files.length > 0, (e) => e.child(h_flex().gap(8).items_center().text_size(12).text_color(t.muted)
          .child(div().w(80).h(6).rounded(3).bg(t.border).child(div().h_full().rounded(3).bg(gh.viewed).w(Math.round((80 * seen) / this.files.length))))
          .child(`${seen} / ${this.files.length} viewed`)))
        .when(Boolean(review), (e) => e.child(div().w(1).h(18).bg(t.border)).child(review)))
      .when(this.limited, (el) => el.child(div().px(14).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .child(h_flex().flex_1().min_h(0)
        .when(this.showTree && this.files.length > 0, (e) => e.child(v_flex().id("changes-tree").w(280).flex_none().h_full().p(8).border_r(1).border_color(t.border)
          .overflow_y_scrollbar().text_size(12.5).children(this.treeRows.map((r) => this.treeRow(r, t, gh, counts)))))
        .child(v_flex().id("diff-area").flex_1().min_w(0).h_full()
          .on_size_change((size, cx) => {
            if (Math.abs(size.width - (this.diffWidth ?? 0)) <= 1) return;
            this.diffWidth = Math.round(size.width); this.layout(); cx.notify();
          })
          .child(div().id("diff-frame").flex_1().min_h(0).w_full().relative().overflow_hidden()
            .on_size_change((size, cx) => {
              const h = size.height / (this.zoom ?? 1);
              if (Math.abs(h - this.viewH) <= 1) return;
              this.viewH = h; this.scrollTo(this.offset); cx.notify();
            })
            .on_scroll_wheel((e, cx) => { if (this.scrollTo(this.offset - e.delta.y / (this.zoom ?? 1))) { this.focusPath = null; cx.notify(); } })
            .on_mouse_move((e, cx) => this.frameMove(e, cx))
            .on_mouse_up("left", (_e, cx) => this.frameUp(cx))
            .on_mouse_down("left", () => { if (!this.sel && !this.editing && !this.typing) this.handle.focus(); })
            .when(this.rows.length > 0, (e) => { const pin = this.stickyHeader(t, gh); return e.child(this.viewport(t, gh, pal)).when(Boolean(pin), (e) => e.child(pin)).children(this.scrollbar(t)); })
            .when(!this.rows.length, (e) => e.child(div().p(16).text_color(t.dim).child(empty))))
          .when(Boolean(composer), (e) => e.child(composer))))
      .when(Boolean(this.note), (e) => e.child(div().px(14).py(6).text_size(11.5).text_color(this.note.startsWith("Sent") ? gh.added : gh.deleted).child(this.note)))
      .when(this.mode !== "branch", (el) => el.child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit-push").h(32).px(14).flex().items_center().rounded(8).border_1().text_size(12)
          .border_color(enabled ? t.solid : t.border).text_color(enabled ? t.foreground : t.dim)
          .when(enabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)))
          .tooltip(this.ahead > 0
            ? `Commits, then pushes ${this.ahead + 1} commits: this one and ${this.ahead} already waiting${this.upstream ? ` (to ${this.upstream})` : " (to origin, a new branch there)"}`
            : `Commits, then pushes it${this.upstream ? ` to ${this.upstream}` : " to origin (a new branch there)"}`)
          .on_click((_e, cx) => this.commit(cx, true))
          .child(this.pushing ? "Pushing…" : this.ahead > 0 ? `Commit & push · ${this.ahead + 1} commits` : "Commit & push"))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : staged ? `Commit ${staged} staged` : "Commit all"))))
      .when(Boolean(menu), (el) => el.child(menu));
  }
}
