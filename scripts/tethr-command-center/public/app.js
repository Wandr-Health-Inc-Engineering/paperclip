/* Tethr Command Center — vanilla JS, no build, no deps.
   Reads the 00 Tethr folder via the local server and renders Markdown nicely,
   with new-folder / rename / move / archive. */
"use strict";

const $ = (sel, el = document) => el.querySelector(sel);
const state = {
  tree: [],
  folders: [], // flat list of {path,label} for the move picker
  expanded: new Set([""]),
  selected: null,
};

/* ----------------------------------------------------------- api */

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
const post = (path, body) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/* ----------------------------------------------------------- tree */

async function loadTree(keepSelection = true) {
  const data = await api("/api/tree");
  state.tree = data.tree || [];
  state.folders = [{ path: "", label: "00 Tethr (root)" }];
  collectFolders(state.tree, 0);
  $("#rootPath").textContent = data.root || "00 Tethr";
  renderTree();
  if (keepSelection && state.selected && !findNode(state.tree, state.selected)) {
    // selection was moved/archived away
    state.selected = null;
    renderEmpty();
  }
}

function collectFolders(nodes, depth) {
  for (const n of nodes) {
    if (n.kind === "folder") {
      state.folders.push({ path: n.path, label: `${"— ".repeat(depth)}${n.name}` });
      collectFolders(n.children || [], depth + 1);
    }
  }
}

function findNode(nodes, path) {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.kind === "folder") {
      const hit = findNode(n.children || [], path);
      if (hit) return hit;
    }
  }
  return null;
}

function renderTree() {
  const root = $("#tree");
  root.innerHTML = "";
  root.appendChild(renderLevel(state.tree, 0));
}

function renderLevel(nodes, depth) {
  const frag = document.createDocumentFragment();
  for (const node of nodes) {
    const wrap = document.createElement("div");
    wrap.className = "node";
    const row = document.createElement("div");
    row.className = `row ${node.kind}`;
    if (state.selected === node.path) row.classList.add("selected");

    if (node.kind === "folder") {
      const open = state.expanded.has(node.path);
      const twist = document.createElement("span");
      twist.className = "twist";
      twist.textContent = open ? "▾" : "▸";
      row.appendChild(twist);
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = node.name;
      row.appendChild(label);
      row.onclick = () => {
        if (open) state.expanded.delete(node.path);
        else state.expanded.add(node.path);
        renderTree();
      };
      wrap.appendChild(row);
      if (open && node.children?.length) {
        const kids = document.createElement("div");
        kids.className = "children";
        kids.appendChild(renderLevel(node.children, depth + 1));
        wrap.appendChild(kids);
      }
    } else {
      const glyph = document.createElement("span");
      glyph.className = "glyph";
      glyph.textContent = /\.(md|markdown)$/i.test(node.name) ? "▤" : "·";
      row.appendChild(document.createElement("span")).className = "twist";
      row.appendChild(glyph);
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = node.name;
      row.appendChild(label);
      row.onclick = () => selectFile(node);
      wrap.appendChild(row);
    }
    frag.appendChild(wrap);
  }
  return frag;
}

/* ----------------------------------------------------------- reader */

function renderEmpty() {
  $("#reader").innerHTML =
    '<div class="empty"><p>Select a file on the left to read it.</p>' +
    '<p class="muted">Markdown renders here. Use the toolbar to rename, move, or archive.</p></div>';
}

async function selectFile(node) {
  state.selected = node.path;
  renderTree();
  const reader = $("#reader");
  reader.innerHTML = '<div class="empty"><p class="muted">Reading…</p></div>';
  let data;
  try {
    data = await api(`/api/file?path=${encodeURIComponent(node.path)}`);
  } catch (err) {
    reader.innerHTML = `<div class="empty"><p>${escapeHtml(err.message)}</p></div>`;
    return;
  }

  const head = document.createElement("div");
  head.className = "file-head";
  const title = document.createElement("div");
  title.className = "file-title";
  title.textContent = node.name;
  head.appendChild(title);
  const meta = document.createElement("div");
  meta.className = "file-meta";
  meta.textContent = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : "00 Tethr";
  head.appendChild(meta);

  const tools = document.createElement("div");
  tools.className = "file-tools";
  tools.appendChild(mkBtn("Rename", () => renameDialog(node)));
  tools.appendChild(mkBtn("Move", () => moveDialog(node)));
  tools.appendChild(mkBtn("Archive", () => archiveNode(node)));
  head.appendChild(tools);

  const body = document.createElement("div");
  if (data.kind === "text") {
    body.className = "doc";
    if (/\.(md|markdown)$/i.test(node.name)) body.innerHTML = renderMarkdown(data.content);
    else {
      const pre = document.createElement("div");
      pre.className = "raw";
      pre.textContent = data.content;
      body.appendChild(pre);
    }
  } else {
    body.className = "doc";
    const msg =
      data.kind === "toolarge"
        ? "This file is too large to preview here."
        : data.kind === "missing"
          ? "This file no longer exists (it may have been moved in Finder)."
          : "This file type can't be previewed. Open it in Finder or Google Drive.";
    body.innerHTML = `<p class="muted">${msg}</p>`;
  }

  reader.innerHTML = "";
  reader.appendChild(head);
  reader.appendChild(body);
}

function mkBtn(text, onClick) {
  const b = document.createElement("button");
  b.className = "btn";
  b.textContent = text;
  b.onclick = onClick;
  return b;
}

/* ----------------------------------------------------------- markdown (safe) */

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function safeHref(url) {
  const u = String(url).trim();
  return /^(https?:|mailto:|#|\/)/i.test(u) ? u : "#";
}

function renderInline(text) {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t, u) => `<a href="${safeHref(u)}" target="_blank" rel="noopener">${t}</a>`);
  s = s.replace(/(\*\*|__)(.+?)\1/g, (_m, _d, t) => `<strong>${t}</strong>`);
  s = s.replace(/(^|[^*_])[*_]([^*_]+)[*_](?=[^*_]|$)/g, (_m, pre, t) => `${pre}<em>${t}</em>`);
  return s;
}

function renderMarkdown(md) {
  const lines = String(md ?? "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let para = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${renderInline(para.join(" "))}</p>`);
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code
    if (/^\s*```/.test(line)) {
      flushPara();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence
      out.push(`<pre><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }
    // front-matter (--- ... ---) at top: render as muted meta block
    if (i === 0 && line.trim() === "---") {
      const buf = [];
      i++;
      while (i < lines.length && lines[i].trim() !== "---") buf.push(lines[i++]);
      i++;
      out.push(`<pre class="muted"><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }
    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      const lvl = Math.min(h[1].length, 4);
      out.push(`<h${lvl}>${renderInline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }
    // hr
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      out.push("<hr />");
      i++;
      continue;
    }
    // table (a header row followed by a |---| separator)
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      flushPara();
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(splitRow(lines[i++]));
      let t = "<table><thead><tr>" + header.map((c) => `<th>${renderInline(c)}</th>`).join("") + "</tr></thead><tbody>";
      for (const r of rows) t += "<tr>" + r.map((c) => `<td>${renderInline(c)}</td>`).join("") + "</tr>";
      t += "</tbody></table>";
      out.push(t);
      continue;
    }
    // blockquote
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${renderInline(buf.join(" "))}</blockquote>`);
      continue;
    }
    // lists
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      flushPara();
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ""));
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((it) => `<li>${renderInline(it)}</li>`).join("")}</${tag}>`);
      continue;
    }
    // blank line -> paragraph break
    if (line.trim() === "") {
      flushPara();
      i++;
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flushPara();
  return out.join("\n");
}

function splitRow(line) {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

/* ----------------------------------------------------------- actions */

function newFolderDialog(parentPath = "") {
  openModal({
    title: "New folder",
    bodyHtml: `<label>Folder name</label><input id="mInput" placeholder="e.g. 08 Reports" />
      <label style="margin-top:12px">Inside</label>${folderSelect(parentPath)}`,
    confirm: "Create",
    onConfirm: async () => {
      const name = $("#mInput").value.trim();
      const parent = $("#mSelect").value;
      if (!name) return "A name is required";
      await post("/api/folder", { parent, name });
      state.expanded.add(parent);
      await loadTree();
      toast("Folder created");
    },
  });
}

function renameDialog(node) {
  openModal({
    title: "Rename",
    bodyHtml: `<label>New name</label><input id="mInput" value="${escapeHtml(node.name)}" />`,
    confirm: "Rename",
    onConfirm: async () => {
      const name = $("#mInput").value.trim();
      if (!name) return "A name is required";
      const res = await post("/api/rename", { path: node.path, name });
      if (state.selected === node.path) state.selected = res.path;
      await loadTree();
      const n = findNode(state.tree, res.path);
      if (n && n.kind === "file") selectFile(n);
      toast("Renamed");
    },
  });
}

function moveDialog(node) {
  openModal({
    title: "Move",
    bodyHtml: `<label>Move “${escapeHtml(node.name)}” into</label>${folderSelect("")}`,
    confirm: "Move",
    onConfirm: async () => {
      const dest = $("#mSelect").value;
      const res = await post("/api/move", { path: node.path, dest });
      if (state.selected === node.path) state.selected = res.path;
      state.expanded.add(dest);
      await loadTree();
      const n = findNode(state.tree, res.path);
      if (n && n.kind === "file") selectFile(n);
      toast("Moved");
    },
  });
}

async function archiveNode(node) {
  if (!confirm(`Move “${node.name}” to 99 Archive? It stays recoverable there.`)) return;
  try {
    await post("/api/archive", { path: node.path });
    if (state.selected === node.path) {
      state.selected = null;
      renderEmpty();
    }
    await loadTree();
    toast("Archived");
  } catch (err) {
    toast(err.message);
  }
}

function folderSelect(selectedPath) {
  const opts = state.folders
    .map((f) => `<option value="${escapeHtml(f.path)}"${f.path === selectedPath ? " selected" : ""}>${escapeHtml(f.label)}</option>`)
    .join("");
  return `<select id="mSelect">${opts}</select>`;
}

/* ----------------------------------------------------------- modal + toast */

let modalConfirmHandler = null;

function openModal({ title, bodyHtml, confirm, onConfirm }) {
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = bodyHtml;
  $("#modalConfirm").textContent = confirm || "OK";
  modalConfirmHandler = onConfirm;
  $("#modal").hidden = false;
  const input = $("#mInput");
  if (input) {
    input.focus();
    input.select();
    input.onkeydown = (e) => {
      if (e.key === "Enter") $("#modalConfirm").click();
    };
  }
}

function closeModal() {
  $("#modal").hidden = true;
  modalConfirmHandler = null;
}

async function runConfirm() {
  if (!modalConfirmHandler) return;
  const btn = $("#modalConfirm");
  btn.disabled = true;
  const prevErr = $("#modalBody .modal-err");
  if (prevErr) prevErr.remove();
  try {
    const err = await modalConfirmHandler();
    if (err) {
      const p = document.createElement("p");
      p.className = "modal-err";
      p.textContent = err;
      $("#modalBody").appendChild(p);
      btn.disabled = false;
      return;
    }
    closeModal();
  } catch (e) {
    const p = document.createElement("p");
    p.className = "modal-err";
    p.textContent = e.message || "Something went wrong";
    $("#modalBody").appendChild(p);
    btn.disabled = false;
  }
}

let toastTimer = null;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

/* ----------------------------------------------------------- boot */

$("#btnRefresh").onclick = () => loadTree().then(() => toast("Refreshed"));
$("#btnNewFolder").onclick = () => newFolderDialog(state.selected && findNode(state.tree, state.selected)?.kind === "folder" ? state.selected : "");
$("#modalClose").onclick = closeModal;
$("#modalCancel").onclick = closeModal;
$("#modalConfirm").onclick = runConfirm;
$("#modal").onclick = (e) => {
  if (e.target === $("#modal")) closeModal();
};

loadTree(false).catch((err) => {
  $("#reader").innerHTML = `<div class="empty"><p>${escapeHtml(err.message)}</p><p class="muted">Is the Command Center server running?</p></div>`;
});
