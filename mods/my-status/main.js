import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, terminals, theme, run, window, exec, shared, setShared, appHome, readTextFile, watchFolder } from "herdr";
import * as fs from "fs/promises";

const SAMPLES = 30;
// caffeinate holds for this long per run: below exec's 30 s limit, and the Mac can sleep
// again at most this long after the last agent stops (or the app quits).
const HOLD = 25;
// The theme has no orange; the same one the spaces list uses for the merge queue.
const ORANGE = "#ffb86c";

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.cpu = [];
    this.memory = null; // { used, total } in bytes
    this.holding = false;
    this.tasks = {};
    this.watchTasks(cx);
    this.sampleLoad(cx);
    cx.timer.every(3000, (cx) => this.sampleLoad(cx));
  }

  sampleLoad(cx) {
    if (this.sampling) return;
    this.sampling = true;
    cx.spawn(async (cx) => {
      try {
        // top's first sample is the average since boot; the second is the last second.
        const top = await exec("top", ["-l", "2", "-n", "0", "-s", "1"]);
        const idle = [...top.stdout.matchAll(/CPU usage:.*?([\d.]+)% idle/g)].pop()?.[1];
        if (idle !== undefined) this.cpu = [...this.cpu, 100 - Number(idle)].slice(-SAMPLES);

        const [vm, sys] = await Promise.all([exec("vm_stat"), exec("sysctl", ["-n", "hw.memsize"])]);
        const pages = (label) => Number(vm.stdout.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? 0);
        const pageSize = Number(vm.stdout.match(/page size of (\d+) bytes/)?.[1] ?? 0);
        // Activity Monitor's "Memory Used": app memory + wired + compressed.
        const used = (pages("Anonymous pages") - pages("Pages purgeable") + pages("Pages wired down") + pages("Pages occupied by compressor")) * pageSize;
        this.memory = { used, total: Number(sys.stdout.trim()) };
      } catch {}
      this.sampling = false;
      cx.notify();
    });
  }

  // Claude's background shells and subagents (~/.claude/hooks/herdr-app-tasks.py, one file per
  // Claude terminal): a pane that only waits on one reads idle, but its work still runs.
  watchTasks(cx) {
    const dir = `${appHome()}/data/claude-tasks`;
    const isTaskFile = (f) => /\/?t[^/]*\.json$/.test(f);
    const load = async (file) => {
      const address = file.split("/").pop().replace(/\.json$/, "");
      try {
        const text = await readTextFile(`${dir}/${address}.json`);
        if (text) this.tasks[address] = Object.keys(JSON.parse(text).tasks ?? {}).length;
        else delete this.tasks[address];
      } catch {
        delete this.tasks[address];
      }
    };
    cx.spawn(async (cx) => {
      try {
        await fs.mkdir(dir, { recursive: true });
        for (const f of (await fs.readdir(dir)).filter(isTaskFile)) await load(f);
      } catch {}
      cx.notify();
      for (;;) {
        const changed = (await watchFolder(dir)).filter(isTaskFile);
        if (!changed.length) continue;
        for (const f of new Set(changed)) await load(f);
        cx.notify();
      }
    });
  }

  // Only tasks of a live terminal: a file left by a Claude that quit holds nothing.
  backgroundWork() {
    const live = new Set(terminals().filter((t) => t.state === "live").map((t) => t.address));
    return Object.entries(this.tasks).some(([address, n]) => n > 0 && live.has(address));
  }

  // Called from render, which reruns whenever agents or shared state change; each
  // caffeinate run ends with a notify, so the next render starts the next one.
  keepAwake(cx) {
    const wanted = shared("keepAwake.enabled") === true && (agents().some((a) => a.status === "working") || this.backgroundWork());
    if (!wanted || this.holding) return;
    this.holding = true;
    cx.spawn(async (cx) => {
      try {
        await exec("caffeinate", ["-i", "-t", String(HOLD)]);
      } catch {}
      this.holding = false;
      cx.notify();
    });
  }

  render(cx) {
    this.keepAwake(cx);
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const awake = shared("keepAwake.enabled") === true;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    const meter = (share, color) => div().w(36).h(5).rounded(3).bg(t.border).child(div().h_full().rounded(3).bg(color).w(Math.round(36 * Math.min(1, share))));
    const load = (percent) => (percent > 90 ? t.ansi1 : percent > 80 ? ORANGE : t.muted);
    const cpu = this.cpu.at(-1);
    const memory = this.memory?.total ? (100 * this.memory.used) / this.memory.total : undefined;
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .when(cpu !== undefined, el => el.child(h_flex().gap(6).items_center().text_color(load(cpu))
        .child("CPU")
        .child(h_flex().h(12).w(SAMPLES * 2).items_end().children(this.cpu.map(v => div().w(2).h(Math.max(1, Math.round(12 * v / 100))).bg(load(cpu)))))
        .child(div().w(30).child(`${Math.round(cpu)}%`))))
      .when(memory !== undefined, el => el.child(h_flex().gap(6).items_center().text_color(load(memory))
        .child("MEM")
        .child(meter(memory / 100, load(memory)))
        .child(div().w(30).child(`${Math.round(memory)}%`))))
      .child(h_flex().id("keep-awake").gap(5).items_center().px(6).py(2).rounded(5).cursor_pointer().hover(s => s.bg(t.hover))
        .text_color(this.holding ? t.working : awake ? t.ansi10 : t.dim)
        .on_click((_e, cx) => { setShared("keepAwake.enabled", !awake); cx.notify(); })
        .child(svg("mods/my-status/cup.svg").size(13))
        .child(this.holding ? "Keeping awake" : awake ? "Keep awake: on" : "Keep awake: off"))
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(`${window()?.platform === "macos" ? "⌘" : "Ctrl"} Shift P  commands`));
  }
}
