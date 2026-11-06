// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, machines, panes, run, openOverlay, exec, hc, theme, shared, setShared, watchFolder, window, layout } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
// A flutter run's line under its space, drawn like a background task in the agents list.
const RUN_HEIGHT = 24;
// ps etime, "[[dd-]hh:]mm:ss", in seconds; null when it doesn't read.
function etimeSeconds(text) {
  const m = text.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  return m ? ((+(m[1] ?? 0) * 24 + +(m[2] ?? 0)) * 60 + +m[3]) * 60 + +m[4] : null;
}
// A duration as "m:ss", "h:mm:ss" past an hour.
function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
// A space's row and its flutter-run lines: one block, one tile when dragged.
const REVIEW_HEIGHT = 20;
const blockHeight = (r, runs, reviewers) => rowHeight(r) + (runs?.length ?? 0) * RUN_HEIGHT + (reviewers?.length ?? 0) * REVIEW_HEIGHT;
const RUNNING = /Flutter run key commands|is available at:|Reloaded \d|Restarted application|Hot reload/;
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;
const PR_FALLBACK = 60000;
// CI that gets a loader on the worktree while it runs: check runs on the pull request, and
// workflows started by hand on the branch (they don't show on the pull request).
const CI_CHECKS = { validate_pull_request: "Validate pull request" };
const CI_WORKFLOWS = { "deploy_android.yml": "Android build" };
const CI_FALLBACK = 20000;
// Reviewers change slowly: once per pull request at most every REVIEW_FALLBACK.
const REVIEW_FALLBACK = 15 * 60000;
const GUIDE_X = 16;
const prKey = (g) => `${g.repo}\n${g.branch}`;

// As the pull request page shows it: only the newest run of each check counts. The commit's
// rollup state counts every run, so a check that failed and then passed on a re-run (the
// milestone check runs again on each milestone change) keeps it at FAILURE.
const FAILED = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ERROR"]);
const PASSED = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
function newestChecks(contexts) {
  const newest = new Map();
  for (const c of contexts) {
    if (!c) continue;
    if ("context" in c) { newest.set(`status\n${c.context}`, c); continue; }
    const key = `${c.checkSuite?.workflowRun?.workflow?.name ?? ""}\n${c.name}`;
    const seen = newest.get(key);
    if (!seen || (c.startedAt ?? "") > (seen.startedAt ?? "")) newest.set(key, c);
  }
  return [...newest.values()];
}
const failing = (contexts) => newestChecks(contexts).some((c) => FAILED.has(c.conclusion ?? c.state));
// Workflows that only build a test app on demand (a PR label): not CI, so they don't count for green.
const TEST_BUILDS = new Set(["Deploy test build"]);
// Every newest check done and passed (none at all is not green).
function green(contexts) {
  const checks = newestChecks(contexts).filter((c) => !TEST_BUILDS.has(c.checkSuite?.workflowRun?.workflow?.name));
  return checks.length > 0 && checks.every((c) => PASSED.has(c.conclusion ?? c.state));
}

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

export default class Spaces extends View {
  init(_props, cx) {
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.drag = null;
    this.machines = [];
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.prs = {}; // prKey() -> "none" | "open" | "failing" | "queued" | "merged"
    this.prsAt = 0;
    this.ci = {}; // prKey() -> names of the watched CI runs going on it
    this.reviewable = {}; // prKey() -> { folder, number } of an open pull request with green CI, out of the merge queue
    this.reviews = {}; // prKey() -> [{ name, approved, commented }]
    this.reviewsAt = {}; // prKey() -> when its reviewers were last fetched
    this.hasWorkflow = {}; // repo's main folder + workflow file -> true when the repo has it
    this.slugs = {}; // repo's main folder -> "owner/name" on GitHub, null: not on GitHub
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    cx.timer.every(5000, (cx) => this.checkPrs(cx));
    cx.timer.every(10000, (cx) => this.checkReviews(cx));
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
    this.runs = {}; // space id -> [{ address, app, device, running, start, ready }]
    this.runSeen = {}; // pid -> when (ms) that run printed it's up (the screen may scroll that away)
    this.runStart = {}; // pid -> when (ms) the flutter process started
    this.simNames = {}; // udid -> simulator name
    this.scanRuns(cx);
    cx.timer.every(3000, (cx) => this.scanRuns(cx));
    // The build timers tick once a second, only while a run builds: each redraw paints the window.
    cx.timer.every(1000, (cx) => { if (Object.values(this.runs).flat().some((x) => !x.running)) cx.notify(); });
  }

  // flutter runs in terminals: Herdr names a terminal's front program, so only "dartvm" ones are asked
  // (hc get) for the command line; the app is the apps/<name> folder it runs in, the device its -d.
  scanRuns(cx) {
    if (this.scanning) return;
    this.scanning = true;
    cx.spawn(async (cx) => {
      const found = {};
      try {
        const ps = panes().filter((p) => p.terminal && /^dart(vm)?$/.test(p.program?.name ?? ""));
        const sp = spaces();
        for (const p of ps) {
          const r = await hc(["get", p.terminal, "--json"]);
          if (r.code !== 0) continue;
          const fg = JSON.parse(r.stdout).foreground;
          const argv = fg?.argv ?? [], at = argv.findIndex((a) => /flutter_tools\.snapshot$/.test(a));
          if (at < 0 || argv[at + 1] !== "run") continue;
          const space = sp.find((w) => (w.tabs ?? []).some((c) => c.id === p.tab));
          if (!space) continue;
          const d = argv.findIndex((a) => a === "-d" || a === "--device-id");
          const device = d >= 0 ? argv[d + 1] : argv.find((a) => a.startsWith("--device-id="))?.slice(12) ?? null;
          const app = fg.cwd?.match(/\/apps\/([^/]+)/)?.[1] ?? base(fg.cwd ?? "") ?? "app";
          if (!this.runSeen[fg.pid]) {
            const screen = await hc(["read", p.terminal, "--json"]).catch(() => null);
            if (screen?.code === 0 && RUNNING.test(JSON.parse(screen.stdout).text ?? "")) this.runSeen[fg.pid] = Date.now();
          }
          if (!(fg.pid in this.runStart)) {
            const e = await exec("ps", ["-o", "etime=", "-p", String(fg.pid)]).catch(() => null);
            const secs = e?.code === 0 ? etimeSeconds(e.stdout) : null;
            this.runStart[fg.pid] = secs === null ? Date.now() : Date.now() - secs * 1000;
          }
          const ready = this.runSeen[fg.pid] ?? null;
          (found[space.id] ??= []).push({ address: p.terminal, app, device, running: Boolean(ready), start: this.runStart[fg.pid], ready });
        }
        const udids = Object.values(found).flat().map((x) => x.device).filter((u) => /^[0-9A-F-]{36}$/i.test(u ?? "") && !(u in this.simNames));
        if (udids.length) {
          const r = await exec("xcrun", ["simctl", "list", "devices", "-j"]).catch(() => null);
          for (const list of Object.values(r?.code === 0 ? JSON.parse(r.stdout).devices ?? {} : {})) for (const d of list) this.simNames[d.udid] = d.name;
          for (const u of udids) this.simNames[u] ??= u.slice(0, 8);
        }
      } catch {}
      this.scanning = false;
      if (JSON.stringify(found) !== JSON.stringify(this.runs)) { this.runs = found; cx.notify(); }
    });
  }

  // "tactics · iPhone 17": the device as the simulator's name, else as given (or the default one).
  runLabel(x) {
    const device = x.device ? this.simNames[x.device] ?? x.device : "default device";
    return `${x.app} · ${device}`;
  }

  // A run's line: its own branch off the space's guide, a phone, the app and device, and a spinner
  // while it builds or a dot once the app is up. A click goes to its terminal. The click stops the
  // mouse-up before the list sees it, so it ends the drag its mouse-down started on the row.
  runRow(r, x, last, t, ghost = false) {
    const gx = r.tree ? 36 : GUIDE_X, half = RUN_HEIGHT / 2;
    const line = () => div().absolute().w(1).bg(t.border).left(gx);
    return h_flex().relative().id(`${ghost ? "ghost-" : ""}run-${x.address}`).h(RUN_HEIGHT).flex_none().items_center()
      .pl(gx + 14 - 8).pr(0).gap(8).text_size(12).rounded(6)
      .when(!ghost, (el) => el.hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); this.drag = null; run("pane.focus", { terminal: x.address }); cx.notify(); }))
      .child(line().top(0).h(last ? half : RUN_HEIGHT).left(gx - 8))
      .child(div().absolute().h(1).bg(t.border).left(gx - 8).top(half).w(11))
      .child(svg("mods/run-menu/phone.svg").size(13).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(this.runLabel(x)))
      .child(div().flex_none().text_size(11).text_color(x.running ? t.dim : t.muted)
        .when(x.running, (el) => el.tooltip("Build time"))
        .child(clock((x.ready ?? Date.now()) - x.start)))
      .child(x.running
        ? div().size(6).mr(4).rounded(3).flex_none().bg(t.ansi2)
        : svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900));
  }

  // From the space's avatar (or a worktree's branch mark) down to its first run line.
  runStem(r, t) {
    const from = r.tree ? 21 : 24;
    return div().absolute().w(1).bg(t.border).left(r.tree ? 36 : GUIDE_X).top(from).h(rowHeight(r) - from);
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id))) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  // Local worktrees' pull requests: at once for a branch never asked about, else every
  // PR_FALLBACK while the window is in front (checks and the merge queue move on GitHub).
  checkPrs(cx) {
    const worktrees = Object.values(this.git).filter((g) => g?.linked && g.branch && !JSON.parse(g.repo)[0]);
    const unknown = worktrees.some((g) => !(prKey(g) in this.prs));
    const wait = Object.values(this.ci).some((x) => x.length) ? CI_FALLBACK : PR_FALLBACK;
    const due = window().active && Date.now() - this.prsAt > wait;
    if (this.fetchingPrs || !worktrees.length || !(unknown || due)) return;
    this.fetchingPrs = true;
    this.prsAt = Date.now();
    cx.spawn(async (cx) => {
      const byRepo = Map.groupBy(worktrees, (g) => JSON.parse(g.repo)[1].replace(/\/\.git$/, ""));
      for (const [folder, list] of byRepo) {
        try {
          await this.fetchPrs(folder, [...new Set(list.map((g) => g.branch))], list[0].repo);
        } catch {}
      }
      this.fetchingPrs = false;
      cx.notify();
    });
  }

  async fetchPrs(folder, branches, repo) {
    if (!(folder in this.slugs)) {
      const view = await exec("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { cwd: folder });
      this.slugs[folder] = view.code === 0 ? view.stdout.trim() : null;
    }
    const slug = this.slugs[folder];
    if (!slug) return;
    const [owner, name] = slug.split("/");
    // A closed, unmerged PR counts as none; the newest PR of the branch wins.
    const fields = branches.map((b, i) => `b${i}: pullRequests(headRefName: ${JSON.stringify(b)}, first: 1, states: [OPEN, MERGED], orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number state isInMergeQueue mergeable commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { ... on CheckRun { name status conclusion startedAt checkSuite { workflowRun { workflow { name } } } } ... on StatusContext { context state } } } } } } } } }`);
    const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields.join(" ")} } }`;
    const r = await exec("gh", ["api", "graphql", "-f", `query=${query}`], { cwd: folder });
    if (r.code !== 0) return;
    const found = JSON.parse(r.stdout).data?.repository ?? {};
    const dispatched = await this.runningWorkflows(folder);
    branches.forEach((branch, i) => {
      const pr = found[`b${i}`]?.nodes?.[0];
      const rollup = pr?.commits?.nodes?.[0]?.commit?.statusCheckRollup;
      const going = (rollup?.contexts?.nodes ?? []).filter((c) => c?.name in CI_CHECKS && c.status !== "COMPLETED").map((c) => CI_CHECKS[c.name]);
      this.ci[prKey({ repo, branch })] = [...new Set([...going, ...(dispatched.get(branch) ?? [])])];
      this.prs[prKey({ repo, branch })] = !pr ? "none"
        : pr.state === "MERGED" ? "merged"
        : pr.isInMergeQueue ? "queued"
        : pr.mergeable === "CONFLICTING" || failing(rollup?.contexts?.nodes ?? []) ? "failing"
        : "open";
      const key = prKey({ repo, branch });
      const validating = going.includes(CI_CHECKS.validate_pull_request);
      if (pr?.state === "OPEN" && !pr.isInMergeQueue && !validating && green(rollup?.contexts?.nodes ?? [])) {
        if (this.reviewable[key]?.number !== pr.number) delete this.reviewsAt[key];
        this.reviewable[key] = { folder, number: pr.number };
      } else delete this.reviewable[key];
    });
  }

  // Reviewers of the reviewable pull requests: at once for a new one, else every REVIEW_FALLBACK.
  checkReviews(cx) {
    const due = Object.keys(this.reviewable).filter((k) => !(k in this.reviewsAt) || Date.now() - this.reviewsAt[k] > REVIEW_FALLBACK);
    if (this.fetchingReviews || !due.length) return;
    this.fetchingReviews = true;
    for (const k of due) this.reviewsAt[k] = Date.now();
    cx.spawn(async (cx) => {
      for (const [folder, keys] of Map.groupBy(due, (k) => this.reviewable[k].folder)) {
        try { await this.fetchReviews(folder, keys); } catch {}
      }
      this.fetchingReviews = false;
      cx.notify();
    });
  }

  // As GitHub's Reviewers box: requested reviewers first (awaiting), then anyone else who left
  // a review. Teams, bots and the author are left out. Approved: their last
  // approve/request-changes/dismiss is an approval.
  async fetchReviews(folder, keys) {
    const slug = this.slugs[folder];
    if (!slug) return;
    const [owner, name] = slug.split("/");
    const who = "author { __typename login ... on User { name } }";
    const fields = keys.map((k, i) => `p${i}: pullRequest(number: ${this.reviewable[k].number}) { author { login } reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login name } } } } reviews(last: 100) { nodes { state ${who} } } }`);
    const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields.join(" ")} } }`;
    const r = await exec("gh", ["api", "graphql", "-f", `query=${query}`], { cwd: folder });
    if (r.code !== 0) return;
    const found = JSON.parse(r.stdout).data?.repository ?? {};
    keys.forEach((k, i) => {
      const pr = found[`p${i}`];
      if (!pr) return;
      const people = new Map();
      const person = (a) => {
        if (!a?.login || a.__typename === "Bot" || /\[bot\]$/.test(a.login ?? "") || a.login === pr.author?.login) return null;
        if (!people.has(a.login)) people.set(a.login, { name: a.name || a.login, approved: false, awaiting: false });
        return people.get(a.login);
      };
      for (const q of pr.reviewRequests?.nodes ?? []) { const p = person(q?.requestedReviewer); if (p) p.awaiting = true; }
      for (const v of pr.reviews?.nodes ?? []) {
        const p = person(v?.author);
        if (!p) continue;
        if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(v.state)) p.approved = v.state === "APPROVED";
      }
      this.reviews[k] = [...people.values()];
    });
  }

  // The reviewers drawn under a worktree: only while its pull request is reviewable.
  reviewersOf(r) {
    const g = r.g;
    if (!r.tree || !g?.branch) return [];
    const key = prKey(g);
    return this.reviewable[key] ? this.reviews[key] ?? [] : [];
  }

  // A reviewer's line, under the worktree's name: the name, then a clock while their review is
  // awaited (requested, or requested again), else a check once they approved, else a bubble.
  reviewerRow(r, x, n, t) {
    const icon = (file, color) => svg(file).size(12).flex_none().text_color(color);
    return h_flex().id(`reviewer-${r.w.id}-${n}`).h(REVIEW_HEIGHT).flex_none().items_center().gap(6)
      .pl(44).pr(4).text_size(12).text_color(t.muted)
      .child(div().min_w(0).truncate().child(x.name))
      .child(x.awaiting ? icon("mods/workspace-chrome/clock.svg", t.dim)
        : x.approved ? icon("mods/workspace-chrome/check.svg", t.ansi2)
        : icon("mods/my-spaces/message.svg", t.ansi4));
  }

  // Branch -> names of the CI_WORKFLOWS runs not finished on it. The newest runs are enough:
  // a run still going is a recent one.
  async runningWorkflows(folder) {
    const going = new Map();
    for (const [file, label] of Object.entries(CI_WORKFLOWS)) {
      const key = `${folder}\n${file}`;
      if (!(key in this.hasWorkflow)) this.hasWorkflow[key] = (await exec("test", ["-f", `.github/workflows/${file}`], { cwd: folder })).code === 0;
      if (!this.hasWorkflow[key]) continue;
      const r = await exec("gh", ["run", "list", "-w", file, "-L", "40", "--json", "headBranch,status"], { cwd: folder });
      if (r.code !== 0) continue;
      for (const run of JSON.parse(r.stdout)) {
        if (run.status === "completed") continue;
        going.set(run.headBranch, [...(going.get(run.headBranch) ?? []), label]);
      }
    }
    return going;
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null })).filter((r) => this.shown.has(r.w.id));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      if (kids.length) out[out.length - 1].parent = true;
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    return out;
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = (this.rows = this.ordered());
    const draw = (r) => (collapsed ? this.compact(r, t) : this.row(r, t));
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name)])].sort();
    this.publishOrder([null, ...remote].flatMap((m) => rows.filter((r) => (r.w.machine ?? null) === m).map((r) => r.w.id)));
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => div().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(8).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : rows.map(draw);
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const machine = this.machines.find(k => k.name === m);
      const connected = !m || machine?.state === "connected";
      const folded = this.folded.has(m);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 2 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none())
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", m ? { machine: m } : {}); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", m ? { machine: m } : {}))
        .child(svg("mods/workspace-chrome/plus.svg").size(12)).when(!collapsed, el => el.child("New space there"));
      return [head, ...(folded ? [] : mine.length ? mine.map(draw) : [loading(m) ? loadingRow(m) : empty])];
    });
  }

  // The rows' order, top to bottom, for the ctrl-N keys (mods/kb-space-N) and the rail's numbers.
  // Set only when it changes: setting shared state redraws every mod.
  publishOrder(ids) {
    this.order = ids;
    const old = shared("spaces.order");
    if (!Array.isArray(old) || old.join() !== ids.join()) setShared("spaces.order", ids);
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it, and master/main go: nearly every space is
  // on one. A worktree shows only the commits to pull: its name is its branch.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = tree || same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .when(!tree, (el) => el.flex_1().min_w(0))
      .when(Boolean(tree), (el) => el.flex_none())
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(!tree && g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  prColor(g, t) {
    const state = g?.branch ? this.prs[prKey(g)] : undefined;
    return { open: t.ansi2, failing: t.ansi1, merged: t.ansi5, queued: "#ffb86c" }[state] ?? t.foreground;
  }

  // The thin line from a repo's avatar down to its worktrees: through every row, ending
  // at the last one's branch mark. GUIDE_X is the avatar's center.
  guide(tree, parent, t) {
    const line = () => div().absolute().w(1).bg(t.border);
    if (parent) return [line().left(GUIDE_X).top(24).bottom(0)];
    if (!tree) return [];
    const half = rowHeight({ tree }) / 2;
    return [
      tree === "└─" ? line().left(GUIDE_X).top(0).h(half) : line().left(GUIDE_X).top(0).bottom(0),
      div().absolute().h(1).bg(t.border).left(GUIDE_X).top(half).w(11),
    ];
  }

  // Drag to reorder. Past a few pixels a raised copy of the row follows the pointer, the row
  // itself stays as a dashed slot, and an accent line shows where it lands. A space moves
  // between the top-level rows of its machine, with its worktrees; a worktree only among its
  // siblings (it is always drawn under its checkout). Leaving the list cancels.
  startDrag(r, e) {
    this.drag = {
      id: r.w.id, tree: Boolean(r.tree), repo: r.g?.repo, machine: r.w.machine ?? null,
      from: e.position, grab: e.local_position?.y ?? rowHeight(r) / 2, moved: false, pointer: null, drop: null,
    };
  }

  // Where the dragged row lands with the pointer over row `r`: { target, before, line }, or
  // null where it can't go or wouldn't move.
  dropAt(r, e) {
    const d = this.drag;
    if ((r.w.machine ?? null) !== d.machine) return null;
    const rows = (this.rows ?? []).filter((x) => (x.w.machine ?? null) === d.machine);
    const units = [];
    if (d.tree) {
      for (const x of rows) if (x.tree && x.g?.repo === d.repo) units.push([x.w.id]);
    } else {
      for (const x of rows) {
        if (!x.tree) units.push([x.w.id]);
        else units.at(-1)?.push(x.w.id);
      }
    }
    const di = units.findIndex((u) => u.includes(d.id)), ti = units.findIndex((u) => u.includes(r.w.id));
    if (di < 0 || ti < 0 || ti === di) return null;
    const unit = units[ti];
    const frac = (unit.indexOf(r.w.id) + (e.local_position?.y ?? 0) / (e.bounds?.height || 1)) / unit.length;
    const before = frac < 0.5;
    if (before ? ti === di + 1 : ti === di - 1) return null;
    return { target: unit[0], before, line: before ? { id: unit[0], edge: "top" } : { id: unit.at(-1), edge: "bottom" } };
  }

  dragMove(e, cx) {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(e.position.x - d.from.x, e.position.y - d.from.y) < 4) return;
    d.moved = true;
    d.pointer = e.local_position;
    d.height = e.bounds?.height;
    cx.notify();
  }

  endDrag(cx) {
    const d = this.drag;
    this.drag = null;
    if (d?.moved && d.drop) {
      const sp = spaces(), from = sp.findIndex((s) => s.id === d.id), to = sp.findIndex((s) => s.id === d.drop.target);
      // space.move's index is the one-based place it ends at, counted with it taken out.
      const at = d.drop.before ? (from < to ? to - 1 : to) : (from < to ? to : to + 1);
      if (from >= 0 && to >= 0 && at !== from) run("space.move", { id: d.id, index: at + 1 });
    }
    cx.notify();
  }

  dropLine(edge, tree, first, t) {
    return h_flex().absolute().left(tree ? 24 : 0).right(4).h(8).items_center()
      .when(edge === "top", (el) => el.top(first ? 0 : -4))
      .when(edge === "bottom", (el) => el.bottom(-4))
      .child(div().size(8).flex_none().rounded(4).border(2).border_color(t.accent).bg(t.chrome))
      .child(div().flex_1().h(2).rounded(1).bg(t.accent));
  }

  ghost(t) {
    const d = this.drag;
    if (!d?.moved || !d.pointer) return null;
    const r = (this.rows ?? []).find((x) => x.w.id === d.id);
    if (!r) return null;
    const runs = this.runs?.[r.w.id] ?? [], reviewers = this.reviewersOf(r), h = blockHeight(r, runs, reviewers);
    const top = Math.max(0, Math.min((d.height ?? Infinity) - h, d.pointer.y - d.grab));
    return v_flex().absolute().left(8).right(8).top(top).h(h).px(8)
      .rounded(8).bg(t.raised).border(1).border_color(t.accent).shadow_lg()
      .when(runs.length > 0, (el) => el.child(this.runStem(r, t)))
      .child(div().h(rowHeight(r) - 2).flex_none().flex().items_center().child(div().flex_1().min_w(0).child(this.rowBody(r, t))))
      .children(runs.map((x, n) => this.runRow(r, x, n === runs.length - 1, t, true)))
      .children(reviewers.map((x, n) => this.reviewerRow(r, x, `ghost-${n}`, t)));
  }

  rowBody({ w, g, tree }, t) {
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    return h_flex()
      .gap(9)
      .items_center()
      .when(Boolean(tree), el => el.pl(22).child(svg("mods/workspace-chrome/branch.svg").size(13).text_color(t.dim)))
      .when(!tree, el => el.child(h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child([...w.name][0]?.toUpperCase() ?? "?")))
      .child(tree
        ? div().flex_1().min_w(0).truncate().text_color(this.prColor(g, t)).child(w.name)
        : div().flex_shrink(0).max_w(150).truncate().text_color(t.foreground).child(w.name))
      .child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1())
      .when(Boolean(tree && g?.branch && this.ci[prKey(g)]?.length), (el) => el.child(this.ciLoader(w, g, t)));
  }

  // The agents panel's working spinner, while CI_CHECKS or CI_WORKFLOWS run for the branch.
  ciLoader(w, g, t) {
    return div().id(`ci-${w.id}`).flex_none().mr(2).flex().items_center()
      .tooltip(`${this.ci[prKey(g)].join(" and ")} running`)
      .child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900));
  }

  row(r, t) {
    const { w, tree, parent } = r;
    const on = w.active;
    const d = this.drag?.moved ? this.drag : null;
    const slot = d?.id === w.id;
    const line = d?.drop?.line.id === w.id ? d.drop.line.edge : null;
    const runs = this.runs?.[w.id] ?? [];
    const reviewers = this.reviewersOf(r);
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(blockHeight(r, runs, reviewers))
      .flex_none()
      .rounded(8)
      .when(slot, (el) => el.border(1).border_dashed().border_color(t.accent))
      .when(on && !slot, (el) => el.bg(t.selected))
      .when(!on && !d, (el) => el.hover((s) => s.bg(t.hover)))
      .on_mouse_down("left", (e) => this.startDrag(r, e))
      .on_mouse_move((e) => {
        if (!this.drag?.moved) return;
        this.drag.drop = this.dropAt(r, e);
      })
      .on_mouse_up("left", () => {
        if (this.drag?.id === w.id && !this.drag.moved) run("space.select", { id: w.id });
      })
      .on_mouse_down("right", () => this.menu(w))
      .children(this.guide(tree, parent, t))
      .when(runs.length > 0 && !(parent && !tree), (el) => el.child(this.runStem(r, t)))
      .child(div().h(rowHeight(r)).flex_none().flex().items_center()
        .child(div().flex_1().min_w(0).when(slot, (el) => el.opacity(0.3)).child(this.rowBody(r, t))))
      .children(runs.map((x, n) => slot ? div().opacity(0.3).child(this.runRow(r, x, n === runs.length - 1, t, true)) : this.runRow(r, x, n === runs.length - 1, t)))
      .children(reviewers.map((x, n) => slot ? div().opacity(0.3).child(this.reviewerRow(r, x, `slot-${n}`, t)) : this.reviewerRow(r, x, n, t)))
      .when(Boolean(line), (el) => el.child(this.dropLine(line, tree, this.rows?.[0]?.w.id === w.id, t)));
  }

  compact({ w, i }, t) {
    return h_flex()
      .id(`space-${w.id}`)
      .h(26)
      .flex_none()
      .justify_center()
      .gap(4)
      .when(w.active, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String((this.order?.indexOf(w.id) ?? i) + 1)))
      .child(div().text_color(tone(t, w.status)).child(glyph(w.status)));
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(!collapsed, el => el.child("Spaces"))
        .child(div().id("space-new").p(4).rounded(5).hover(s => s.bg(t.hover).text_color(t.foreground)).on_click(() => run("space.new")).child("+")))
      .child(v_flex().id("space-list").flex_1().min_h(0).relative()
        .when(Boolean(this.drag?.moved), (el) => el.cursor_grabbing())
        .on_mouse_move((e, cx) => this.dragMove(e, cx))
        .on_mouse_up("left", (_e, cx) => this.endDrag(cx))
        .on_hover((hovered, cx) => { if (!hovered && this.drag) { this.drag = null; cx.notify(); } })
        .child(v_flex().size_full().min_h(0).px(8).pb(14).overflow_y_scrollbar().mode("always")
          .children(this.grouped(t, collapsed)))
        .when(!collapsed && Boolean(this.drag?.moved), (el) => { const g = this.ghost(t); return g ? el.child(g) : el; }));
  }
}
