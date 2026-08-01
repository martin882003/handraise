// ANSI SGR → safe HTML for the live terminal.
//
// `tmux capture-pane -e` keeps the attributes, but the browser does not speak
// escape sequences. Here we interpret colors and emphasis only, and drop every
// other control byte. Text is ALWAYS escaped before it enters the HTML, so a
// terminal control sequence can never become markup.

const BASIC = [
  '#1f2430', '#ff6b72', '#51d88a', '#f4bd50',
  '#6ea8fe', '#b89cff', '#56d4dd', '#d8dee9',
];
const BRIGHT = [
  '#667085', '#ff8d93', '#79e4a5', '#ffd477',
  '#92bfff', '#d0b9ff', '#7be5eb', '#ffffff',
];

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function color256(index) {
  const n = Math.max(0, Math.min(255, Number(index) || 0));
  if (n < 8) return BASIC[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n < 232) {
    const cube = n - 16;
    const level = (v) => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${level(Math.floor(cube / 36))},${level(Math.floor(cube / 6) % 6)},${level(cube % 6)})`;
  }
  const gray = 8 + (n - 232) * 10;
  return `rgb(${gray},${gray},${gray})`;
}

function styleOf(state) {
  const styles = [];
  if (state.fg) styles.push(`color:${state.fg}`);
  if (state.bg) styles.push(`background-color:${state.bg}`);
  if (state.bold) styles.push('font-weight:700');
  if (state.dim) styles.push('opacity:.72');
  if (state.italic) styles.push('font-style:italic');
  if (state.underline) styles.push('text-decoration:underline');
  return styles.join(';');
}

function applySgr(state, raw) {
  const codes = raw === '' ? [0] : raw.split(';').map((part) => Number(part) || 0);
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code === 0) Object.assign(state, { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false });
    else if (code === 1) state.bold = true;
    else if (code === 2) state.dim = true;
    else if (code === 3) state.italic = true;
    else if (code === 4) state.underline = true;
    else if (code === 22) { state.bold = false; state.dim = false; }
    else if (code === 23) state.italic = false;
    else if (code === 24) state.underline = false;
    else if (code >= 30 && code <= 37) state.fg = BASIC[code - 30];
    else if (code >= 90 && code <= 97) state.fg = BRIGHT[code - 90];
    else if (code === 39) state.fg = null;
    else if (code >= 40 && code <= 47) state.bg = BASIC[code - 40];
    else if (code >= 100 && code <= 107) state.bg = BRIGHT[code - 100];
    else if (code === 49) state.bg = null;
    else if ((code === 38 || code === 48) && codes[i + 1] === 5 && codes[i + 2] !== undefined) {
      state[code === 38 ? 'fg' : 'bg'] = color256(codes[i + 2]);
      i += 2;
    } else if ((code === 38 || code === 48) && codes[i + 1] === 2 && codes.length > i + 4) {
      const rgb = codes.slice(i + 2, i + 5).map((value) => Math.max(0, Math.min(255, value)));
      state[code === 38 ? 'fg' : 'bg'] = `rgb(${rgb.join(',')})`;
      i += 4;
    }
  }
}

// OSC, SGR, any other CSI, and two-byte escapes. Only SGR reaches the state;
// everything else is consumed so it can never reach the page.
const ANSI = /\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[([0-9;]*)m|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]/g;

export function ansiToHtml(value = '') {
  const text = String(value);
  const state = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false };
  let html = '';
  let cursor = 0;
  let open = false;
  for (const match of text.matchAll(ANSI)) {
    html += escapeHtml(text.slice(cursor, match.index));
    if (open) { html += '</span>'; open = false; }
    if (match[1] !== undefined) applySgr(state, match[1]);
    const style = styleOf(state);
    if (style) { html += `<span style="${style}">`; open = true; }
    cursor = match.index + match[0].length;
  }
  html += escapeHtml(text.slice(cursor));
  if (open) html += '</span>';
  return html;
}
