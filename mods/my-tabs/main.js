import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, run, openOverlay, closeOverlay, nextCommand, theme, window, shared, setShared, layout, settings, terminals, exec, home, notify } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const PR_NAME = "gh-dash";

// The active space when it's in flutter-front (main checkout or a worktree) on this computer:
// where "Run" (run-menu) runs an app. Its first terminal's folder, else the space's own.
function runTarget() {
  const space = spaces().find(p => p.active);
  if (!space || space.machine) return null;
  const tabs = new Set((space.tabs ?? []).map(c => c.id));
  const cwd = panes().find(p => tabs.has(p.tab) && p.cwd)?.cwd || space.folder;
  return /\/flutter-front(\/|$)/.test(cwd ?? "") ? { cwd, space: space.id } : null;
}

// The Changes tab of the active space (my-changes): selected if it's open, else made. The side
// panel's old Changes view is closed on the way.
function openChanges() {
  const space = spaces().find(p => p.active);
  if (!space) return;
  const panel = find(layout(), "panel"), body = find(layout(), "panel-body");
  if (panel && !panel.hidden && body?.active === "changes") run("layout.hide", { id: "panel" });
  const tab = (space.tabs ?? []).find(c => panes().some(p => p.tab === c.id && p.mod === "my-changes"));
  tab ? run("tab.select", { id: tab.id }) : run("tab.new", { name: "Changes", space: space.id, mod: "my-changes", props: { space: space.id } });
}

function openRun(target, at) {
  openOverlay({ mod: "run-menu", kind: "popup", width: 280, height: 460, props: target, ...(at ? { at } : {}) });
}

// One gh dash terminal for every space and every opening: started once (again only if gh dash was
// quit), shown in a window that remembers its place. The terminal has no space labels, so it stays
// out of the tabs and lists, and closing the window leaves it running.
function openPullRequests(cx) {
  cx.spawn(async () => {
    const live = (address) => terminals().some((t) => t.address === address && t.state === "live");
    let address = shared("pullRequests.terminal");
    if (!live(address)) address = terminals().find((t) => t.name === PR_NAME && t.state === "live")?.address;
    if (!live(address)) {
      const r = await exec("hc", ["run", "--bg", "--json", "--no-parent", "--name", PR_NAME, "--cwd", `${home()}/Git/flutter-front`, "--", "gh", "dash"]).catch((e) => ({ code: 1, stderr: String(e) }));
      address = r.code === 0 ? JSON.parse(r.stdout).address : null;
      if (!address) { notify({ title: "Couldn't start gh dash", body: (r.stderr || r.stdout || "").trim(), level: "error" }); return; }
      setShared("pullRequests.terminal", address);
    }
    openOverlay({
      kind: "window", key: "pull-requests", width: 0.8, height: 0.8,
      layout: { type: "column", children: [
        { type: "block", size: { px: 32 }, content: { mod: "pr-window-bar" } },
        { type: "block", content: { terminal: address } },
      ] },
    });
  });
}

// Same query as gh dash's "Needs My Review" tab, which adds the repo it runs in. hc exec runs gh
// with herdr-core's PATH, where gh is (the app's own PATH may not have it).
const REVIEW_QUERY = "repo:betclicgroup/flutter-front is:pr is:open user-review-requested:@me draft:false";
const REVIEW_POLL_MS = 3 * 60 * 1000;

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    this.reviews = null;
    this.countReviews(cx);
    cx.timer.every(REVIEW_POLL_MS, (cx) => this.countReviews(cx));
    // Key binding "my-tabs.pull-requests" (keys.json): opens the Pull requests window, or closes it.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        // Key binding "my-tabs.run" (keys.json): the Run menu, under the Run button's usual place.
        if (command === "run") {
          const target = runTarget();
          if (!target) { notify({ title: "Run is for flutter-front spaces", level: "info", timeout: 2500 }); continue; }
          const zoom = settings().zoom ?? 1, side = find(layout(), "sidebar");
          const left = side?.hidden ? 0 : side?.size?.px ?? 0;
          openRun(target, { x: Math.max(0, left + (this.barWidth ?? 900) / zoom - 380), y: 38 });
          continue;
        }
        // Key binding "my-tabs.changes" (keys.json).
        if (command === "changes") { openChanges(); continue; }
        if (command !== "pull-requests") continue;
        const open = shared("pullRequests.overlay");
        if (open) { closeOverlay(open); setShared("pullRequests.overlay", null); this.countReviews(cx); }
        else openPullRequests(cx);
      }
    });
  }

  countReviews(cx) {
    if (this.counting) return;
    this.counting = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("hc", ["exec", "gh", "api", "-X", "GET", "search/issues", "-f", `q=${REVIEW_QUERY}`, "-f", "per_page=1", "--jq", ".total_count"]);
        const n = Number(r.stdout.trim());
        if (r.code === 0 && Number.isInteger(n)) this.reviews = n;
      } catch {}
      this.counting = false;
      cx.notify();
    });
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", () => openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }))
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    // The side panel's Changes is replaced by the Changes tab (my-changes): never restored, and hidden
    // whenever it shows (left open from before, or remembered for a space).
    const enabled = (shared("workspace.panels") ?? ["files", "changes"]).filter(p => p !== "changes");
    this.syncPanel(space, panel, body, enabled);
    const oldChanges = Boolean(panel && !panel.hidden && body?.active === "changes");
    if (oldChanges && !this.hidingChanges) run("layout.hide", { id: "panel" });
    this.hidingChanges = oldChanges;
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    // Changes opens as a tab of its own in this space (my-changes), not in the side panel.
    // In flutter-front (its main checkout or a worktree), on this computer: "Run" opens run-menu,
    // which runs an app on an iOS simulator in a new tab of this space.
    const runAt = runTarget();
    const changesTab = shown.find(c => panes().some(p => p.tab === c.id && p.mod === "my-changes"));
    const changesButton = h_flex().id("tab-changes").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
      .text_size(12).bg(changesTab?.active ? t.selected : t.chrome).text_color(changesTab?.active ? t.foreground : t.muted)
      .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
      .on_click(() => openChanges())
      .child(svg("mods/changes/changes.svg").size(14)).child("Changes");
    return h_flex().id("tabs-bar").size_full().min_w(0).px(10)
      .on_size_change(size => { this.barWidth = size.width; }).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(Boolean(runAt), el => el.child(h_flex().id("tab-run").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(t.chrome).text_color(t.muted).hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => openRun(runAt))
        .child(svg("mods/run-menu/play.svg").size(13)).child("Run")
        .child(svg("mods/workspace-chrome/chevron-down.svg").size(11))))
      .child(changesButton)
      .child(h_flex().id("tab-pull-requests").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(t.chrome).text_color(t.muted).hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click((_e, cx) => { openPullRequests(cx); this.countReviews(cx); })
        .child(svg("mods/workspace-chrome/git-compare.svg").size(14)).child("Pull requests")
        .when(this.reviews > 0, el => el.child(div().h(16).min_w(16).px(5).flex().items_center().justify_center().rounded(8)
          .bg(t.blocked).text_color(t.background).text_size(10.5).font_semibold().child(String(this.reviews)))))
      .when(window()?.buttons, el => el.child(button("minimize", "−", () => run("window.minimize")))
        .child(button("maximize", "□", () => run("window.maximize")))
        .child(button("close-window", svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
