// "Run" in flutter-front (opened by my-tabs as a pointer popup, props { cwd, space }): pick an app
// of the repo the space is in (its worktree), then the booted iOS simulator when there are several,
// and a new tab in that space runs `flutter run -d <udid>` in apps/<app>. The tab keeps a shell
// open after flutter quits, so the output stays readable.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, run, exec, props, closeOverlay } from "herdr";
import * as fs from "fs/promises";

export default class RunMenu extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.apps = null; this.sims = null; this.app = null; this.error = null;
    this.cursor = 0; // the highlighted row: Enter takes it, up/down move it
    this.last = localStorage.getItem("app");
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: props()?.cwd });
        if (top.code !== 0) throw new Error("Not in a git repository");
        this.root = top.stdout.trim();
        const names = (await fs.readdir(`${this.root}/apps`)).sort();
        const apps = [];
        for (const n of names) if (await fs.exists(`${this.root}/apps/${n}/ios`).catch(() => false)) apps.push(n);
        // The last one run first.
        this.apps = this.last && apps.includes(this.last) ? [this.last, ...apps.filter((a) => a !== this.last)] : apps;
      } catch (e) { this.error = String(e.message ?? e); }
      cx.notify();
    });
    this.loadSims(cx);
    // A simulator booted while this is open shows up.
    cx.timer.every(2000, (cx) => this.loadSims(cx));
  }

  loadSims(cx) {
    if (this.loadingSims) return;
    this.loadingSims = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("xcrun", ["simctl", "list", "devices", "booted", "-j"]);
        const devices = JSON.parse(r.stdout).devices ?? {};
        const sims = Object.entries(devices).flatMap(([runtime, list]) => list.filter((d) => d.state === "Booted")
          .map((d) => ({ udid: d.udid, name: d.name, os: runtime.split(".").pop().replace(/^iOS-/, "iOS ").replace(/-/g, ".") })));
        const changed = JSON.stringify(sims) !== JSON.stringify(this.sims);
        this.sims = sims;
        if (changed) cx.notify();
      } catch (e) {
        if (this.sims === null) { this.sims = []; this.simError = String(e.message ?? e); cx.notify(); }
      }
      this.loadingSims = false;
    });
  }

  pickApp(app, cx) {
    this.app = app; this.cursor = 0;
    localStorage.setItem("app", app);
    if (this.sims?.length === 1) this.launch(this.sims[0]);
    else cx.notify();
  }

  launch(sim) {
    const space = props()?.space;
    closeOverlay(props().overlay);
    run("tab.new", {
      name: `▶ ${this.app}`, space, folder: `${this.root}/apps/${this.app}`,
      argv: ["zsh", "-lic", `flutter run -d ${sim.udid}; exec zsh -l`],
    });
  }

  row(id, icon, label, hint, action, t, on = false) {
    return h_flex().id(id).h(31).px(9).gap(10).rounded(7).items_center().flex_none().text_color(t.foreground)
      .when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(t.selected)).cursor_pointer().on_click((_e, cx) => action(cx))
      .child(icon).child(div().flex_1().min_w(0).truncate().child(label)).child(div().text_size(11).text_color(t.dim).child(hint));
  }

  render() {
    const t = theme();
    const sims = this.sims ?? [], step2 = this.app !== null;
    const title = (text) => div().px(9).pt(6).pb(4).text_size(11).text_color(t.dim).child(text);
    const note = (text) => div().px(9).py(6).text_color(t.dim).child(text);
    const noSim = this.sims !== null && !sims.length;
    const count = step2 ? sims.length : this.apps?.length ?? 0;
    if (this.cursor >= count) this.cursor = Math.max(0, count - 1);
    const items = step2
      ? sims.map((s, i) => this.row(`sim-${s.udid}`, svg("mods/run-menu/phone.svg").size(14).text_color(t.muted), s.name, `${s.os}${i < 9 ? `  ${i + 1}` : ""}`, () => this.launch(s), t, i === this.cursor))
      : (this.apps ?? []).map((a, i) => this.row(`app-${a}`, svg("mods/run-menu/play.svg").size(13).text_color(t.muted), a, `${a === this.last ? "last  " : ""}${i < 9 ? i + 1 : ""}`, (cx) => this.pickApp(a, cx), t, i === this.cursor));
    // A popup is as tall as its content, and a scrolling list has none of its own: the height is
    // worked out from what is shown (title 30, row 31, note 30, separator 11).
    const notes = (this.error ? 1 : 0) + (!this.error && this.apps === null ? 1 : 0) + (!step2 && this.apps?.length === 0 ? 1 : 0) + (step2 && this.sims === null ? 1 : 0);
    const height = Math.min(460, 10 + 30 + items.length * 31 + notes * 30 + (noSim ? 11 + 30 + 31 : 0));
    return v_flex().id("run-menu").w_full().h(height).bg(t.popover).p(5).text_size(12.8).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.modifiers.control || e.modifiers.platform || e.modifiers.alt) return;
        const take = (n) => { if (step2 && sims[n]) this.launch(sims[n]); else if (!step2 && this.apps?.[n]) this.pickApp(this.apps[n], cx); };
        if (e.key === "down" || e.key === "up") {
          if (count) this.cursor = (this.cursor + (e.key === "down" ? 1 : count - 1)) % count;
          cx.stop_propagation(); cx.notify(); return;
        }
        if (e.key === "enter") { take(this.cursor); cx.stop_propagation(); return; }
        if (step2 && (e.key === "left" || e.key === "backspace")) {
          this.cursor = Math.max(0, this.apps?.indexOf(this.app) ?? 0); this.app = null; cx.stop_propagation(); cx.notify(); return;
        }
        if (!/^[1-9]$/.test(e.key)) return;
        const n = Number(e.key) - 1;
        if (step2 && sims[n]) this.launch(sims[n]);
        else if (!step2 && this.apps?.[n]) this.pickApp(this.apps[n], cx);
      })
      .child(h_flex().gap(6).items_center()
        .when(step2, (el) => el.child(div().id("back").px(6).py(2).rounded(5).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.app = null; cx.notify(); }).child("‹")))
        .child(div().flex_1().child(title(step2 ? `Run ${this.app} on` : "flutter run — pick an app"))))
      .when(Boolean(this.error), (el) => el.child(note(this.error)))
      .when(!this.error && this.apps === null, (el) => el.child(note("Looking for apps…")))
      .when(!step2 && this.apps?.length === 0, (el) => el.child(note("No app with an ios folder in apps/")))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().children(items))
      .when(step2 && this.sims === null, (el) => el.child(note("Looking for simulators…")))
      // With no simulator: say so on both steps, and offer to start one.
      .when(noSim, (el) => el.child(div().h(1).mx(4).my(5).bg(t.border))
        .child(note(this.simError ? `Couldn't list simulators: ${this.simError}` : "No iOS simulator is running"))
        .child(this.row("open-simulator", svg("mods/run-menu/phone.svg").size(14).text_color(t.muted), "Open Simulator", "", () => { exec("open", ["-a", "Simulator"]).catch(() => {}); }, t)));
  }
}
