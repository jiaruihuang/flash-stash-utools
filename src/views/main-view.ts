// 主面板：搜索 / 浏览 / 复制 / 编辑 / 删除 / 标签管理 / 排序 / 批量选择
import type { Snippet } from "../types.ts";
import type { Store } from "../db.ts";
import type { SearchHit } from "../search.ts";
import { searchSnippets, filterSnippets } from "../search.ts";
import { renderMarkdown } from "../render.ts";
import { snippetExcerpt, formatTime, highlightText, escapeHtml, snippetTitle } from "../utils.ts";
import { h, toast, confirmDialog, openModal } from "../ui.ts";
import { attachCodeCopyLayer } from "../code-block-ui.ts";
import { matchTextOrPinyin } from "../pinyin.ts";
import { pushEsc } from "../escape.ts";
import { KIND_ICON, KIND_LABEL, thumbnailEl } from "../item-view.ts";
import {
  SORT_OPTIONS, GROUP_OPTIONS, sortLabel, sortSnippets, groupSnippets, normalizeSortKey, normalizeSortDir
} from "../sort.ts";
import type { SortMode } from "../sort.ts";

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

export function renderMain(app: HTMLElement, store: Store, cb: MainCallbacks, initQuery = ""): void {
  const state: MainState = { query: initQuery, kind: "", tags: [] };
  // 搜索结果与键盘导航状态（修订3B）
  let hits: SearchHit[] = [];
  let activeIdx = 0;
  // 0.6.0：排序偏好（持久化在 setting/ux，选定后下次打开插件仍生效）
  const ux0 = store.getUxSettings();
  let sortMode: SortMode = normalizeSortKey(ux0.sortMode);
  let sortDir = normalizeSortDir(ux0.sortDir);
  let sortGroup: "none" | "day" = ux0.sortGroup === "day" ? "day" : "none";
  // 0.6.0：批量删除模式
  let batchMode = false;
  const picked = new Set<string>();
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
      h("button", {
        class: "btn ghost",
        text: "☑ 批量",
        title: "批量选择收藏（可多选后一次性删除）",
        onclick: () => toggleBatchMode()
      }),
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
  // 0.6.0：排序条独立成行——排序是「怎么看」，与「看哪些」（筛选）分开，标签再多也不会把它挤走
  const sortBar = h("div", { class: "mv-sortbar" });
  const list = h("div", { class: "mv-list" });
  // 批量操作条（仅批量模式显示）
  const batchBar = h("div", { class: "batchbar" });

  /** 排序偏好落库：只写排序三项，避免覆盖其它设置 */
  function persistSort(): void {
    store.saveSortPrefs({ sortMode, sortDir, sortGroup });
  }

  function rebuildSortBar(): void {
    sortBar.replaceChildren();
    const sel = h("select", {
      class: "sort-select",
      title: "排序方式（选定后会被记住，下次打开插件仍按此排序）"
    }) as HTMLSelectElement;
    const smartOpt = h("option", { value: "smart", text: "相关度（搜索时）" }) as HTMLOptionElement;
    sel.append(smartOpt);
    for (const o of SORT_OPTIONS) {
      sel.append(h("option", { value: o.key, text: o.label, title: o.desc }) as HTMLOptionElement);
    }
    sel.value = sortMode;
    sel.addEventListener("change", () => {
      sortMode = normalizeSortKey(sel.value);
      // 选具体排序键时套用它更自然的默认方向（标题/类型升序，时间类降序）
      const preset = SORT_OPTIONS.find((o) => o.key === sortMode);
      if (preset) sortDir = preset.dir;
      persistSort();
      renderList();
    });

    const dirBtn = h("button", {
      class: "sort-dir-btn" + (sortDir === "asc" ? " active" : ""),
      text: sortDir === "asc" ? "↑ 升序" : "↓ 降序",
      title: "切换升序 / 降序",
      onclick: () => {
        sortDir = sortDir === "asc" ? "desc" : "asc";
        persistSort();
        renderList();
      }
    });

    const groupBtn = h("button", {
      class: "sort-dir-btn" + (sortGroup === "day" ? " active" : ""),
      text: "按日期分组",
      title: GROUP_OPTIONS[1].desc,
      onclick: () => {
        sortGroup = sortGroup === "day" ? "none" : "day";
        persistSort();
        renderList();
      }
    });

    sortBar.append(h("span", { class: "sort-label", text: sortLabel(sortMode, sortDir) }), sel, dirBtn, groupBtn,
      h("button", {
        class: "sort-dir-btn",
        text: "重置排序",
        title: "回到默认：更新时间 ↓",
        onclick: () => {
          sortMode = "updated";
          sortDir = "desc";
          sortGroup = "none";
          persistSort();
          renderSortBarSafe();
          renderList();
        }
      })
    );
    sortBar.append(h("span", { class: "mv-count", id: "mv-count" }));
  }

  /** 重建排序条并回填统计文案（避免每次刷新都重建整个下拉而丢焦点） */
  function renderSortBarSafe(): void {
    const count = sortBar.querySelector(".mv-count") as HTMLElement | null;
    rebuildSortBar();
    if (count && count.textContent) {
      const el = sortBar.querySelector(".mv-count");
      if (el) el.textContent = count.textContent;
    }
  }

  /** 统计文案：共 N 条收藏 · 当前显示 M 条 */
  function updateCount(shown: number): void {
    const all = store.listSnippets();
    const tagCount = store.listTags().length;
    const el = sortBar.querySelector(".mv-count");
    if (!el) return;
    const parts = [`共 ${all.length} 条收藏`];
    if (tagCount > 0) parts.push(`${tagCount} 个标签`);
    if (shown !== all.length) parts.push(`当前显示 ${shown} 条`);
    el.textContent = parts.join(" · ");
  }

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
  }

  // ---------- 批量选择（0.6.0） ----------
  function toggleBatchMode(force?: boolean): void {
    batchMode = force ?? !batchMode;
    if (!batchMode) picked.clear();
    renderBatchBar();
    list.classList.toggle("batch", batchMode);
    renderList();
  }

  function pickedSnippets(): Snippet[] {
    return hits.filter((hh) => picked.has(hh.snippet._id)).map((hh) => hh.snippet);
  }

  function renderBatchBar(): void {
    batchBar.replaceChildren();
    batchBar.style.display = batchMode ? "flex" : "none";
    if (!batchMode) return;
    batchBar.append(
      h("span", { class: "batchbar-label", text: `已选 ${picked.size} 条` }),
      h("button", {
        class: "mini-btn",
        text: "全选当前结果",
        onclick: () => { for (const hh of hits) picked.add(hh.snippet._id); renderBatchBar(); paintPicked(); }
      }),
      h("button", {
        class: "mini-btn",
        text: "反选",
        onclick: () => {
          for (const hh of hits) {
            const id = hh.snippet._id;
            if (picked.has(id)) picked.delete(id); else picked.add(id);
          }
          renderBatchBar(); paintPicked();
        }
      }),
      h("span", { class: "batchbar-spacer" }),
      h("button", {
        class: "mini-btn danger",
        text: "删除所选",
        onclick: () => { void removePicked(); }
      }),
      h("button", { class: "mini-btn", text: "退出批量", onclick: () => toggleBatchMode(false) })
    );
  }

  /** 只更新卡片选中态，不重绘列表（重绘会让复选框闪烁、并丢失滚动位置） */
  function paintPicked(): void {
    const cards = list.querySelectorAll(".card");
    cards.forEach((el) => {
      const id = (el as HTMLElement).dataset.id ?? "";
      el.classList.toggle("batch-picked", picked.has(id));
      const box = el.querySelector(".card-check input") as HTMLInputElement | null;
      if (box) box.checked = picked.has(id);
    });
  }

  async function removePicked(): Promise<void> {
    const targets = pickedSnippets();
    if (targets.length === 0) { toast("请先勾选要删除的收藏", "err"); return; }
    const hasImage = targets.some((s) => s.kind === "image" && s.imagePath);
    const ok = await confirmDialog(
      "批量删除收藏",
      `确定删除选中的 ${targets.length} 条收藏吗？删除后不可恢复。` +
      (hasImage ? "（其中包含图片收藏，本地图片文件也会一并删除）" : "")
    );
    if (!ok) return;
    for (const s of targets) {
      if (s.imagePath) { try { window.flashStash?.deleteFile(s.imagePath); } catch { /* 忽略 */ } }
    }
    const n = store.removeSnippets(targets);
    picked.clear();
    toast(`已删除 ${n} 条收藏`);
    // 删空后自动退出批量模式，避免停留在一个空壳工具栏上
    if (store.listSnippets().length === 0) batchMode = false;
    renderBatchBar();
    list.classList.toggle("batch", batchMode);
    refreshAll();
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

  /**
   * 记录一次「取用」：使用次数 +1、最近使用时间刷新（排序「最近使用 / 使用次数」依赖这两个字段）。
   * 复制成功才算取用，不成功不记账。为避免每次复制都重排列表（会让卡片在脚下跳动），
   * 这里不立即重绘——下次刷新（搜索/切换排序/重进主面板）自然生效。
   */
  function noteUsage(s: Snippet): void {
    try { store.touchSnippet(s); } catch { /* 忽略 */ }
  }

  function doCopy(s: Snippet): void {
    const closeOnCopy = store.getUxSettings().closeOnCopy === true;
    if (s.kind === "image" && s.imagePath) {
      const r = window.flashStash?.copyImageByPath(s.imagePath);
      if (r && r.ok) {
        noteUsage(s);
        if (closeOnCopy) { leaveAfterCopy(); return; }
        toast("图片已复制到剪贴板");
        return;
      }
      toast(r?.error ?? "复制失败", "err");
      return;
    }
    const r = window.flashStash?.copyText(s.content ?? "");
    if (r && r.ok) {
      noteUsage(s);
      if (closeOnCopy) { leaveAfterCopy(); return; }
      toast("已复制到剪贴板");
      return;
    }
    if (r) { toast(r.error ?? "复制失败", "err"); return; }
    // 非 uTools 环境兜底
    void navigator.clipboard?.writeText(s.content ?? "").then(() => {
      noteUsage(s);
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
        class: "btn",
        text: "编辑",
        title: "快速进入编辑状态",
        onclick: () => { close(); cb.onEdit(s); }
      }),
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
      body.push(thumbnailEl(s));
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
            picked.delete(s._id);
            toast("已删除");
            refreshAll();
          })();
        }
      })
    );
    body.push(h("div", { class: "card-meta" },
      h("span", { class: "card-time", text: usageText(s) }),
      actions
    ));

    // 批量模式下的多选（CSS 控制：只有 .mv-list.batch 时才占位显示）
    const checkBox = h("input", {
      type: "checkbox",
      checked: picked.has(s._id),
      title: "选中这条收藏",
      onchange: () => {
        if (picked.has(s._id)) picked.delete(s._id); else picked.add(s._id);
        renderBatchBar();
        paintPicked();
      }
    }) as HTMLInputElement;
    const checkWrap = h("div", { class: "card-check", onclick: (e: Event) => e.stopPropagation() }, checkBox);

    const cardEl = h("div", { class: "card", dataset: { id: s._id } },
      checkWrap,
      h("div", { class: `card-ico k-${s.kind}`, text: KIND_ICON[s.kind] }),
      h("div", { class: "card-body" }, ...body)
    );
    if (picked.has(s._id)) cardEl.classList.add("batch-picked");
    cardEl.addEventListener("click", () => {
      // 批量模式下点卡片 = 勾选/取消勾选，绝不误触发复制
      if (batchMode) { checkBox.checked = !checkBox.checked; checkBox.dispatchEvent(new Event("change")); return; }
      doCopy(s);
    });
    cardEl.addEventListener("mouseenter", () => { if (activeIdx !== index) { activeIdx = index; paintActive(); } });
    return cardEl;
  }

  /** 卡片时间行：显示更新时间；有取用记录时补上「使用 N 次」，让排序依据可见 */
  function usageText(s: Snippet): string {
    const base = formatTime(s.updatedAt);
    const n = typeof s.useCount === "number" && s.useCount > 0 ? s.useCount : 0;
    if (!n) return base;
    const used = s.lastUsedAt ? ` · 最近使用 ${formatTime(s.lastUsedAt)}` : "";
    return `${base} · 使用 ${n} 次${used}`;
  }

  function renderList(): void {
    const keepScroll = list.scrollTop;
    list.replaceChildren();
    const all = store.listSnippets();
    updateCount(all.length);
    if (all.length === 0) {
      list.append(emptyState());
      hits = [];
      renderBatchBar();
      return;
    }
    // 0.5.6：主面板搜索支持拼音匹配（设置中可关闭，默认开启）
    const pinyinSearch = store.getUxSettings().pinyinSearch === true;
    hits = filterSnippets(searchSnippets(all, store.listTags(), state.query, { pinyin: pinyinSearch }), {
      kind: state.kind,
      tags: state.tags
    });
    // 0.6.0：排序发生在检索/筛选之后，因此「检索出的数据」同样按用户选定顺序排列
    const scoreById = new Map(hits.map((hh) => [hh.snippet._id, hh.score]));
    hits = sortSnippets(hits, {
      key: sortMode,
      dir: sortDir,
      title: snippetTitle,
      score: (s) => scoreById.get(s._id) ?? 0
    }, state.query.trim().length > 0);
    if (hits.length === 0) {
      list.append(h("div", { class: "empty" },
        h("div", { class: "empty-ico", text: "🔍" }),
        h("div", { class: "empty-tip", text: state.query ? `没有找到匹配 “${state.query}” 的收藏` : "该分类下暂无收藏" })
      ));
      updateCount(0);
      renderBatchBar();
      return;
    }
    updateCount(hits.length);
    // 批量模式下已选条目若已不在当前结果里，保持选择（跨筛选批量删除）
    let i = 0;
    if (sortGroup === "day") {
      for (const g of groupSnippets(hits, { key: sortMode, dir: sortDir }, state.query.trim().length > 0)) {
        list.append(h("div", { class: "group-head", text: g.label }));
        for (const hit of g.items) list.append(card(hit, i++));
      }
    } else {
      for (const hit of hits) list.append(card(hit, i++));
    }
    activeIdx = 0;
    paintActive();
    renderBatchBar();
    list.scrollTop = keepScroll;
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
        if (!hh) return;
        // 批量模式下回车 = 勾选/取消高亮项，避免误复制（退出批量后才恢复“回车复制”）
        if (batchMode) {
          if (picked.has(hh.snippet._id)) picked.delete(hh.snippet._id); else picked.add(hh.snippet._id);
          renderBatchBar();
          paintPicked();
          return;
        }
        doCopy(hh.snippet);
      } else if (e.key === " " && batchMode) {
        // 批量模式下空格也能勾选当前高亮项
        e.preventDefault();
        const hh = hits[activeIdx];
        if (!hh) return;
        if (picked.has(hh.snippet._id)) picked.delete(hh.snippet._id); else picked.add(hh.snippet._id);
        renderBatchBar();
        paintPicked();
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

  app.append(h("div", { class: "mv" }, head, searchWrap, filters, sortBar, batchBar, list));
  renderBatchBar();
  rebuildSortBar();
  refreshAll();

  // 主面板 Escape：批量模式下先退出批量；有搜索词 → 清空并回到全部；无搜索词 → 不消费，交还 uTools 正常退出
  pushEsc(() => {
    if (batchMode) {
      toggleBatchMode(false);
      return true;
    }
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
    // 0.5.6：标签管理查询支持拼音匹配（全拼/首字母）
    const tags = q ? all.filter((t) => matchTextOrPinyin(t.name, q)) : all;
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

  // 0.5.6：Windows 系统消息提示开关（utools.showNotification）
  const systemNotifyBox = h("input", { type: "checkbox", class: "setting-check", checked: ux.systemNotify !== false }) as HTMLInputElement;
  const systemNotifyRow = h("div", {
    style: { display: "flex", alignItems: "center", gap: "10px", padding: "8px 0 2px", borderTop: "1px solid var(--border)" }
  }, systemNotifyBox,
    h("span", { style: { fontSize: "13px", color: "var(--text)", lineHeight: "1.5" } },
      h("strong", { text: "🪟 Windows 系统消息提示" }), " ",
      h("span", { text: "保存成功后弹出系统通知「已收入闪藏 ✦」；关闭后仅保留插件内的提示（气泡 / 浮层）", style: { color: "var(--text-3)", fontSize: "12px" } })
    )
  );

  // 0.5.6：搜索收藏时启用拼音匹配（全拼/首字母）
  const pinyinSearchBox = h("input", { type: "checkbox", class: "setting-check", checked: ux.pinyinSearch !== false }) as HTMLInputElement;
  const pinyinSearchRow = h("div", {
    style: { display: "flex", alignItems: "center", gap: "10px", padding: "8px 0 2px", borderTop: "1px solid var(--border)" }
  }, pinyinSearchBox,
    h("span", { style: { fontSize: "13px", color: "var(--text)", lineHeight: "1.5" } },
      h("strong", { text: "🔤 拼音搜索（默认开启）" }), " ",
      h("span", { text: "搜索收藏时支持拼音全拼与首字母匹配——如输入 “qd” 或 “qianduan” 即可找到标签「前端」的收藏", style: { color: "var(--text-3)", fontSize: "12px" } })
    )
  );

  // 0.6.0：默认排序偏好（一键把列表恢复成常用视图）
  const sortModeSel = h("select", { class: "input", style: { width: "auto" } }) as HTMLSelectElement;
  sortModeSel.append(h("option", { value: "updated", text: "更新时间（默认）" }) as HTMLOptionElement);
  for (const o of SORT_OPTIONS) {
    if (o.key === "updated") continue;
    sortModeSel.append(h("option", { value: o.key, text: o.label, title: o.desc }) as HTMLOptionElement);
  }
  sortModeSel.value = ux.sortMode === "smart" ? "updated" : ux.sortMode;
  const sortDirSel = h("select", { class: "input", style: { width: "auto" } }) as HTMLSelectElement;
  sortDirSel.append(h("option", { value: "desc", text: "降序 ↓" }) as HTMLOptionElement);
  sortDirSel.append(h("option", { value: "asc", text: "升序 ↑" }) as HTMLOptionElement);
  sortDirSel.value = ux.sortDir;
  const sortGroupBox = h("input", { type: "checkbox", class: "setting-check", checked: ux.sortGroup === "day" }) as HTMLInputElement;
  const sortRow = h("div", {
    style: { display: "flex", alignItems: "center", gap: "8px", padding: "8px 0 2px", borderTop: "1px solid var(--border)", flexWrap: "wrap" }
  },
    h("span", { style: { fontSize: "13px", color: "var(--text)", lineHeight: "1.5" } },
      h("strong", { text: "↕ 默认排序" }), " ",
      h("span", { text: "主面板「排序」下拉的默认值（选定即记住）", style: { color: "var(--text-3)", fontSize: "12px" } })
    ),
    sortModeSel, sortDirSel,
    h("label", { style: { display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12.5px", color: "var(--text-2)" } },
      sortGroupBox, "按日期分组")
  );

  const close = openModal("设置", h("div", {},
    radioGroup, delayRow, closeOnCopyRow, systemNotifyRow, pinyinSearchRow, sortRow,
    h("div", { class: "modal-foot", style: { padding: "12px 0 0" } },
      h("button", {
        class: "btn",
        text: "恢复默认",
        onclick: () => {
          // 保留用户已选定的排序（那是一次显式的、独立的偏好），只复位“提示/搜索”类开关
          const keep = store.getUxSettings();
          store.saveUxSettings({
            successStyle: "toast", successDelayMs: 1200, closeOnCopy: false, systemNotify: true, pinyinSearch: true,
            sortMode: keep.sortMode, sortDir: keep.sortDir, sortGroup: keep.sortGroup
          });
          toast("已恢复默认（轻量提示）");
          close();
        }
      }),
      h("button", {
        class: "btn primary",
        text: "保存",
        onclick: () => {
          store.saveUxSettings({
            successStyle: style,
            successDelayMs: parseInt(delaySel.value, 10) || 1200,
            closeOnCopy: closeOnCopyBox.checked,
            systemNotify: systemNotifyBox.checked,
            pinyinSearch: pinyinSearchBox.checked,
            sortMode: normalizeSortKey(sortModeSel.value),
            sortDir: normalizeSortDir(sortDirSel.value),
            sortGroup: sortGroupBox.checked ? "day" : "none"
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