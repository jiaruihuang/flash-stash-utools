// 主面板：搜索 / 浏览 / 复制 / 编辑 / 删除 / 标签管理
import type { Snippet } from "../types.ts";
import type { Store } from "../db.ts";
import type { SearchHit } from "../search.ts";
import { searchSnippets, filterSnippets } from "../search.ts";
import { renderMarkdown } from "../render.ts";
import { snippetExcerpt, formatTime, highlightText, escapeHtml } from "../utils.ts";
import { h, toast, confirmDialog, openModal } from "../ui.ts";
import { attachCodeCopyLayer } from "../code-block-ui.ts";
import { pushEsc } from "../escape.ts";

export interface MainCallbacks {
  onEdit: (s: Snippet) => void;
  onAdd: () => void;
}

interface MainState {
  query: string;
  kind: "" | "text" | "markdown" | "image";
  tags: string[];
}

const MAX_TAG_CHIPS = 6;

const KIND_ICON: Record<Snippet["kind"], string> = { text: "文", markdown: "M↓", image: "图" };
const KIND_LABEL: Record<Snippet["kind"], string> = { text: "文本", markdown: "Markdown", image: "图片" };
export function renderMain(app: HTMLElement, store: Store, cb: MainCallbacks, initQuery = ""): void {
  const state: MainState = { query: initQuery, kind: "", tags: [] };
  // 搜索结果与键盘导航状态（修订3B）
  let hits: SearchHit[] = [];
  let activeIdx = 0;
  app.replaceChildren();

  // ---------- 头部 ----------
  const head = h(
    "div",
    { class: "mv-head" },
    h("div", { class: "mv-logo", text: "闪" }),
    h("div", {},
      h("div", { class: "mv-title", text: "闪藏" }),
      h("div", { class: "mv-sub", text: "瞬间收纳 · 随取随用" })
    ),
    h("div", { class: "mv-head-actions" },
      h("button", { class: "btn ghost", text: "＋ 新增", title: "手动新建一条收藏", onclick: () => cb.onAdd() }),
      h("button", { class: "btn ghost", text: "⚙ 设置", title: "收藏行为设置", onclick: () => openSettings(store) }),
      h("button", {
        class: "btn ghost",
        text: "✦ 标签管理",
        onclick: () => openTagManager(store, refreshAll)
      }),
      h("button", {
        class: "btn ghost",
        text: "⌘ 快捷键",
        title: "前往 uTools 设置「闪藏：保存剪贴板」的全局快捷键",
        onclick: () => {
          try { window.utools?.redirectHotKeySetting("闪藏：保存剪贴板"); } catch { /* 忽略 */ }
        }
      })
    )
  );

  // ---------- 过滤条 ----------
  const filters = h("div", { class: "mv-filters" });
  const list = h("div", { class: "mv-list" });

  function rebuildFilters(): void {
    filters.replaceChildren();
    const kinds: Array<{ key: typeof state.kind; label: string }> = [
      { key: "", label: "全部" },
      { key: "text", label: "文本" },
      { key: "markdown", label: "Markdown" },
      { key: "image", label: "图片" }
    ];
    for (const b of kinds) {
      filters.append(h("button", {
        class: "chip" + (state.kind === b.key ? " active" : ""),
        text: b.label,
        onclick: () => { state.kind = b.key; rebuildFilters(); renderList(); }
      }));
    }
    const allTags = store.listTags();
    if (allTags.length > 0) {
      filters.append(h("span", { style: { width: "1px", height: "16px", background: "var(--border)", margin: "0 4px", flexShrink: "0" } }));
      // 已选标签优先展示；未选标签最多直显 MAX_TAG_CHIPS 个，其余折叠进「更多标签」
      const shown: string[] = [];
      for (const t of allTags) if (state.tags.includes(t.name)) shown.push(t.name);
      let hidden = 0;
      for (const t of allTags) {
        if (state.tags.includes(t.name)) continue;
        if (shown.length >= MAX_TAG_CHIPS) { hidden++; continue; }
        shown.push(t.name);
      }
      for (const name of shown) {
        filters.append(h("button", {
          class: "chip" + (state.tags.includes(name) ? " active" : ""),
          html: '<span class="dot"></span>' + escapeHtml(name),
          onclick: () => {
            state.tags = state.tags.includes(name) ? state.tags.filter((x) => x !== name) : [...state.tags, name];
            rebuildFilters();
            renderList();
          }
        }));
      }
      if (hidden > 0 || allTags.length > MAX_TAG_CHIPS) {
        filters.append(h("button", {
          class: "chip" + (state.tags.length > 0 ? " active" : ""),
          text: "更多标签 (" + allTags.length + ") ⌄",
          onclick: () => openTagPicker(store, state, refreshAll)
        }));
      }
    }
    const all = store.listSnippets();
    filters.append(h("span", {
      text: `共 ${all.length} 条收藏${store.listTags().length > 0 ? " · " + store.listTags().length + " 个标签" : ""}`,
      style: { marginLeft: "auto", fontSize: "11.5px", color: "var(--text-3)", whiteSpace: "nowrap" }
    }));
  }

  function emptyState(): HTMLElement {
    return h("div", { class: "empty" },
      h("div", { class: "empty-ico", text: "✦" }),
      h("div", { class: "empty-tip" },
        h("div", {}, "还没有收藏任何内容"),
        h("div", {}, "① 在任意应用中选中文字 / 图片"),
        h("div", {}, "② 呼出 uTools，点击 <kbd>闪藏：收藏</kbd>"),
        h("div", {}, "或使用快捷键 <kbd>闪藏：保存剪贴板</kbd>")
      )
    );
  }

  /** 复制成功后立即关闭插件窗口（并恢复之前的工作窗口），不做任何停留提示 */
  function leaveAfterCopy(): void {
    try { window.utools?.outPlugin?.(); } catch { /* 忽略 */ }
    try { window.utools?.hideMainWindow?.(true); } catch { /* 忽略 */ }
  }

  function doCopy(s: Snippet): void {
    const closeOnCopy = store.getUxSettings().closeOnCopy === true;
    if (s.kind === "image" && s.imagePath) {
      const r = window.flashStash?.copyImageByPath(s.imagePath);
      if (r && r.ok) {
        if (closeOnCopy) { leaveAfterCopy(); return; }
        toast("图片已复制到剪贴板");
        return;
      }
      toast(r?.error ?? "复制失败", "err");
      return;
    }
    const r = window.flashStash?.copyText(s.content ?? "");
    if (r && r.ok) {
      if (closeOnCopy) { leaveAfterCopy(); return; }
      toast("已复制到剪贴板");
      return;
    }
    if (r) { toast(r.error ?? "复制失败", "err"); return; }
    // 非 uTools 环境兜底
    void navigator.clipboard?.writeText(s.content ?? "").then(() => {
      if (closeOnCopy) leaveAfterCopy();
      else toast("已复制到剪贴板");
    });
  }

  /** 预览弹窗：展示完整内容（Markdown 渲染 / 纯文本 / 图片）+ 备注标签，不触发复制 */
  function openPreview(s: Snippet): void {
    const body = h("div", { class: "pv" });
    if (s.kind === "image") {
      const box = h("div", { class: "pv-img" });
      try {
        if (s.imagePath && window.flashStash) {
          const r = window.flashStash.readImageAsDataUrl(s.imagePath);
          if (r && r.ok) box.append(h("img", { src: r.dataUrl as string, alt: "收藏图片" }));
        }
      } catch { /* 忽略 */ }
      if (!box.firstChild) box.append(h("div", { class: "pv-empty", text: "无法读取图片数据" }));
      body.append(box);
      if (s.imagePath) body.append(h("div", { class: "pv-file", text: String(s.imagePath.split(/[\\/]/).pop()) }));
    } else if (s.kind === "markdown") {
      body.append(h("div", { class: "preview pv-markdown", html: renderMarkdown(s.content ?? "") }));
    } else {
      body.append(h("div", { class: "pv-text", html: highlightText(s.content ?? "", state.query) }));
    }
    if (s.note) {
      body.append(h("div", { class: "card-note pv-note", html: highlightText(s.note, state.query) }));
    }
    if (s.tags.length > 0) {
      const tags = h("div", { class: "pv-tags" }, h("span", { class: "pv-tags-label", text: "标签" }));
      for (const t of s.tags) {
        tags.append(h("span", { class: "tag-chip", html: '<span class="dot"></span>' + escapeHtml(t) }));
      }
      body.append(tags);
    }
    body.append(h("div", { class: "pv-meta" },
      h("span", { class: "tag-chip", text: KIND_LABEL[s.kind] }),
      h("span", { class: "card-time", text: "更新于 " + formatTime(s.updatedAt) })
    ));
    const foot = h("div", { class: "modal-foot", style: { padding: "10px 0 0" } },
      h("button", {
        class: "btn primary",
        text: "复制内容",
        title: "复制完整内容到剪贴板",
        onclick: () => doCopy(s)
      }),
      h("button", { class: "btn", text: "关闭", onclick: () => close() })
    );
    const close = openModal("预览", h("div", {}, body, foot), { width: s.kind === "image" ? "620px" : "600px" });
    attachCodeCopyLayer(body); // 预览弹窗内代码块悬停复制
  }

  function card(hit: SearchHit, index: number): HTMLElement {
    const s = hit.snippet;
    const body: (Node | string)[] = [];
    if (s.kind !== "image") {
      body.push(h("div", { class: "card-excerpt", html: highlightText(snippetExcerpt(s), state.query) }));
    } else {
      // 图片卡片：小缩略图 + 文件名
      const thumb = h("div", { class: "card-thumb" });
      try {
        if (s.imagePath && window.flashStash) {
          const r = window.flashStash.readImageAsDataUrl(s.imagePath);
          if (r && r.ok) thumb.append(h("img", { src: r.dataUrl as string, alt: "收藏图片" }));
        }
      } catch { /* 忽略 */ }
      body.push(thumb);
    }
    if (s.note) {
      body.push(h("div", { class: "card-note", html: highlightText(s.note, state.query) }));
    }
    if (s.tags.length > 0) {
      const chips = h("div", { class: "card-tags" });
      for (const t of s.tags) {
        chips.append(h("span", { class: "tag-chip", html: '<span class="dot"></span>' + escapeHtml(t) }));
      }
      body.push(chips);
    }
    const actions = h("div", { class: "card-actions" },
      h("button", { class: "mini-btn", text: "预览", title: "查看完整内容", onclick: (e: Event) => { e.stopPropagation(); openPreview(s); } }),
      h("button", { class: "mini-btn", text: "复制", onclick: (e: Event) => { e.stopPropagation(); doCopy(s); } }),
      h("button", { class: "mini-btn", text: "编辑", onclick: (e: Event) => { e.stopPropagation(); cb.onEdit(s); } }),
      h("button", {
        class: "mini-btn danger",
        text: "删除",
        onclick: (e: Event) => {
          e.stopPropagation();
          void (async () => {
            if (!(await confirmDialog("删除收藏", "确定删除这条收藏吗？删除后不可恢复。"))) return;
            store.removeSnippet(s);
            if (s.imagePath) { try { window.flashStash?.deleteFile(s.imagePath); } catch { /* 忽略 */ } }
            toast("已删除");
            refreshAll();
          })();
        }
      })
    );
    body.push(h("div", { class: "card-meta" },
      h("span", { class: "card-time", text: formatTime(s.updatedAt) }),
      actions
    ));

    const cardEl = h("div", { class: "card" },
      h("div", { class: `card-ico k-${s.kind}`, text: KIND_ICON[s.kind] }),
      h("div", { class: "card-body" }, ...body)
    );
    cardEl.addEventListener("click", () => doCopy(s));
    cardEl.addEventListener("mouseenter", () => { if (activeIdx !== index) { activeIdx = index; paintActive(); } });
    return cardEl;
  }

  function renderList(): void {
    list.replaceChildren();
    const all = store.listSnippets();
    if (all.length === 0) {
      list.append(emptyState());
      return;
    }
    hits = filterSnippets(searchSnippets(all, store.listTags(), state.query), {
      kind: state.kind,
      tags: state.tags
    });
    if (hits.length === 0) {
      list.append(h("div", { class: "empty" },
        h("div", { class: "empty-ico", text: "🔍" }),
        h("div", { class: "empty-tip", text: state.query ? `没有找到匹配 “${state.query}” 的收藏` : "该分类下暂无收藏" })
      ));
      return;
    }
    hits.forEach((hit, i) => list.append(card(hit, i)));
    activeIdx = 0;
    paintActive();
  }

  function refreshAll(): void {
    rebuildFilters();
    renderList();
  }

  // 自建搜索输入框：uTools 主搜索条不透传键盘事件（↑/↓/Enter），改由插件内输入框接管（修订3B）
  const searchInput = h("input", {
    class: "mv-search",
    placeholder: "搜索收藏内容、标签、备注… （↑↓ 选择 · 回车复制 · Esc 清空）",
    value: state.query,
    oninput: () => { state.query = searchInput.value; renderList(); },
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (hits.length === 0) return;
        e.preventDefault();
        activeIdx = (activeIdx + (e.key === "ArrowDown" ? 1 : -1) + hits.length) % hits.length;
        paintActive();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const hh = hits[activeIdx];
        if (hh) doCopy(hh.snippet);
      }
    }
  });

  function paintActive(): void {
    const els = list.querySelectorAll(".card");
    els.forEach((el, i) => el.classList.toggle("active", i === activeIdx));
    (els[activeIdx] as HTMLElement | undefined)?.scrollIntoView?.({ block: "nearest" });
  }

  const searchWrap = h("div", { class: "mv-search-wrap" },
    h("span", { class: "mv-search-ico", text: "🔍" }),
    searchInput
  );

  app.append(h("div", { class: "mv" }, head, searchWrap, filters, list));
  refreshAll();

  // 主面板 Escape：有搜索词 → 清空并回到全部；无搜索词 → 不消费，交还 uTools 正常退出
  pushEsc(() => {
    if (state.query) {
      state.query = "";
      searchInput.value = "";
      renderList();
      return true;
    }
    return false;
  });

  setTimeout(() => { try { searchInput.focus(); } catch { /* 忽略 */ } }, 30);
}

// ---------- 标签管理弹窗（新建置顶 + 搜索 + 多选批量删除） ----------
function openTagManager(store: Store, refresh: () => void): void {
  const selected = new Set<string>();
  let q = "";
  const body = h("div", {});
  const searchInput = h("input", {
    class: "input", placeholder: "搜索标签…", style: { marginBottom: "8px" }
  }) as HTMLInputElement;
  const newTagInput = h("input", {
    class: "input", placeholder: "＋ 新建标签，回车确认", style: { marginBottom: "10px", borderStyle: "dashed" }
  }) as HTMLInputElement;
  newTagInput.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key !== "Enter") return;
    const re = store.createTag(newTagInput.value);
    const err = (re as { error?: string }).error;
    if (err) toast(err, "err");
    else { newTagInput.value = ""; render(); refresh(); }
  });

  const render = (): void => {
    body.replaceChildren();
    const all = store.listTags();
    const tags = q ? all.filter((t: { name: string }) => t.name.toLowerCase().includes(q.toLowerCase())) : all;
    if (selected.size > 0) {
      body.append(h("div", {
        style: { display: "flex", alignItems: "center", gap: "8px", padding: "6px 0", marginBottom: "4px", borderBottom: "1px solid var(--border)" }
      },
        h("span", { text: "已选 " + selected.size + " 个", style: { fontSize: "12px", color: "var(--accent)" } }),
        h("button", {
          class: "mini-btn", text: "全选/取消",
          onclick: () => { const allSel = tags.every((t: { name: string }) => selected.has(t.name)); for (const t of tags) { if (allSel) selected.delete(t.name); else selected.add(t.name); } render(); }
        }),
        h("button", {
          class: "mini-btn danger", text: "批量删除",
          onclick: () => {
            void (async () => {
              const names = [...selected];
              if (!(await confirmDialog("批量删除标签", "将移除 " + names.length + " 个标签及其关联关系（不删除收藏），继续？"))) return;
              const toDelete = all.filter((t: { name: string }) => selected.has(t.name));
              const count = store.removeTags(toDelete);
              selected.clear();
              toast("已删除 " + count + " 个标签", "ok");
              render(); refresh();
            })();
          }
        })
      ));
    }
    if (tags.length === 0) {
      body.append(h("div", { text: q ? "没有匹配的标签" : "还没有标签，在上方创建一个吧", style: { fontSize: "12.5px", color: "var(--text-3)", padding: "10px 2px" } }));
    }
    for (const t of tags) {
      const usage = store.tagUsage(t.name);
      const row = h("div", { class: "tag-manage-row" },
        h("input", { type: "checkbox", checked: selected.has(t.name), onchange: () => { if (selected.has(t.name)) selected.delete(t.name); else selected.add(t.name); render(); } }),
        h("span", { class: "tname", html: '<span class="dot" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--accent-2)"></span>' + escapeHtml(t.name) }),
        h("span", { class: "tcount", text: usage + " 条" }),
        h("button", {
          class: "mini-btn", text: "重命名",
          onclick: () => {
            const inp = h("input", { class: "input", value: t.name });
            row.replaceChildren(inp, h("span", { class: "tcount", text: usage + " 条" }),
              h("button", { class: "mini-btn", text: "取消", onclick: () => cancelRename() }));
            inp.focus();
            let done = false;
            let escCancel: (() => void) | null = null;
            const cancelRename = (): void => {
              if (done) return; done = true;
              escCancel?.();
              render();
            };
            const commit = (): void => {
              if (done) return; done = true;
              escCancel?.();
              const re = store.renameTag(t, inp.value);
              if (!re.ok) toast(re.error ?? "重命名失败", "err");
              render(); refresh();
            };
            // 重命名输入框的 Escape = 取消本次重命名（注册在弹窗处理器之上）
            escCancel = pushEsc(() => { cancelRename(); return true; });
            inp.addEventListener("keydown", (e2: KeyboardEvent) => { if (e2.key === "Enter") commit(); });
            inp.addEventListener("blur", commit);
          }
        }),
        h("button", {
          class: "mini-btn danger", text: "删除",
          onclick: () => {
            void (async () => {
              if (await confirmDialog("删除标签", "删除标签「" + t.name + "」？将从 " + store.tagUsage(t.name) + " 条收藏中移除，不删除收藏内容。")) {
                store.removeTag(t); render(); refresh();
              }
            })();
          }
        })
      );
      body.append(row);
    }
  };
  searchInput.addEventListener("input", () => { q = searchInput.value.trim(); render(); });
  const wrap = h("div", {}, newTagInput, searchInput, body);
  openModal("标签管理", wrap);
  render();
}

// ---------- 设置弹窗（问题7+11：提示风格三选一 + 停留时长） ----------
function openSettings(store: Store): void {
  const ux = store.getUxSettings();
  let style: "toast" | "overlay" | "none" = ux.successStyle ?? "toast";

  const radioGroup = h("div", { style: { display: "flex", flexDirection: "column", gap: "8px", padding: "4px 0 8px" } });
  const radios: Array<{ val: "toast" | "overlay" | "none"; label: string; desc: string }> = [
    { val: "toast", label: "💬 轻量提示（推荐）", desc: "保存后底部弹出小气泡「已收藏 ✦」，不影响工作流" },
    { val: "overlay", label: "🎉 完整提示", desc: "保存后显示「已收入闪藏」浮层，停留几秒后自动退出" },
    { val: "none", label: "🚫 不提示", desc: "保存后直接退出 uTools 回到工作窗口，完全无提示" }
  ];
  for (const r of radios) {
    const rb = h("input", { type: "radio", name: "successStyle", value: r.val, checked: r.val === style }) as HTMLInputElement;
    rb.addEventListener("change", () => { style = r.val; syncDelay(); });
    radioGroup.append(h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } }, rb,
      h("span", { style: { fontSize: "13px", color: "var(--text)", lineHeight: "1.5" } },
        h("strong", { text: r.label }), " ", h("span", { text: r.desc, style: { color: "var(--text-3)", fontSize: "12px" } })
      )
    ));
  }

  const delaySel = h("select", { class: "input", style: { width: "auto" } }) as HTMLSelectElement;
  for (const [v, label] of [[600,"0.6 秒"],[1200,"1.2 秒"],[2000,"2 秒"],[3000,"3 秒"]] as const) {
    delaySel.append(h("option", { value: String(v), text: label }));
  }
  delaySel.value = String(ux.successDelayMs);
  const delayRow = h("div", {
    style: { display: "flex", alignItems: "center", gap: "10px", padding: "6px 0 4px" }
  },
    h("label", { text: "浮层停留时长：", style: { fontSize: "13px", color: "var(--text-2)" } }),
    delaySel
  );

  function syncDelay(): void {
    delayRow.style.opacity = style === "overlay" ? "1" : ".35";
    delayRow.style.pointerEvents = style === "overlay" ? "auto" : "none";
  }
  syncDelay();

  const closeOnCopyBox = h("input", { type: "checkbox", class: "setting-check", checked: ux.closeOnCopy === true }) as HTMLInputElement;
  const closeOnCopyRow = h("div", {
    style: { display: "flex", alignItems: "center", gap: "10px", padding: "8px 0 2px", borderTop: "1px solid var(--border)" }
  }, closeOnCopyBox,
    h("span", { style: { fontSize: "13px", color: "var(--text)", lineHeight: "1.5" } },
      h("strong", { text: "⚡ 复制后立即关闭窗口" }), " ",
      h("span", { text: "复制成功即刻退出 uTools 回到原窗口，不显示提示气泡；主面板、预览内的复制均生效", style: { color: "var(--text-3)", fontSize: "12px" } })
    )
  );

  const close = openModal("设置", h("div", {},
    radioGroup, delayRow, closeOnCopyRow,
    h("div", { class: "modal-foot", style: { padding: "12px 0 0" } },
      h("button", {
        class: "btn",
        text: "恢复默认",
        onclick: () => { store.saveUxSettings({ successStyle: "toast", successDelayMs: 1200, closeOnCopy: false }); toast("已恢复默认（轻量提示）"); close(); }
      }),
      h("button", {
        class: "btn primary",
        text: "保存",
        onclick: () => {
          store.saveUxSettings({
            successStyle: style,
            successDelayMs: parseInt(delaySel.value, 10) || 1200,
            closeOnCopy: closeOnCopyBox.checked
          });
          toast("设置已保存");
          close();
        }
      })
    )
  ));
}

// ---------- 更多标签多选面板（问题9） ----------
function openTagPicker(store: Store, state: MainState, refresh: () => void): void {
  const selected = new Set(state.tags);
  const wrap = h("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px", maxHeight: "240px", overflowY: "auto" } });
  const render = (): void => {
    wrap.replaceChildren();
    const all = store.listTags();
    if (all.length === 0) {
      wrap.append(h("div", { text: "还没有标签", style: { fontSize: "12.5px", color: "var(--text-3)", padding: "10px 2px" } }));
      return;
    }
    for (const t of all) {
      const active = selected.has(t.name);
      wrap.append(h("button", {
        class: "chip" + (active ? " active" : ""),
        html: '<span class="dot"></span>' + escapeHtml(t.name),
        onclick: () => { if (active) selected.delete(t.name); else selected.add(t.name); render(); }
      }));
    }
  };
  render();
  const close = openModal("按标签筛选（可多选）", h("div", {},
    wrap,
    h("div", { class: "modal-foot", style: { padding: "10px 0 0" } },
      h("button", { class: "btn", text: "清除", onclick: () => { selected.clear(); render(); } }),
      h("button", {
        class: "btn primary",
        text: "确定",
        onclick: () => { state.tags = [...selected]; close(); refresh(); }
      })
    )
  ));
}