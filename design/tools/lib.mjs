// Shared drawing primitives for PiDock reference screens.
// Output is plain SVG so the same file can be imported into Figma or rendered
// to PNG for Google Stitch references.

export const C = {
  canvas: "#F7F7F4",
  surface: "#FFFFFF",
  sunken: "#EFEFEA",
  sidebar: "#F1F1EC",
  code: "#F3F3EF",
  ink: "#17191C",
  ink2: "#3E4750",
  muted: "#66707A",
  line: "#E3E2DC",
  lineStrong: "#CFCFC7",
  primary: "#2B4ACB",
  primaryHover: "#1F3AA8",
  primarySoft: "#E9EEFC",
  attention: "#8A5300",
  attentionSoft: "#FBF0DC",
  danger: "#A93630",
  dangerSoft: "#FBEAE8",
  settled: "#2F4858",
  settledSoft: "#E8EDF0",
  overlay: "#17191C",
  white: "#FFFFFF",
};

export const F = {
  sans: "PingFang SC, Helvetica Neue, Arial, sans-serif",
  mono: "Menlo, SF Mono, monospace",
};

export const W = 1440;
export const H = 900;
export const SIDEBAR = 264;
export const TOPBAR = 56;

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

export function text(x, y, s, o = {}) {
  const {
    size = 14,
    weight = 400,
    fill = C.ink,
    family = F.sans,
    anchor = "start",
    spacing = 0,
    opacity = 1,
  } = o;
  return `<text x="${x}" y="${y}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" letter-spacing="${spacing}" opacity="${opacity}">${esc(s)}</text>`;
}

// Text vertically centred inside a box.
export function tmid(x, top, height, size, s, o = {}) {
  return text(x, top + height / 2 + size * 0.36, s, { ...o, size });
}

export function rect(x, y, w, h, o = {}) {
  const {
    fill = "none",
    stroke = "none",
    rx = 0,
    sw = 1,
    opacity = 1,
    dash = "",
  } = o;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`;
}

export function line(x1, y1, x2, y2, o = {}) {
  const { stroke = C.line, sw = 1, dash = "", opacity = 1 } = o;
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`;
}

export function circle(cx, cy, r, o = {}) {
  const { fill = "none", stroke = "none", sw = 1, opacity = 1 } = o;
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}"/>`;
}

const ICONS = {
  home: "M3 10.5 12 3l9 7.5V21H3z M9 21v-6h6v6",
  inbox: "M3 13h5l1.5 3h5L16 13h5 M4 5h16l1 8v6H3v-6z",
  clock: "M12 7v5l3 2 M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z",
  folder: "M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  branch: "M6 4v10a3 3 0 0 0 3 3h6 M6 8h8a4 4 0 0 1 4 4v1 M6 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M18 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  plus: "M12 5v14 M5 12h14",
  search: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z M15.5 15.5 20 20",
  dots: "M6 12h.01 M12 12h.01 M18 12h.01",
  alert: "M12 4 3 20h18z M12 9v5 M12 17h.01",
  check: "M4 12.5 9.5 18 20 6",
  stop: "M7 7h10v10H7z",
  arrowUp: "M12 19V5 M6 11l6-6 6 6",
  arrowRight: "M5 12h14 M13 6l6 6-6 6",
  chevronDown: "M6 9l6 6 6-6",
  chevronRight: "M9 6l6 6-6 6",
  close: "M6 6l12 12 M18 6 6 18",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21h-4v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3v-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6V3h4v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.1v4H21a1.7 1.7 0 0 0-1.6 1z",
  plug: "M9 3v6 M15 3v6 M6 9h12v2a6 6 0 0 1-12 0z M12 17v4",
  book: "M4 4h7a3 3 0 0 1 3 3v13a3 3 0 0 0-3-3H4z M20 4h-4a3 3 0 0 0-3 3v13a3 3 0 0 1 3-3h4z",
  play: "M8 5l11 7-11 7z",
  archive: "M3 7h18v4H3z M5 11v9h14v-9 M9 15h6",
  trash: "M4 7h16 M9 7V4h6v3 M6 7l1 14h10l1-14",
  file: "M6 3h8l4 4v14H6z M14 3v5h5",
  refresh: "M20 11a8 8 0 1 0-2 5 M20 4v7h-7",
  link: "M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1 M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1",
  calendar: "M4 6h16v15H4z M4 10h16 M8 3v4 M16 3v4",
  message: "M4 5h16v11H9l-5 4z",
  stopCircle: "M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z M9 9h6v6H9z",
  panel: "M4 4h16v16H4z M15 4v16",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21a8 8 0 0 1 16 0",
  spark: "M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z",
  download: "M12 3v12 M7 11l5 5 5-5 M4 21h16",
  external: "M14 4h6v6 M20 4l-9 9 M18 14v5H5V6h5",
  filter: "M3 5h18l-7 8v6l-4 2v-8z",
  code: "M9 7l-5 5 5 5 M15 7l5 5-5 5",
};

export function icon(name, x, y, o = {}) {
  const { size = 16, color = C.ink2, sw = 1.6, opacity = 1 } = o;
  const d = ICONS[name];
  if (!d) throw new Error(`unknown icon ${name}`);
  const scale = size / 24;
  return `<g transform="translate(${x} ${y}) scale(${scale})" fill="none" stroke="${color}" stroke-width="${sw / scale}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}"><path d="${d}"/></g>`;
}

export function textWidth(s, size) {
  let w = 0;
  for (const ch of String(s)) {
    if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) w += size;
    else if (ch === " ") w += size * 0.3;
    else w += size * 0.56;
  }
  return w;
}

export function pill(x, y, label, kind = "running", o = {}) {
  const styles = {
    running: [C.primarySoft, C.primary],
    attention: [C.attentionSoft, C.attention],
    danger: [C.dangerSoft, C.danger],
    settled: [C.settledSoft, C.settled],
    outline: [C.surface, C.muted],
    neutral: [C.sunken, C.ink2],
  };
  const [bg, fg] = styles[kind] ?? styles.neutral;
  const size = o.size ?? 12;
  const h = o.h ?? 24;
  const dot = o.dot !== false;
  const pad = 9;
  const tw = textWidth(label, size) + pad * 2 + (dot ? 13 : 0);
  if (o.align === "right") x -= tw;
  const out = [
    rect(x, y, tw, h, {
      fill: bg,
      stroke: kind === "outline" ? C.line : "none",
      rx: h / 2,
    }),
  ];
  let tx = x + pad;
  if (dot) {
    const dotColor = o.dotColor ?? (kind === "outline" ? C.muted : fg);
    out.push(circle(tx + 3, y + h / 2, 3, { fill: dotColor }));
    tx += 13;
  }
  out.push(tmid(tx, y, h, size, label, { fill: o.fill ?? fg, weight: o.weight ?? 500 }));
  out.push(`<!-- pillw:${Math.round(tw)} -->`);
  return { svg: out.join(""), w: tw };
}

export function avatar(x, y, label, o = {}) {
  const { size = 28, fill = C.primarySoft, color = C.primary } = o;
  return (
    rect(x, y, size, size, { fill, rx: 8 }) +
    text(x + size / 2, y + size / 2 + 4.3, label, { size: 12, weight: 600, fill: color, anchor: "middle" })
  );
}

export function checkbox(x, y, checked = false, o = {}) {
  const size = o.size ?? 16;
  return [
    rect(x, y, size, size, {
      fill: checked ? C.primary : C.surface,
      stroke: checked ? C.primary : C.lineStrong,
      rx: 4,
    }),
    checked ? icon("check", x + 2, y + 2, { size: size - 4, color: C.white, sw: 2.4 }) : "",
  ].join("");
}

export function toggle(x, y, on = true) {
  return [
    rect(x, y, 34, 20, { fill: on ? C.primary : C.lineStrong, rx: 10 }),
    circle(on ? x + 24 : x + 10, y + 10, 7, { fill: C.white }),
  ].join("");
}

export function appFrame(body, o = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${o.bg ?? C.canvas}"/>
${body}
</svg>`;
}

export function sidebar(active = "home", o = {}) {
  const out = [];
  const projectSelected = o.projectSelected !== false;
  const taskSelected = o.taskSelected !== false;
  out.push(rect(0, 0, SIDEBAR, H, { fill: C.sidebar }));
  out.push(line(SIDEBAR - 0.5, 0, SIDEBAR - 0.5, H));
  // Brand
  out.push(rect(20, 18, 30, 30, { fill: C.primary, rx: 9 }));
  out.push(text(35, 39, "π", { size: 20, weight: 600, fill: C.white, anchor: "middle" }));
  out.push(text(60, 30, "PiDock", { size: 15, weight: 600 }));
  out.push(text(60, 46, "本地工作台", { size: 11, fill: C.muted }));
  out.push(rect(196, 22, 52, 22, { fill: C.surface, stroke: C.line, rx: 11 }));
  out.push(circle(207, 33, 3, { fill: C.settled }));
  out.push(text(214, 37, "本机", { size: 11, fill: C.settled }));

  // Search
  out.push(rect(16, 72, 232, 32, { fill: C.surface, stroke: C.line, rx: 7 }));
  out.push(icon("search", 26, 80, { size: 15, color: C.muted }));
  out.push(text(48, 92, "搜索或跳转", { size: 12, fill: C.muted }));
  out.push(rect(206, 79, 32, 18, { fill: C.sunken, rx: 4 }));
  out.push(text(222, 92, "⌘K", { size: 10, fill: C.muted, anchor: "middle" }));

  // Primary nav
  const nav = [
    ["home", "工作台", null],
    ["inbox", "需要处理", "3"],
    ["clock", "定时任务", null],
  ];
  nav.forEach(([key, label, count], i) => {
    const y = 124 + i * 40;
    const on = active === key;
    if (on) {
      out.push(rect(8, y, 248, 34, { fill: C.primarySoft, rx: 7 }));
      out.push(rect(8, y + 6, 3, 22, { fill: C.primary, rx: 1.5 }));
    }
    out.push(icon(key, 20, y + 9, { size: 16, color: on ? C.primary : C.muted }));
    out.push(text(44, y + 22, label, { size: 13, weight: on ? 600 : 400, fill: on ? C.ink : C.ink2 }));
    if (count) {
      out.push(rect(212, y + 8, 22, 18, { fill: C.attentionSoft, rx: 9 }));
      out.push(tmid(223, y + 8, 18, 11, count, { fill: C.attention, weight: 600, anchor: "middle" }));
    }
  });

  // Project list
  out.push(text(20, 278, "项目", { size: 11, weight: 600, fill: C.muted, spacing: 1.2 }));
  out.push(icon("plus", 232, 268, { size: 14, color: C.muted }));
  const projects = [
    ["Atlas 结算系统", "6 个任务", true],
    ["基础设施", "3 个任务", false],
    ["文档站", "2 个任务", false],
    ["个人脚本", "1 个任务", false],
  ];
  let py = 292;
  projects.forEach(([name, meta, selected]) => {
    const on = selected && projectSelected;
    if (on) out.push(rect(8, py - 14, 248, 32, { fill: C.surface, stroke: C.line, rx: 7 }));
    out.push(rect(22, py - 5, 8, 8, { fill: on ? C.primary : C.lineStrong, rx: 2 }));
    out.push(text(40, py + 4, name, { size: 12.5, weight: on ? 600 : 400, fill: on ? C.ink : C.ink2 }));
    out.push(text(40, py + 19, meta, { size: 10.5, fill: C.muted }));
    py += 46;
  });

  // Unassigned tasks
  out.push(line(16, 484, 248, 484, { stroke: C.line }));
  out.push(icon("inbox", 22, 493, { size: 14, color: C.muted }));
  out.push(text(44, 505, "未归属任务", { size: 12.5, fill: C.ink2 }));
  out.push(rect(214, 492, 20, 18, { fill: C.sunken, rx: 9 }));
  out.push(tmid(224, 492, 18, 10, "1", { fill: C.muted, anchor: "middle" }));

  // Current task subtree
  out.push(line(28, 528, 248, 528, { stroke: C.line }));
  out.push(text(20, 550, o.listTitle ?? "当前任务", { size: 11, weight: 600, fill: C.muted, spacing: 1.2 }));
  const tasks = [
    ["修复结算对账", true],
    ["生成发布说明", false],
    ["整理迁移脚本", false],
  ];
  tasks.forEach(([name, selected], i) => {
    const y = 562 + i * 30;
    const on = selected && taskSelected;
    if (on) {
      out.push(rect(8, y, 248, 28, { fill: C.primarySoft, rx: 6 }));
      out.push(rect(8, y + 6, 2, 16, { fill: C.primary }));
    }
    out.push(icon("message", 26, y + 7, { size: 14, color: on ? C.primary : C.muted }));
    out.push(text(48, y + 19, name, { size: 12, weight: on ? 600 : 400, fill: on ? C.ink : C.ink2 }));
  });

  // Bottom
  out.push(line(16, 760, 248, 760, { stroke: C.line }));
  if (active === "settings") {
    out.push(rect(8, 770, 248, 30, { fill: C.primarySoft, rx: 7 }));
    out.push(rect(8, 776, 3, 18, { fill: C.primary, rx: 1.5 }));
  }
  out.push(icon("settings", 20, 778, { size: 15, color: active === "settings" ? C.primary : C.muted }));
  out.push(text(44, 791, "能力与设置", { size: 12.5, weight: active === "settings" ? 600 : 400, fill: active === "settings" ? C.ink : C.ink2 }));
  out.push(icon("plug", 20, 812, { size: 14, color: C.settled }));
  out.push(text(44, 824, "2 个 Provider 已连接", { size: 11, fill: C.muted }));
  out.push(text(20, 862, "PiDock 0.2.0 · Electron", { size: 10, fill: C.muted }));
  return out.join("");
}

export function topbar(title, o = {}) {
  const out = [];
  out.push(rect(SIDEBAR, 0, W - SIDEBAR, TOPBAR, { fill: C.canvas }));
  out.push(line(SIDEBAR, TOPBAR - 0.5, W, TOPBAR - 0.5));
  out.push(text(SIDEBAR + 32, 35, title, { size: 13, weight: 500, fill: C.ink2 }));
  if (o.breadcrumbTail) {
    out.push(text(SIDEBAR + 32 + textWidth(title, 13) + 10, 35, "/", { size: 13, fill: C.lineStrong }));
    out.push(text(SIDEBAR + 32 + textWidth(title, 13) + 24, 35, o.breadcrumbTail, { size: 13, weight: 500, fill: C.ink }));
  }
  let x = W - 32;
  if (o.primary) {
    const label = o.primary;
    const w = textWidth(label, 13) + 30;
    x -= w;
    out.push(rect(x, 13, w, 32, { fill: C.primary, rx: 8 }));
    out.push(icon("plus", x + 10, 21, { size: 14, color: C.white }));
    out.push(tmid(x + 28, 13, 32, 13, label, { fill: C.white, weight: 500 }));
    x -= 12;
  }
  if (o.secondary) {
    const label = o.secondary;
    const w = textWidth(label, 13) + 24;
    x -= w;
    out.push(rect(x, 13, w, 32, { fill: C.surface, stroke: C.line, rx: 8 }));
    out.push(tmid(x + 12, 13, 32, 13, label, { fill: C.ink2 }));
    x -= 12;
  }
  if (o.meta) {
    out.push(text(x, 35, o.meta, { size: 12, fill: C.muted, anchor: "end" }));
    x -= textWidth(o.meta, 12) + 16;
  }
  out.push(icon("search", x - 20, 20, { size: 16, color: C.muted }));
  out.push(icon("dots", x - 52, 20, { size: 16, color: C.muted }));
  return out.join("");
}

export function sectionTitle(x, y, title, o = {}) {
  const out = [text(x, y, title, { size: o.size ?? 16, weight: 600 })];
  if (o.action) {
    out.push(text(x + (o.width ?? 0), y, o.action, { size: 12, fill: C.primary, anchor: "end" }));
  }
  return out.join("");
}

export function field(x, y, w, label, value, o = {}) {
  const out = [text(x, y, label, { size: 12, weight: 500, fill: C.ink2 })];
  const h = o.h ?? 34;
  out.push(rect(x, y + 8, w, h, { fill: C.surface, stroke: C.line, rx: 7 }));
  out.push(tmid(x + 12, y + 8, h, 13, value, { fill: o.mutedValue ? C.muted : C.ink }));
  if (o.chevron) out.push(icon("chevronDown", x + w - 26, y + 8 + (h - 14) / 2, { size: 14, color: C.muted }));
  return out.join("");
}

export function toolCard(x, y, w, name, summary, status = "已完成", o = {}) {
  const out = [];
  const h = o.h ?? 56;
  out.push(rect(x, y, w, h, { fill: C.surface, stroke: C.line, rx: 9 }));
  out.push(icon(o.icon ?? "file", x + 14, y + 18, { size: 16, color: C.muted }));
  out.push(text(x + 40, y + 22, name, { size: 13, weight: 500, family: F.mono }));
  out.push(text(x + 40, y + 40, summary, { size: 11.5, fill: C.muted }));
  const p = pill(x + w - 150, y + 16, status, status === "失败" ? "danger" : "settled", { size: 11, h: 22, dot: false });
  out.push(p.svg);
  out.push(text(x + w - 16, y + 33, "查看", { size: 11.5, fill: C.primary, anchor: "end" }));
  return out.join("");
}

export function chip(x, y, label, o = {}) {
  const size = o.size ?? 11;
  const h = o.h ?? 22;
  const w = textWidth(label, size) + 18;
  return {
    svg:
      rect(x, y, w, h, { fill: o.fill ?? C.sunken, stroke: o.stroke ?? "none", rx: 5 }) +
      tmid(x + 9, y, h, size, label, { fill: o.color ?? C.ink2, family: o.mono === false ? F.sans : F.mono }),
    w,
  };
}

export function scrim() {
  return rect(0, 0, W, H, { fill: C.overlay, opacity: 0.38 });
}
