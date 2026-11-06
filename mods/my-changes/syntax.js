// Syntax colors as VSCode draws them: Dark+ (Dark Modern's tokens) while Herdr is dark, Light
// (Visual Studio) while it's light. Values from VSCode's theme-defaults/themes/*.json. Dart's
// identifiers go by its naming rules where VSCode would use the analyzer's semantic tokens:
// Capitalized is a type, followed by "(" is a function, the rest are variables.
// Sticky regexes, no slicing: mods run in a slow interpreter with a time limit per step.

const DARK = {
  text: "#CCCCCC", keyword: "#569CD6", control: "#C586C0", type: "#4EC9B0", function: "#DCDCAA",
  variable: "#9CDCFE", string: "#CE9178", number: "#B5CEA8", comment: "#6A9955", constant: "#569CD6",
  escape: "#D7BA7D", interpolation: "#569CD6", key: "#9CDCFE",
};
// Light (Visual Studio) colors no types, functions or variables.
const LIGHT = {
  text: "#000000", keyword: "#0000FF", control: "#0000FF", type: "#000000", function: "#000000",
  variable: "#000000", string: "#A31515", number: "#098658", comment: "#008000", constant: "#0000FF",
  escape: "#A31515", interpolation: "#0000FF", key: "#0451A5",
};
export const palette = (dark) => (dark ? DARK : LIGHT);

export function languageOf(path) {
  if (/\.dart$/i.test(path)) return "dart";
  if (/\.(json|arb|jsonc)$/i.test(path)) return "json";
  return null;
}

// Dart's grammar: keyword.control (VSCode's purple in Dark+), the rest keyword/storage (blue).
const CONTROL = new Set("if else for while do switch case default break continue return try on catch finally throw rethrow assert await yield async sync in is when new".split(" "));
const KEYWORDS = new Set("import export part of library show hide as deferred class enum extension mixin typedef with implements extends abstract static final const var late required factory get set operator external covariant sealed base interface void this super".split(" "));
const CONSTANTS = new Set(["true", "false", "null"]);
// Classes the analyzer colors as types although they're lowercase.
const TYPES = new Set(["int", "double", "num", "bool", "dynamic", "Never", "Object", "Function"]);

// 1 comment, 2 block comment start, 3 raw, 4 quote, 5 number, 6 annotation, 7 identifier, 8 anything else.
const CODE = /(\/\/.*)|(\/\*)|(r?)('''|"""|'|")|(0[xX][0-9a-fA-F]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)|(@[A-Za-z_]\w*)|([A-Za-z_$][\w$]*)|([^\S]+|[^\sA-Za-z_$0-9'"\/@]+|.)/y;
const CALL = /\s*(?:<[^()]*>)?\s*\(/y;
const BODY = { "'": /[^\\$']+/y, '"': /[^\\$"]+/y, "'''": /(?:[^\\$']|'(?!''))+/y, '"""': /(?:[^\\$"]|"(?!""))+/y };
const RAW_BODY = { "'": /[^']+/y, '"': /[^"]+/y, "'''": /(?:[^']|'(?!''))+/y, '"""': /(?:[^"]|"(?!""))+/y };
const SIMPLE_INTERPOLATION = /\$[A-Za-z_]\w*/y;

function dart(line, state) {
  const out = [];
  const push = (text, kind) => {
    if (!text) return;
    const last = out[out.length - 1];
    // Whitespace has no color: it joins its neighbour, so a line draws fewer pieces.
    if (last && (last.kind === kind || /^\s+$/.test(text))) last.text += text;
    else if (last && /^\s+$/.test(last.text)) { last.text += text; last.kind = kind; }
    else out.push({ text, kind });
  };
  let i = 0;
  // A string's body from i: its end, or the line's end inside ''' / """ (then the state to carry).
  const string = (quote, raw) => {
    const body = raw ? RAW_BODY[quote] : BODY[quote];
    while (i < line.length) {
      body.lastIndex = i;
      const m = body.exec(line);
      if (m) { push(m[0], "string"); i += m[0].length; continue; }
      if (line.startsWith(quote, i)) { push(quote, "string"); i += quote.length; return null; }
      const c = line[i];
      if (c === "\\") { push(line.substr(i, 2), "escape"); i += 2; continue; }
      if (c === "$" && line[i + 1] === "{") {
        push("${", "interpolation"); i += 2;
        let depth = 1, from = i;
        while (i < line.length && depth) { const ch = line[i]; if (ch === "{") depth++; else if (ch === "}") depth--; if (depth) i++; }
        for (const tok of dart(line.substring(from, i), null).tokens) push(tok.text, tok.kind);
        if (i < line.length) { push("}", "interpolation"); i++; }
        continue;
      }
      SIMPLE_INTERPOLATION.lastIndex = i;
      const v = SIMPLE_INTERPOLATION.exec(line);
      if (v) { push("$", "interpolation"); push(v[0].slice(1), "variable"); i += v[0].length; continue; }
      push(c, "string"); i++;
    }
    return quote.length === 3 ? { quote, raw } : null;
  };

  if (state?.comment) {
    const end = line.indexOf("*/");
    if (end < 0) return { tokens: [{ text: line, kind: "comment" }], state };
    push(line.substring(0, end + 2), "comment"); i = end + 2; state = null;
  } else if (state?.quote) {
    state = string(state.quote, state.raw);
    if (state) return { tokens: out, state };
  }

  while (i < line.length) {
    CODE.lastIndex = i;
    const m = CODE.exec(line);
    if (!m) break;
    if (m[1] !== undefined) { push(m[1], "comment"); break; }
    if (m[2] !== undefined) {
      const end = line.indexOf("*/", i + 2);
      if (end < 0) { push(line.substring(i), "comment"); return { tokens: out, state: { comment: true } }; }
      push(line.substring(i, end + 2), "comment"); i = end + 2; continue;
    }
    if (m[4] !== undefined) {
      push(m[3] + m[4], "string"); i += m[0].length;
      state = string(m[4], Boolean(m[3]));
      if (state) return { tokens: out, state };
      continue;
    }
    i += m[0].length;
    if (m[5] !== undefined) { push(m[5], "number"); continue; }
    if (m[6] !== undefined) { push(m[6], "keyword"); continue; }
    if (m[7] !== undefined) {
      const word = m[7];
      CALL.lastIndex = i;
      const kind = CONSTANTS.has(word) ? "constant"
        : CONTROL.has(word) ? "control"
        : KEYWORDS.has(word) ? "keyword"
        : TYPES.has(word) || /^_*[A-Z]/.test(word) ? "type"
        : CALL.test(line) ? "function"
        : "variable";
      push(word, kind); continue;
    }
    push(m[8], "text");
  }
  return { tokens: out, state: null };
}

function json(line) {
  const out = [];
  const re = /("(?:[^"\\]|\\.)*"?)(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|(\/\/.*$)|(\s+|[^"\s\d\-tfn\/]+|.)/g;
  let m;
  while ((m = re.exec(line)) && m[0]) {
    const last = out[out.length - 1];
    const add = (text, kind) => { if (last && last.kind === kind && out[out.length - 1] === last) last.text += text; else out.push({ text, kind }); };
    if (m[1]) { out.push({ text: m[1], kind: m[2] ? "key" : "string" }); if (m[2]) out.push({ text: m[2], kind: "text" }); }
    else if (m[3]) out.push({ text: m[3], kind: "number" });
    else if (m[4]) out.push({ text: m[4], kind: "constant" });
    else if (m[5]) out.push({ text: m[5], kind: "comment" });
    else add(m[0], "text");
  }
  return { tokens: out, state: null };
}

// Colors one line; `state` comes from the line before on the same side of the diff.
export function highlight(language, line, state) {
  if (language === "dart") return dart(line, state);
  if (language === "json") return json(line);
  return { tokens: [{ text: line, kind: "text" }], state: null };
}
