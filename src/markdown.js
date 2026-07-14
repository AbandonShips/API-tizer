// Minimal, dependency-free, XSS-safe markdown -> HTML renderer.
// All raw text is HTML-escaped FIRST, then a limited set of markdown
// constructs are applied. No raw HTML from the model is ever injected.
import { t } from './i18n.js';

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function unescapeHtml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// Lightweight, dependency-free syntax highlighter. Operates on RAW code and
// re-escapes every piece through escapeHtml, so the output is always XSS-safe.
const HL_PATTERNS = [
  ['comment', /\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\//],
  ['string', /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/],
  ['number', /\b\d+(?:\.\d+)?\b/],
  ['keyword', /\b(?:function|return|if|else|elif|for|while|const|let|var|new|class|import|export|from|default|async|await|def|print|lambda|with|try|except|catch|finally|throw|raise|switch|case|break|continue|in|of|do|yield|typeof|instanceof|extends|super|interface|type|enum|struct|func|fn|package|use|pub|mut|impl|public|private|protected|static|void|this|self|null|nil|undefined|true|false|True|False|None)\b/],
];
const HL_COMBINED = new RegExp(HL_PATTERNS.map(([, re]) => '(' + re.source + ')').join('|'), 'g');

function highlightCode(rawCode) {
  let out = '';
  let last = 0;
  let m;
  HL_COMBINED.lastIndex = 0;
  while ((m = HL_COMBINED.exec(rawCode)) !== null) {
    if (m.index > last) out += escapeHtml(rawCode.slice(last, m.index));
    let cls = 'plain';
    for (let g = 0; g < HL_PATTERNS.length; g++) {
      if (m[g + 1] !== undefined) { cls = HL_PATTERNS[g][0]; break; }
    }
    out += `<span class="tok-${cls}">${escapeHtml(m[0])}</span>`;
    last = m.index + m[0].length;
    if (m[0].length === 0) HL_COMBINED.lastIndex++; // guard against zero-width matches
  }
  if (last < rawCode.length) out += escapeHtml(rawCode.slice(last));
  return out;
}

function inline(text) {
  let t = text;
  const links = [];
  // inline code
  t = t.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  // bold
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  // italic
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // links [text](url) — only http/https/mailto allowed
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
    (_, label, url) => {
      const key = `\u0000LINK${links.length}\u0000`;
      links.push(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
      return key;
    });
  // bare URLs — common in provider citations. Trim punctuation that usually
  // belongs to the sentence, not the URL.
  t = t.replace(/(^|[\s(])((?:https?:\/\/|mailto:)[^\s<]+)/g, (_, lead, rawUrl) => {
    let url = rawUrl;
    let tail = '';
    while (/[.,!?;:)]$/.test(url)) {
      tail = url.slice(-1) + tail;
      url = url.slice(0, -1);
    }
    if (!url) return lead + rawUrl;
    const label = url.length > 88 ? url.slice(0, 84) + '...' : url;
    return `${lead}<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>${tail}`;
  });
  t = t.replace(/\u0000LINK(\d+)\u0000/g, (_, idx) => links[Number(idx)] || '');
  return t;
}

export function renderMarkdown(src) {
  if (!src) return '';
  const escaped = escapeHtml(src);
  const lines = escaped.split('\n');
  let html = '';
  let i = 0;
  let listType = null; // 'ul' | 'ol'

  const closeList = () => {
    if (listType) { html += `</${listType}>`; listType = null; }
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      closeList();
      const lang = (fence[1] || '').toLowerCase();
      i++;
      let code = '';
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        code += lines[i] + '\n';
        i++;
      }
      i++; // skip closing fence
      // `code` is HTML-escaped here (whole source was escaped up front); recover
      // the raw text so the highlighter and copy button get the real characters.
      const rawCode = unescapeHtml(code.replace(/\n$/, ''));
      const highlighted = highlightCode(rawCode);
      const langLabel = escapeHtml(lang || 'code');
      const copyData = encodeURIComponent(rawCode);
      html += `<div class="code-block"><div class="code-bar">` +
        `<span class="code-lang">${langLabel}</span>` +
        `<button type="button" class="code-copy" data-code="${copyData}" title="${t('ext.copy_code_title')}">${t('ext.copy')}</button>` +
        `</div><pre><code>${highlighted}</code></pre></div>`;
      continue;
    }

    // Markdown table (GFM style): header | ... | then separator |---|... then rows
    // Works on the already-escaped lines. Cells get inline() applied.
    const isTableHeader = /\|/.test(line);
    const nextLine = (i + 1 < lines.length) ? lines[i + 1] : '';
    const isTableSep = /^\s*\|?\s*[:\-]+\s*\|?/.test(nextLine) && /\|/.test(nextLine);
    if (isTableHeader && isTableSep) {
      closeList();
      // collect header
      const headerCells = line.split('|').map(c => c.trim()).filter((c, idx, arr) => !(idx === 0 && !arr[0]) && !(idx === arr.length-1 && !c));
      let j = i + 2;
      const rows = [];
      while (j < lines.length) {
        const r = lines[j];
        if (!/\|/.test(r) || /^\s*$/.test(r)) break;
        // skip if looks like another sep or heading etc. rough guard
        if (/^\s*\|?\s*[:\-]+\s*\|?\s*$/.test(r)) { j++; continue; }
        const cells = r.split('|').map(c => c.trim()).filter((c, idx, arr) => !(idx === 0 && !arr[0]) && !(idx === arr.length-1 && !c));
        if (cells.length) rows.push(cells);
        j++;
      }
      // build table html (cells already escaped by top-level escapeHtml)
      let t = '<table><thead><tr>';
      for (const cell of headerCells) t += `<th>${inline(cell)}</th>`;
      t += '</tr></thead>';
      if (rows.length) {
        t += '<tbody>';
        for (const row of rows) {
          t += '<tr>';
          for (const cell of row) t += `<td>${inline(cell)}</td>`;
          t += '</tr>';
        }
        t += '</tbody>';
      }
      t += '</table>';
      html += t;
      i = j;
      continue;
    }

    // headings
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      closeList();
      const level = h[1].length;
      html += `<h${level}>${inline(h[2])}</h${level}>`;
      i++; continue;
    }

    // horizontal rule
    if (/^(---|\*\*\*|___)\s*$/.test(line)) {
      closeList(); html += '<hr/>'; i++; continue;
    }

    // blockquote
    if (/^&gt;\s?/.test(line)) {
      closeList();
      html += `<blockquote>${inline(line.replace(/^&gt;\s?/, ''))}</blockquote>`;
      i++; continue;
    }

    // unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; }
      html += `<li>${inline(line.replace(/^\s*[-*+]\s+/, ''))}</li>`;
      i++; continue;
    }
    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; }
      html += `<li>${inline(line.replace(/^\s*\d+\.\s+/, ''))}</li>`;
      i++; continue;
    }

    // blank line
    if (/^\s*$/.test(line)) { closeList(); i++; continue; }

    // paragraph (gather consecutive plain lines)
    closeList();
    let para = line;
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) &&
           !/^```/.test(lines[i]) && !/^#{1,3}\s/.test(lines[i]) &&
           !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i]) &&
           !/^&gt;\s?/.test(lines[i]) &&
           // stop before table start too
           ! ( /\|/.test(lines[i]) && (i+1 < lines.length) && /\|/.test(lines[i+1]) && /[:\-]/.test(lines[i+1]) )) {
      para += '\n' + lines[i];
      i++;
    }
    html += `<p>${inline(para).replace(/\n/g, '<br/>')}</p>`;
  }
  closeList();
  return html;
}
