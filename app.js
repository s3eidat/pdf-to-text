/* PDF to Text — text read by pdf.js (Mozilla, Apache-2.0), lines and paragraphs rebuilt here. Everything runs in this tab. */
import * as pdfjsLib from "./lib/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.mjs";

const { $, $$, h } = S3;
const MAX_MARKS = 3000;

// ---------- core (pure, testable) ----------
function openJs(bytes) { return pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 }).promise; }
const RTL_CH = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/g, LTR_CH = /[A-Za-zÀ-ɏЀ-ӿ]/g;
// items on one line: [{str, x, w, h, dir}] (x = left edge as shown). Joins them in reading order, adding spaces at gaps.
function joinLine(items) {
  const rtlN = items.reduce((s, it) => s + (it.str.match(RTL_CH) || []).length, 0), ltrN = items.reduce((s, it) => s + (it.str.match(LTR_CH) || []).length, 0);
  const rtl = rtlN > ltrN, seq = items.slice().sort((a, b) => rtl ? b.x - a.x : a.x - b.x);
  let out = "", prev = null;
  for (const it of seq) {
    if (prev) {
      const gap = rtl ? prev.x - (it.x + it.w) : it.x - (prev.x + prev.w), hh = Math.max(1, Math.min(prev.h, it.h) || prev.h || it.h);
      if ((gap > hh * 0.17 || gap < -hh * 1.5) && !/\s$/.test(out) && !/^\s/.test(it.str)) out += " ";
    }
    out += it.str; prev = it;
  }
  return out.replace(/\s+/g, " ").trim();
}
// raw text items in shown coordinates -> paragraphs of lines
function buildParagraphs(items) {
  const xs = items.filter(it => it.str && it.str.trim() !== "" || (it.str === " ")).filter(it => it.str.trim());
  xs.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const it of xs) {
    const L = lines[lines.length - 1];
    if (L && Math.abs(it.y - L.y) <= Math.max(2, Math.min(L.h, it.h) * 0.45)) { L.items.push(it); L.h = Math.max(L.h, it.h); }
    else lines.push({ y: it.y, h: it.h, items: [it] });
  }
  const done = lines.map(l => ({ y: l.y, h: l.h, text: joinLine(l.items) })).filter(l => l.text);
  const gaps = []; for (let i = 1; i < done.length; i++) { const d = done[i].y - done[i - 1].y; if (d > 0) gaps.push(d); }
  gaps.sort((a, b) => a - b);
  const med = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0, paras = [];
  done.forEach((l, i) => {
    const p = done[i - 1], d = p ? l.y - p.y : 0;
    const brk = !p || d > Math.max(med * 1.45, l.h * 1.9) || Math.abs(l.h - p.h) > Math.max(l.h, p.h) * 0.25 || d < 0;
    if (brk) paras.push([l.text]); else paras[paras.length - 1].push(l.text);
  });
  return paras;
}
async function pageParagraphs(page) {
  const vp = page.getViewport({ scale: 1 }), tc = await page.getTextContent(), U = pdfjsLib.Util;
  const items = tc.items.filter(it => typeof it.str === "string").map(it => {
    const m = U.transform(vp.transform, it.transform), hh = Math.hypot(m[2], m[3]) || it.height || 10, horiz = Math.abs(m[1]) < Math.abs(m[0]) * 0.2 || !m[0];
    return { str: it.str, x: m[4], y: m[5], w: horiz ? it.width : 0, h: hh, dir: it.dir };
  });
  return buildParagraphs(items);
}
function reflowPara(lines) { // join lines, mending words split with a hyphen at the line end
  return lines.reduce((s, l) => !s ? l : /[A-Za-zÀ-ɏ]-$/.test(s) && /^[a-zß-ɏ]/.test(l) ? s.slice(0, -1) + l : s + " " + l, "");
}
const countWords = s => (s.match(/[^\s\-–—•·|]+/g) || []).length;
function pageStats(paras) { const t = paras.map(reflowPara).join("\n"); return { words: countWords(t), chars: t.replace(/\s/g, "").length, hasText: t.trim().length > 0 }; }
// pages: [paragraphs]. opts: {seps, reflow, md}
function formatAll(pages, opts) {
  const out = [];
  pages.forEach((paras, i) => {
    const body = paras.map(p => opts.reflow || opts.md ? reflowPara(p) : p.join("\n")).join("\n\n");
    if (opts.md) out.push((opts.seps || pages.length > 1 ? "## Page " + (i + 1) + "\n\n" : "") + (body || "_(no text on this page)_"));
    else out.push((opts.seps ? "——— Page " + (i + 1) + " ———\n\n" : "") + body);
  });
  return out.filter(s => s.trim()).join(opts.md || opts.seps ? "\n\n" : "\n\n\n").trim() + "\n";
}
function countMatches(text, q) { if (!q) return 0; let n = 0, i = 0; const T = text.toLowerCase(), Q = q.toLowerCase(); while ((i = T.indexOf(Q, i)) >= 0) { n++; i += Q.length; } return n; }

// ---------- UI ----------
const st = { file: null, base: "", js: null, pages: [], stats: [], run: 0, cur: -1 };
const opts = Object.assign({ seps: true, reflow: false }, S3.store("totext.opt") || {});
$("#seps").checked = opts.seps; $("#reflow").checked = opts.reflow;
["seps", "reflow"].forEach(k => $("#" + k).addEventListener("change", () => { opts[k] = $("#" + k).checked; S3.store("totext.opt", opts); render(); }));

function render() {
  const out = $("#out"), q = $("#q").value; out.innerHTML = "";
  let marks = 0;
  const addText = (parent, text) => {
    if (!q || marks >= MAX_MARKS) { parent.appendChild(document.createTextNode(text)); return; }
    const T = text.toLowerCase(), Q = q.toLowerCase(); let i = 0, j;
    while ((j = T.indexOf(Q, i)) >= 0 && marks < MAX_MARKS) {
      if (j > i) parent.appendChild(document.createTextNode(text.slice(i, j)));
      parent.appendChild(h("mark", { text: text.slice(j, j + q.length) })); marks++; i = j + q.length;
    }
    if (i < text.length) parent.appendChild(document.createTextNode(text.slice(i)));
  };
  st.pages.forEach((paras, i) => {
    const chunk = h("div", { "class": "tx-chunk", "data-page": i, dir: "auto" });
    if (opts.seps) chunk.appendChild(h("span", { "class": "tx-sep", text: "——— PAGE " + (i + 1) + " ———" }));
    if (!st.stats[i].hasText) { if (opts.seps) chunk.appendChild(h("span", { "class": "tx-none", text: "No text layer on this page (probably a scanned image).\n" })); }
    else addText(chunk, paras.map(p => opts.reflow ? reflowPara(p) : p.join("\n")).join("\n\n") + "\n");
    if (chunk.childNodes.length) { if (i && out.lastChild) out.appendChild(document.createTextNode("\n")); out.appendChild(chunk); }
  });
  const total = st.pages.reduce((s, paras) => s + countMatches(paras.map(p => opts.reflow ? reflowPara(p) : p.join("\n")).join("\n\n"), q), 0);
  $("#hits").textContent = q ? (total ? total + " match" + (total > 1 ? "es" : "") + (total > marks ? " (" + marks + " shown)" : "") : "No matches") : "—";
  $("#hits").className = "chip" + (q && total ? " accent" : "");
  st.cur = -1; if (q && marks) step(1);
}
function step(dir) {
  const ms = $$("#out mark"); if (!ms.length) return;
  if (ms[st.cur]) ms[st.cur].classList.remove("cur");
  st.cur = (st.cur + dir + ms.length) % ms.length;
  const m = ms[st.cur], out = $("#out"); m.classList.add("cur");
  out.scrollTop = Math.max(0, m.offsetTop - out.offsetTop - out.clientHeight / 3);
}
$("#q").addEventListener("input", S3.debounce(render, 200));
$("#q").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); } });
$("#hPrev").addEventListener("click", () => step(-1));
$("#hNext").addEventListener("click", () => step(1));

function showStats() {
  const s = $("#stats"); s.innerHTML = "";
  const words = st.stats.reduce((a, x) => a + x.words, 0), chars = st.stats.reduce((a, x) => a + x.chars, 0), withT = st.stats.filter(x => x.hasText).length, none = st.stats.length - withT;
  [[words.toLocaleString(), "words"], [chars.toLocaleString(), "characters"], [withT + " / " + st.stats.length, "pages with text"], [String(none), "pages without text"]]
    .forEach(([v, l]) => s.appendChild(h("div", { "class": "stat" }, [h("b", { text: v }), h("span", { text: l })])));
  const rows = $("#rows"); rows.innerHTML = "";
  st.stats.forEach((x, i) => rows.appendChild(h("tr", { "data-page": i, tabindex: "0", title: "Show page " + (i + 1) }, [h("td", { text: String(i + 1) }), h("td", { text: x.words.toLocaleString() }),
    h("td", {}, [h("span", { "class": "chip " + (x.hasText ? "ok" : "warn"), text: x.hasText ? "yes" : "no text" })])])));
  const w = $("#warn"); w.innerHTML = "";
  if (none) {
    w.hidden = false;
    const list = st.stats.map((x, i) => x.hasText ? null : i + 1).filter(Boolean);
    w.append(h("b", { text: none === st.stats.length ? "No page has a text layer" : none + " page" + (none > 1 ? "s have" : " has") + " no text layer" }),
      " (" + (list.length > 12 ? "pages " + list.slice(0, 12).join(", ") + "…" : "page" + (list.length > 1 ? "s " : " ") + list.join(", ")) + "). These are probably scanned images. This tool doesn't do OCR, so there's no text to pull from them.");
  } else w.hidden = true;
}
function jumpTo(i) { const c = $('.tx-chunk[data-page="' + i + '"]'), out = $("#out"); if (c) out.scrollTop = c.offsetTop - out.offsetTop; }
$("#rows").addEventListener("click", e => { const tr = e.target.closest("tr"); if (tr) jumpTo(+tr.dataset.page); });
$("#rows").addEventListener("keydown", e => { const tr = e.target.closest("tr"); if (tr && e.key === "Enter") jumpTo(+tr.dataset.page); });

async function openFile(file) {
  const run = ++st.run;
  try {
    const bytes = new Uint8Array(await S3.readFile(file));
    let js;
    try { js = await openJs(bytes); }
    catch (e) { throw new Error(e && e.name === "PasswordException" ? "This PDF needs a password to open. Remove the protection first." : "This file couldn't be read as a PDF."); }
    if (st.js) st.js.destroy();
    Object.assign(st, { file, base: file.name.replace(/\.pdf$/i, "") || "document", js, pages: [], stats: [] });
    $("#fname").textContent = file.name;
    $("#fmeta").textContent = js.numPages + " page" + (js.numPages > 1 ? "s" : "") + " · " + S3.fmtBytes(file.size);
    $("#dropCard").hidden = true; $("#work").hidden = false; $("#progress").hidden = false; $("#out").innerHTML = ""; $("#stats").innerHTML = ""; $("#rows").innerHTML = "";
    for (let i = 1; i <= js.numPages; i++) {
      if (run !== st.run) return;
      const paras = await pageParagraphs(await js.getPage(i));
      st.pages.push(paras); st.stats.push(pageStats(paras));
      $("#bar").style.width = (i / js.numPages * 100) + "%"; $("#ptext").textContent = "Reading page " + i + " of " + js.numPages;
      if (i % 25 === 0) await new Promise(r => setTimeout(r, 0));
    }
    $("#progress").hidden = true; showStats(); render();
  } catch (e) { $("#progress").hidden = true; S3.toast(e.message || String(e), "error"); }
}
$("#cancel").addEventListener("click", () => { st.run++; $("#progress").hidden = true; showStats(); render(); S3.toast("Stopped. Showing the pages read so far."); });
const fileInput = S3.drop($("#drop"), files => openFile(files[0]), { accept: ".pdf,application/pdf", multiple: false });
$("#change").addEventListener("click", () => fileInput.click());
const text = md => formatAll(st.pages, { seps: opts.seps, reflow: opts.reflow, md });
$("#copy").addEventListener("click", () => { if (st.pages.length) { S3.copy(text(false)); S3.done(); } });
$("#txt").addEventListener("click", () => { if (st.pages.length) { S3.download(text(false), st.base + ".txt", "text/plain;charset=utf-8"); S3.done(); } });
$("#md").addEventListener("click", () => { if (st.pages.length) { S3.download(text(true), st.base + ".md", "text/markdown;charset=utf-8"); S3.done(); } });

// ---------- a tiny PDF writer (this tool ships without pdf-lib) for the sample and the self-test ----------
function rawPdf(pages) { // pages: [{w, h, rot, ops}] ops = content stream using /F1 (Helvetica) and /F2 (Courier)
  const objs = [], add = s => { objs.push(s); return objs.length; };
  add("<< /Type /Catalog /Pages 2 0 R >>"); add(""); add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
  const kids = pages.map(p => {
    const c = add("<< /Length " + p.ops.length + " >>\nstream\n" + p.ops + "\nendstream");
    return add("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + p.w + " " + p.h + "]" + (p.rot ? " /Rotate " + p.rot : "") + " /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents " + c + " 0 R >>");
  });
  objs[1] = "<< /Type /Pages /Kids [" + kids.map(k => k + " 0 R").join(" ") + "] /Count " + kids.length + " >>";
  let s = "%PDF-1.4\n"; const off = [];
  objs.forEach((o, i) => { off.push(s.length); s += (i + 1) + " 0 obj\n" + o + "\nendobj\n"; });
  const x = s.length;
  s += "xref\n0 " + (objs.length + 1) + "\n0000000000 65535 f \n" + off.map(o => String(o).padStart(10, "0") + " 00000 n \n").join("");
  s += "trailer\n<< /Size " + (objs.length + 1) + " /Root 1 0 R >>\nstartxref\n" + x + "\n%%EOF";
  return Uint8Array.from(s, ch => ch.charCodeAt(0) & 255);
}
const pdfStr = t => "(" + t.replace(/[\\()]/g, "\\$&") + ")";
const tj = (font, size, x, y, t) => "BT /" + font + " " + size + " Tf " + x + " " + y + " Td " + pdfStr(t) + " Tj ET\n";

function samplePdf() {
  const body = [
    ["Why local-first tools matter", 20],
    ["Most online converters upload your file to a server, process it there and send", 11],
    ["the result back. That is convenient, but it means a copy of your contract, bank", 11],
    ["statement or medical letter now lives on somebody else's computer.", 11],
    ["", 0],
    ["Tools that run in the browser work differently. The page downloads once, and", 11],
    ["from then on every byte stays on your device. There is nothing to leak, nothing", 11],
    ["to retain, and privacy is a property of the design, not a promise in a policy.", 11],
    ["", 0],
    ["What you give up", 15],
    ["Very large jobs can be slower on an old phone, and some features (like OCR on", 11],
    ["scanned pages) need heavy models that are not bundled here yet.", 11]
  ];
  let y = 760, ops = "";
  body.forEach(([t, s]) => { if (!s) { y -= 14; return; } ops += tj("F1", s, 56, y, t); y -= s >= 15 ? s + 14 : 17; });
  let ops2 = tj("F1", 15, 56, 760, "Checklist") ;
  ["1. Open the page once while online.", "2. Drop your file; watch the network tab stay quiet.", "3. Save the result. Close the tab and it is gone."].forEach((t, i) => { ops2 += tj("F1", 11, 56, 728 - i * 18, t); });
  let ops3 = "0.93 0.91 0.86 rg 0 0 595 842 re f\n0.75 0.72 0.66 rg\n";
  for (let i = 0; i < 26; i++) ops3 += "60 " + (760 - i * 26) + " " + (420 + (i * 37) % 60) + " 9 re f\n";
  return rawPdf([{ w: 595, h: 842, ops }, { w: 595, h: 842, ops: ops2 }, { w: 595, h: 842, ops: ops3 }]);
}
window.S3_DEMO = async () => {
  await openFile(new File([samplePdf()], "Local-first tools.pdf", { type: "application/pdf" }));
  $("#q").value = "privacy"; render();
  $("#out").scrollTop = 0;
  await new Promise(r => setTimeout(r, 300));
};

window.S3_SELFTEST = async () => {
  const fails = [], ok = (c, m) => { if (!c) fails.push(m); };
  // Courier: every glyph is 0.6 em wide, so positions are exact. "Hello"+"World" a space apart, "Data"+"base" touching.
  let p1 = tj("F2", 12, 50, 700, "Hello") + tj("F2", 12, 50 + 36 + 7.2, 700, "World") + tj("F2", 12, 200, 700, "Data") + tj("F2", 12, 228.8, 700, "base");
  ["The quick brown fox", "jumps over the lazy", "dog."].forEach((t, i) => { p1 += tj("F2", 12, 50, 650 - i * 14, t); });
  ["Second para-", "graph here."].forEach((t, i) => { p1 += tj("F2", 12, 50, 580 - i * 14, t); });
  const pdf = rawPdf([{ w: 600, h: 800, ops: p1 }, { w: 600, h: 800, ops: "0.5 g 50 50 200 200 re f" }, { w: 400, h: 600, rot: 90, ops: tj("F1", 14, 40, 300, "Rotated page text") }]);
  const js = await openJs(pdf), pages = [];
  for (let i = 1; i <= 3; i++) pages.push(await pageParagraphs(await js.getPage(i)));
  js.destroy();
  ok(pages[0].length === 3, "3 paragraphs on page 1: " + JSON.stringify(pages[0]));
  ok(pages[0][0] && pages[0][0][0] === "Hello World Database", "words joined by gaps: " + JSON.stringify(pages[0][0]));
  ok(pages[0][1] && pages[0][1].join("|") === "The quick brown fox|jumps over the lazy|dog.", "lines kept in a paragraph");
  ok(pages[0][2] && reflowPara(pages[0][2]) === "Second paragraph here.", "hyphen mended on reflow");
  const s = pages.map(pageStats);
  ok(s[0].words === 15 && s[1].hasText === false && s[1].words === 0 && s[2].hasText, "stats + empty page detected " + JSON.stringify(s));
  ok(pages[2][0] && pages[2][0][0] === "Rotated page text", "rotated page read");
  const txt = formatAll(pages, { seps: true, reflow: true }), md = formatAll(pages, { seps: true, md: true });
  ok(txt.indexOf("——— Page 1 ———") === 0 && txt.indexOf("The quick brown fox jumps over the lazy dog.") > 0, "txt with separators");
  ok(/## Page 2\n\n_\(no text on this page\)_/.test(md) && md.indexOf("## Page 3") > 0, "markdown output");
  ok(joinLine([{ str: "بكم", x: 50, w: 30, h: 12 }, { str: "مرحبا", x: 100, w: 40, h: 12 }]) === "مرحبا بكم", "right-to-left line order");
  ok(countMatches("The cat and the hat. THE end", "the") === 3, "search count");
  return fails.length ? fails : true;
};
