// 收藏 / 编辑视图：文本编辑、Markdown 富文本编辑、图片预览、标签与备注
import type { Snippet, SnippetKind } from "../types.ts";
import type { Store } from "../db.ts";
import { renderMarkdown, htmlToMarkdown, codeLanguages } from "../render.ts";
import { createMdEditor, prepareBlockSelection, toggleCodeBlockSmart, splitLinesForList } from "../editor.ts";
import type { Editor } from "@tiptap/core";
import { escapeHtml } from "../utils.ts";
import { h, toast, confirmDialog, openModal } from "../ui.ts";
import { attachCodeCopyLayer } from "../code-block-ui.ts";
import type { CodeCopyLayer } from "../code-block-ui.ts";
import { openTablePicker } from "../table-picker.ts";
import { pushEsc } from "../escape.ts";

export interface SaveInit {
  mode: "create" | "edit";
  kind: SnippetKind;
  content: string;
  /** 图片数据源：本地路径 或 base64 dataURL（仅 create 图片时使用，保存时写入本地文件） */
  imageSource?: string;
  /** 编辑模式：已有收藏 */
  snippet?: Snippet;
  /**
   * 入口来源，决定“离开保存视图”的去向：
   * - "utools"：由 uTools 功能指令（收藏文本/Markdown/图片/剪贴板）进入 → 离开 = 退出插件
   * - "main"：由主面板「＋ 新增」进入 → 离开 = 返回主面板
   * 编辑模式恒为来自主面板（走 onOpenMain）。
   */
  from?: "utools" | "main";
}

export interface SaveCallbacks {
  onOpenMain: () => void;
  /** 「继续收藏」：新开一条收藏视图（避免 location.reload() 后插件白屏） */
  onNewAgain?: () => void;
}

type MdMode = "rich" | "source" | "preview";

export function renderSave(app: HTMLElement, store: Store, init: SaveInit, cb: SaveCallbacks): void {
  app.replaceChildren();

  const isEdit = init.mode === "edit";
  const fromMain = !isEdit && init.from === "main";
  const isImage = init.kind === "image";

  // ---------- 状态 ----------
  let kind: SnippetKind = init.kind;
  let mdMode: MdMode = "rich";
  let md = init.content ?? "";
  let text = init.content ?? "";
  const tagSet = new Set<string>(isEdit && init.snippet ? init.snippet.tags : []);
  let note = isEdit && init.snippet ? init.snippet.note ?? "" : "";
  let imageDataUrl: string | null = null;
  const imagePath: string | null = isEdit && init.snippet?.imagePath ? init.snippet.imagePath : null;

  // ---------- 图片初始化 ----------
  let imageReady = false;
  if (isImage) {
    const filePath = imagePath ?? (init.imageSource && !init.imageSource.startsWith("data:") ? init.imageSource : null);
    const dataUrl = init.imageSource && init.imageSource.startsWith("data:") ? init.imageSource : null;
    if (dataUrl) {
      imageDataUrl = dataUrl;
      imageReady = true;
    } else if (filePath && window.flashStash) {
      const r = window.flashStash.readImageAsDataUrl(filePath);
      if (r.ok) {
        imageDataUrl = r.dataUrl as string;
        imageReady = true;
      }
    }
  }

  // ---------- 头部 ----------
  const head = h(
    "div",
    { class: "sv-head" },
    h("div", { class: "mv-logo", text: "闪" }),
    h("div", {},
      h("div", { class: "sv-title", text: isEdit ? "编辑收藏" : "收藏到闪藏" }),
      h("div", { class: "sv-sub", text: isEdit ? "编辑后保存生效" : "保存前可预览、补充标签与备注" })
    )
  );

  // 类型切换（文本 / Markdown 可切换；图片为固定类型）
  const kindTabs = h("div", { class: "kind-tabs" });
  function rebuildKindTabs(): void {
    kindTabs.replaceChildren();
    const options: Array<{ key: SnippetKind; label: string; disabled?: boolean }> = [
      { key: "text", label: "文本" },
      { key: "markdown", label: "Markdown" },
      { key: "image", label: "图片", disabled: true }
    ];
    for (const o of options) {
      kindTabs.append(h("button", {
        class: "kind-tab" + (kind === o.key ? " active" : ""),
        text: o.label,
        disabled: o.disabled ? true : undefined,
        onclick: () => {
          if (o.disabled) return;
          const next = o.key;
          // 切换前同步各自编辑器的最新内容，避免编辑内容丢失
          if (next !== kind) {
            if (kind === "text" && taEl) text = taEl.value;
            if (kind === "markdown" && (mdEditor || taEl)) {
              md = mdMode === "rich" ? richMd() : (taEl ? taEl.value : md);
            }
            if (next === "markdown") md = text;
            if (next === "text") text = md;
          }
          kind = next;
          if (kind !== "markdown") mdMode = "rich";
          rebuildKindTabs();
          renderEditor();
          baselineContent = currentContent(); // 切换类型本身不算“修改”，基线随内容同步
        }
      }));
    }
  }

  // ---------- 编辑器区 ----------
  const editorArea = h("div", { class: "sv-content" });

  // Markdown 工具栏（0.5.0 起全部命令化，由 Tiptap 引擎执行）
  const toolBar = h("div", { class: "mdtoolbar" });
  /** 执行工具栏命令：focus + 命令链 + run，随后同步 Markdown 与字数 */
  function runCmd(build: (ch: ReturnType<Editor["chain"]>) => unknown, block = false): void {
    if (!mdEditor) return;
    // 块级命令：先把「部分选中的段落」按选区切开，避免整段被格式化（0.5.3）
    if (block) prepareBlockSelection(mdEditor);
    const chain = mdEditor.chain().focus();
    const res = build(chain);
    if (res && typeof (res as { run?: unknown }).run === "function") {
      (res as { run: () => boolean }).run();
    }
    syncFromRich();
  }
  function toolBtn(label: string, cmd: (ch: ReturnType<Editor["chain"]>) => unknown, title?: string, block = false): HTMLElement {
    return h("button", {
      class: "tb-btn",
      html: label,
      title: title ?? label,
      onmousedown: (e: Event) => e.preventDefault(), // 保住编辑器选区，点按钮不丢光标
      onclick: () => runCmd(cmd, block)
    });
  }
  /** 需要自定义逻辑的工具栏按钮（如弹窗），同样保住选区 */
  function toolAction(label: string, fn: () => void, title?: string): HTMLElement {
    return h("button", {
      class: "tb-btn",
      html: label,
      title: title ?? label,
      onmousedown: (e: Event) => e.preventDefault(),
      onclick: () => fn()
    });
  }
  /** 列表命令：先把「部分选中的段落」按选区切开，再把段内软换行逐行拆块，最后套列表 */
  function listCmd(build: (ch: ReturnType<Editor["chain"]>) => unknown): void {
    if (!mdEditor) return;
    prepareBlockSelection(mdEditor);
    splitLinesForList(mdEditor);
    runCmd(build);
  }
  function buildToolbar(): void {
    toolBar.replaceChildren();
    // 代码语言选择器（0.5.2）：光标在代码块内时可切换语言，触发重新高亮
    langSelEl = h("select", {
      class: "tb-select",
      title: "代码语言（光标放在代码块内生效）"
    }) as HTMLSelectElement;
    langSelEl.append(h("option", { value: "", text: "语言：自动" }));
    for (const l of codeLanguages()) langSelEl.append(h("option", { value: l, text: l }));
    langSelEl.disabled = true;
    langSelEl.addEventListener("change", () => {
      if (!mdEditor) return;
      mdEditor.chain().focus().updateAttributes("codeBlock", { language: langSelEl!.value || null }).run();
      syncFromRich();
    });
    // 表格矩阵选择器（0.5.2）：拖选行列后插入
    const tableBtn = h("button", {
      class: "tb-btn",
      html: "⊞ 表格",
      title: "插入表格（选择行列数）",
      onmousedown: (e: Event) => e.preventDefault(),
      onclick: () => openTablePicker(tableBtn, (rows, cols) => {
        if (!mdEditor) return;
        mdEditor.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run();
        syncFromRich();
      })
    }) as HTMLElement;
    toolBar.append(
      toolBtn("<b>B</b>", (ch) => ch.toggleBold()),
      toolBtn("<i>I</i>", (ch) => ch.toggleItalic()),
      toolBtn("<u>U</u>", (ch) => ch.toggleUnderline()),
      toolBtn("<s>S</s>", (ch) => ch.toggleStrike()),
      h("span", { class: "tb-sep" }),
      toolBtn("H1", (ch) => ch.toggleHeading({ level: 1 }), "一级标题（只作用于选中/光标所在行）", true),
      toolBtn("H2", (ch) => ch.toggleHeading({ level: 2 }), "二级标题（只作用于选中/光标所在行）", true),
      toolBtn("H3", (ch) => ch.toggleHeading({ level: 3 }), "三级标题（只作用于选中/光标所在行）", true),
      h("span", { class: "tb-sep" }),
      toolAction("• 列表", () => listCmd((ch) => ch.toggleBulletList()), "无序列表（多行文字每行一项）"),
      toolAction("1. 列表", () => listCmd((ch) => ch.toggleOrderedList()), "有序列表（多行文字每行一项）"),
      toolBtn("❝ 引用", (ch) => ch.toggleBlockquote(), "引用（只作用于选中文字）", true),
      h("span", { class: "tb-sep" }),
      toolAction("⧉ 代码块", () => { if (mdEditor) { toggleCodeBlockSmart(mdEditor); syncFromRich(); } }, "代码块（选中多行会合并成一个代码块）"),
      langSelEl,
      toolBtn("⟨码⟩", (ch) => ch.toggleCode()),
      toolAction("🔗 链接", () => openLinkEditor(), "插入链接（可有自定义文字）"),
      h("span", { class: "tb-sep" }),
      tableBtn,
      toolBtn("行+", (ch) => ch.addRowAfter(), "当前行后添加一行"),
      toolBtn("行-", (ch) => ch.deleteRow(), "删除当前行"),
      toolBtn("列+", (ch) => ch.addColumnAfter(), "当前列后添加一列"),
      toolBtn("列-", (ch) => ch.deleteColumn(), "删除当前列"),
      toolBtn("⊟ 删表", (ch) => ch.deleteTable(), "删除光标所在表格"),
      h("span", { class: "tb-sep" }),
      toolBtn("↩ 撤销", (ch) => ch.undo()),
      toolBtn("↪ 重做", (ch) => ch.redo())
    );
    syncLangSel();
  }

  /** 语言选择器状态跟随光标：不在代码块内时禁用 */
  function syncLangSel(): void {
    if (!langSelEl) return;
    const active = !!mdEditor && mdEditor.isActive("codeBlock");
    langSelEl.disabled = !active;
    const lang = active && mdEditor ? (mdEditor.getAttributes("codeBlock").language as string | null) ?? "" : "";
    langSelEl.value = lang || "";
  }

  let richEl: HTMLElement | null = null;
  let taEl: HTMLTextAreaElement | null = null;
  let previewEl: HTMLElement | null = null;
  let countEl: HTMLElement | null = null;
  /** 语言选择器（工具栏，跟随光标所在代码块） */
  let langSelEl: HTMLSelectElement | null = null;
  /** 代码块复制浮层句柄（随编辑器更新刷新） */
  let codeLayer: CodeCopyLayer | null = null;
  /** Tiptap 富文本编辑器实例（0.5.0） */
  let mdEditor: Editor | null = null;
  const editorBox = h("div", { class: "editor-box" });

  /** 当前富文本内容的 Markdown 形态（编辑器未创建/已销毁时回退到 md 变量） */
  function richMd(): string {
    return mdEditor ? htmlToMarkdown(mdEditor.getHTML()) : md;
  }

  /** 销毁编辑器（切模式/离开视图前必须调用，否则事件与 observer 泄漏） */
  function destroyMdEditor(): void {
    if (mdEditor) {
      mdEditor.destroy();
      mdEditor = null;
    }
    richEl = null;
    codeLayer = null;
    langSelEl = null;
  }

  /**
   * 插入链接对话框（0.5.1）：
   * - 有选区：把选中文字包成链接；
   * - 无选区：插入「链接文字（可编辑）」+ 网址，方便给链接命名。
   */
  function openLinkEditor(): void {
    if (!mdEditor) return;
    const editor = mdEditor;
    const selected = editor.state.doc.textBetween(
      editor.state.selection.from, editor.state.selection.to, undefined, " "
    ).trim();
    const textInput = h("input", { class: "input", value: selected || "链接文字", placeholder: "链接文字" }) as HTMLInputElement;
    const urlInput = h("input", {
      class: "input",
      value: "https://",
      placeholder: "https://…",
      style: { marginTop: "6px" }
    }) as HTMLInputElement;
    urlInput.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter") commit(); });
    let close: () => void = () => {};
    const commit = (): void => {
      const url = urlInput.value.trim();
      const text = textInput.value.trim() || "链接文字";
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) {
        toast("请输入完整网址（含 https://）", "err");
        urlInput.focus();
        return;
      }
      const sel = editor.state.selection;
      if (sel.empty) {
        // 无选区：插入命名链接文本
        editor.chain().focus().insertContent({
          type: "text",
          text,
          marks: [{ type: "link", attrs: { href: url } }]
        }).run();
      } else {
        // 有选区：包裹为链接
        editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
      }
      close();
      syncFromRich();
    };
    close = openModal("插入链接", h("div", {},
      h("label", { class: "field-label", text: "链接文字" }),
      textInput,
      h("label", { class: "field-label", text: "网址", style: { marginTop: "8px" } }),
      urlInput,
      h("div", { class: "modal-foot", style: { padding: "12px 0 0" } },
        h("button", { class: "btn", text: "取消", onclick: close }),
        h("button", { class: "btn primary", text: "确定", onclick: commit })
      )
    ));
    setTimeout(() => urlInput.focus(), 30);
  }

  function syncFromRich(): void {
    md = richMd();
    updateCount();
    codeLayer?.refresh(); // 代码块被删掉后立刻收起悬停「复制」按钮
  }

  function updateCount(): void {
    if (countEl) countEl.textContent = (md || "").length + " 字";
  }

  /** 重建编辑器（按当前 kind / mdMode） */
  function renderEditor(): void {
    destroyMdEditor(); // 先销毁旧编辑器，避免事件/observer 泄漏到被替换掉的 DOM
    editorArea.replaceChildren();
    if (kind === "image") {
      editorArea.append(
        h("div", { class: "img-preview", style: { flex: "1" } },
          imageReady
            ? h("img", { src: imageDataUrl ?? "", alt: "图片预览" })
            : h("div", { class: "empty", style: { width: "100%" } },
                h("div", { class: "empty-ico", text: "🖼" }),
                h("div", { class: "empty-tip", text: "无法读取图片数据" })
              )
        ),
        h("div", { class: "img-meta", text: imagePath ? String(imagePath.split(/[\\/]/).pop()) : "图片" })
      );
      return;
    }

    if (kind === "text") {
      taEl = h("textarea", {
        class: "ta",
        placeholder: "输入或编辑要收藏的内容…",
        value: text,
        oninput: () => { text = taEl!.value; if (countEl) countEl.textContent = text.length + " 字"; }
      }) as HTMLTextAreaElement;
      const box = h("div", { class: "editor-box" },
        h("div", { class: "editor-tabs" },
          h("span", { class: "editor-tab active", text: "纯文本" }),
          h("span", { class: "editor-tabspacer" }),
          h("span", { class: "editor-count", text: text.length + " 字" })
        ),
        taEl
      );
      editorArea.append(box);
      return;
    }

    // Markdown
    const tabs = h("div", { class: "editor-tabs" },
      h("button", { class: "editor-tab" + (mdMode === "rich" ? " active" : ""), text: "富文本", onclick: () => switchMode("rich") }),
      h("button", { class: "editor-tab" + (mdMode === "source" ? " active" : ""), text: "源码", onclick: () => switchMode("source") }),
      h("button", { class: "editor-tab" + (mdMode === "preview" ? " active" : ""), text: "预览", onclick: () => switchMode("preview") }),
      h("span", { class: "editor-tabspacer" }),
      h("span", { class: "editor-count", text: (md || "").length + " 字" })
    );
    countEl = tabs.querySelector(".editor-count") as HTMLElement;

    richEl = null;
    taEl = null;
    previewEl = null;
    editorBox.replaceChildren();

    if (mdMode === "rich") {
      buildToolbar();
      richEl = h("div", { class: "rich" });
      mdEditor = createMdEditor(richEl, { md, onUpdate: () => syncFromRich() });
      // 测试接缝：把 Tiptap 实例挂到根元素，供 ui-smoke 以命令级方式驱动（生产无副作用）
      (richEl as unknown as { _mdEditor?: Editor })._mdEditor = mdEditor;
      // 光标移动/内容变化时同步语言选择器状态
      mdEditor.on("selectionUpdate", () => syncLangSel());
      mdEditor.on("update", () => syncLangSel());
      codeLayer = attachCodeCopyLayer(richEl); // 代码块悬停复制（编辑区）
      syncLangSel();
      editorBox.append(tabs, toolBar, richEl);
    } else if (mdMode === "source") {
      taEl = h("textarea", {
        class: "ta",
        placeholder: "在这里编写 Markdown 源码…",
        value: md,
        oninput: () => { md = taEl!.value; updateCount(); }
      }) as HTMLTextAreaElement;
      editorBox.append(tabs, taEl);
    } else {
      previewEl = h("div", { class: "preview", html: renderMarkdown(md) });
      attachCodeCopyLayer(previewEl); // 代码块悬停复制（预览区）
      editorBox.append(tabs, previewEl);
    }
    editorArea.append(editorBox);
  }

  function switchMode(next: MdMode): void {
    if (mdMode === "rich") md = richMd();
    if (mdMode === "source" && taEl) md = taEl.value;
    mdMode = next;
    renderEditor();
  }

  // ---------- 标签 ----------
  const chipsWrap = h("div", { class: "chips", style: { maxHeight: "64px", overflowY: "auto" } });
  const tagInput = h("input", { class: "input", placeholder: "输入标签，回车添加（已有标签可直接点击）" });
  const tagWrap = h("div", { class: "tag-input-wrap" }, tagInput);
  const suggestEl = h("div", { class: "tag-suggest", style: { display: "none", maxHeight: "200px", overflowY: "auto" } });
  tagWrap.append(suggestEl);

  function renderChips(): void {
    chipsWrap.replaceChildren();
    for (const t of [...tagSet].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))) {
      chipsWrap.append(h("span", { class: "chip-item" },
        escapeHtml(t),
        h("span", { class: "x", text: "×", onclick: () => { tagSet.delete(t); renderChips(); } })
      ));
    }
  }

  function addTag(raw: string): void {
    const n = raw.trim();
    if (!n || tagSet.has(n)) return;
    tagSet.add(n);
    store.createTag(n); // 保证标签文档存在（重复创建会返回错误，忽略）
    renderChips();
  }

  // 建议列表键盘导航状态（修订3A）
  let suggestOpts: string[] = [];
  let suggestActive = -1;
  // 失焦后延迟收起（给「点选项」留出时间）；用句柄跟踪，避免它晚到把刚刚重新弹出的列表又收掉
  let blurHideTimer: ReturnType<typeof setTimeout> | null = null;
  function cancelBlurHide(): void {
    if (blurHideTimer !== null) { clearTimeout(blurHideTimer); blurHideTimer = null; }
  }
  function paintSuggest(): void {
    suggestEl.querySelectorAll(".opt").forEach((el, i) => el.classList.toggle("active", i === suggestActive));
  }
  function hideSuggest(): void {
    cancelBlurHide();
    suggestEl.style.display = "none";
    suggestEl.classList.remove("kbd-nav");
    suggestOpts = [];
    suggestActive = -1;
  }
  function pickTag(name: string): void {
    suppressBlur = true;
    addTag(name);
    tagInput.value = "";
    hideSuggest();
    tagInput.focus();
    setTimeout(() => { suppressBlur = false; }, 200);
  }
  function showSuggest(): void {
    cancelBlurHide(); // 关键：清掉可能正在倒计时的「失焦收起」，否则列表刚弹出就被延迟回调收掉
    suggestEl.classList.remove("kbd-nav");
    const q = tagInput.value.trim().toLowerCase();
    const all = store.listTags().filter((t) => t.name.toLowerCase().includes(q) && !tagSet.has(t.name));
    suggestOpts = all.map((t) => t.name);
    suggestEl.replaceChildren();
    if (all.length === 0) {
      suggestEl.style.display = "none";
      suggestActive = -1;
      return;
    }
    for (const t of all) {
      suggestEl.append(h("div", {
        class: "opt",
        text: t.name,
        onmousedown: (e: Event) => { e.preventDefault(); pickTag(t.name); },
        onmouseenter: () => {
          suggestEl.classList.remove("kbd-nav");
          suggestActive = suggestOpts.indexOf(t.name);
          paintSuggest();
        }
      }));
    }
    // 动态定位：根据可用空间选择向下或向上展开
    const rect = tagInput.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const spaceBelow = vh - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    const maxH = 200;
    if (spaceBelow >= Math.min(maxH, all.length * 32) || spaceBelow >= spaceAbove) {
      // 向下展开
      suggestEl.style.left = rect.left + "px";
      suggestEl.style.top = (rect.bottom + 2) + "px";
      suggestEl.style.width = rect.width + "px";
      suggestEl.style.maxHeight = Math.min(maxH, spaceBelow) + "px";
    } else {
      // 向上展开
      suggestEl.style.left = rect.left + "px";
      suggestEl.style.top = Math.max(8, rect.top - 2 - Math.min(maxH, spaceAbove)) + "px";
      suggestEl.style.width = rect.width + "px";
      suggestEl.style.maxHeight = Math.min(maxH, spaceAbove) + "px";
    }
    suggestEl.style.display = "block";
    suggestActive = -1;
    paintSuggest();
  }

  tagInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (suggestEl.style.display !== "none" && suggestOpts.length > 0) {
        e.preventDefault();
        suggestEl.classList.add("kbd-nav"); // 键盘导航时压制 hover 高亮，避免双焦点
        const delta = e.key === "ArrowDown" ? 1 : -1;
        suggestActive = Math.max(0, Math.min(suggestOpts.length - 1, suggestActive + delta));
        paintSuggest();
        (suggestEl.querySelectorAll(".opt")[suggestActive] as HTMLElement | undefined)?.scrollIntoView?.({ block: "nearest" });
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (!tagInput.value.trim()) { showSuggest(); return; } // 空白回车：展示全部已存在标签
      if (suggestActive >= 0 && suggestOpts[suggestActive]) pickTag(suggestOpts[suggestActive]);
      else { addTag(tagInput.value); tagInput.value = ""; hideSuggest(); }
      return;
    }
    if (e.key === "Backspace" && !tagInput.value && tagSet.size > 0) {
      tagSet.delete([...tagSet][tagSet.size - 1]);
      renderChips();
      return;
    }
    showSuggest();
  });
  tagInput.addEventListener("input", showSuggest);
  tagInput.addEventListener("focus", () => { if (!suppressBlur) showSuggest(); });
  let suppressBlur = false;
  /**
   * 鼠标点回标签输入框：若建议列表已收起（例如刚用 Esc 关掉列表、或输入框本就保持焦点再点击），重新弹出。
   * 单击与双击都生效——「Esc 收起后再点一下没反应」是用户明确反馈的问题。
   */
  function reopenSuggestByPointer(): void {
    if (suppressBlur) return; // 刚在列表里选过标签，别马上又弹出来
    cancelBlurHide(); // 失焦后 150ms 内点回：先取消待执行的收起，列表保持/重新弹出
    if (suggestEl.style.display === "none") showSuggest();
  }
  tagInput.addEventListener("click", reopenSuggestByPointer);
  tagInput.addEventListener("dblclick", reopenSuggestByPointer);
  tagInput.addEventListener("blur", () => {
    cancelBlurHide();
    blurHideTimer = setTimeout(() => {
      blurHideTimer = null;
      if (!suppressBlur) hideSuggest();
    }, 150);
  });

  const noteInput = h("textarea", {
    class: "input",
    placeholder: "备注（可选）…",
    rows: 2,
    style: { resize: "none", lineHeight: "1.5" }
  }) as HTMLTextAreaElement;
  noteInput.value = note;
  noteInput.addEventListener("input", () => { note = noteInput.value; });

  // ---------- 底部 ----------
  const errEl = h("div", { class: "sv-err" });
  const foot = h("div", { class: "sv-foot" },
    errEl,
    h("button", { class: "btn", text: "取消", onclick: () => tryLeave() }),
    h("button", { class: "btn primary", text: isEdit ? "保存修改" : "保存", onclick: () => void doSave() })
  );

  // ---------- 保存 ----------
  async function doSave(): Promise<void> {
    errEl.textContent = "";
    if (kind === "text") {
      if (taEl) text = taEl.value;
      if (!text.trim()) { errEl.textContent = "内容不能为空"; return; }
    } else if (kind === "markdown") {
      if (mdMode === "rich") md = richMd();
      if (mdMode === "source" && taEl) md = taEl.value;
      if (!md.trim()) { errEl.textContent = "内容不能为空"; return; }
    }

    // 直接从控件读取最新值（不依赖 input 事件，更健壮）
    note = noteInput.value;
    if (kind === "text" && taEl) text = taEl.value;

    try {
      let snippet: Snippet | null = null;
      if (isEdit && init.snippet) {
        snippet = init.snippet;
        snippet.kind = kind;
        snippet.content = kind === "image" ? "" : (kind === "text" ? text : md);
        snippet.note = note.trim();
        snippet.tags = [...tagSet];
        if (kind !== "image") snippet.imagePath = undefined;
        store.updateSnippet(snippet);
      } else if (kind === "image") {
        const r = window.flashStash?.saveImageFile(init.imageSource ?? "");
        if (!r || !r.ok) { errEl.textContent = r?.error ?? "图片保存失败"; return; }
        const p = (r as { path: string }).path;
        snippet = store.createSnippet({
          kind: "image",
          content: "",
          note: note.trim(),
          tags: [...tagSet],
          imagePath: p,
          imageExt: String(p.match(/\.(\w+)$/)?.[1] ?? "png")
        });
      } else {
        snippet = store.createSnippet({
          kind: kind === "text" ? "text" : "markdown",
          content: kind === "text" ? text : md,
          note: note.trim(),
          tags: [...tagSet]
        });
      }
      if (!snippet) return;
      saved = true; // 保存成功后 Escape 不再提示“未保存”
      destroyMdEditor(); // 保存完成，释放富文本编辑器（后续只用成功提示/离开）
      // 更新标签最近使用时间
      for (const tn of snippet.tags) store.touchTag(tn);
      const ux = store.getUxSettings();
      if (ux.successStyle === "none") {
        finishAndExit();
        return;
      }
      if (ux.successStyle === "toast") {
        toast("已收藏 ✦", "ok");
        // 延迟退出，让 toast 有时间显示；定时器要可取消，避免用户提前离开后它晚到重绘视图
        toastTimer = setTimeout(() => { toastTimer = null; finishAndExit(); }, 1400);
        return;
      }
      showSuccess(ux.successDelayMs);
    } catch (e) {
      errEl.textContent = "保存失败：" + String((e as Error).message ?? e);
    }
  }

  /** 保存完成：按设置不显示浮层时的收尾（编辑 / 主面板新增→回主面板；uTools 指令新增→关闭并退出 uTools） */
  function finishAndExit(): void {
    if (isEdit || fromMain) { cb.onOpenMain(); return; }
    try { window.utools?.showNotification?.("已收入闪藏 ✦"); } catch { /* 忽略 */ }
    try { window.utools?.outPlugin?.(); } catch { /* 忽略 */ }
    try { window.utools?.hideMainWindow?.(true); } catch { /* 忽略 */ }
  }

  let successShown = false;
  let successTimer: ReturnType<typeof setTimeout> | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  function clearSuccessTimer(): void {
    if (successTimer !== null) { clearTimeout(successTimer); successTimer = null; }
    if (toastTimer !== null) { clearTimeout(toastTimer); toastTimer = null; }
  }
  function showSuccess(delayMs = 2200): void {
    if (successShown) return;
    successShown = true;
    try { window.utools?.showNotification?.("已收入闪藏 ✦"); } catch { /* 忽略 */ }
    const overlay = h("div", { class: "succ" },
      h("div", { class: "succ-ico", text: "✓" }),
      h("div", { class: "succ-title", text: isEdit ? "修改已保存" : "已收入闪藏" }),
      h("div", { class: "succ-sub", text: "内容已安全收藏，可随时搜索取用" }),
      h("div", { class: "succ-btns" },
        h("button", { class: "btn", text: "继续收藏", onclick: () => { clearSuccessTimer(); if (cb.onNewAgain) cb.onNewAgain(); else window.location.reload(); } }),
        h("button", { class: "btn primary", text: "去查看", onclick: () => { clearSuccessTimer(); cb.onOpenMain(); } })
      )
    );
    app.append(overlay);
    successTimer = setTimeout(() => {
      successTimer = null;
      if (isEdit || fromMain) cb.onOpenMain();
      else closeWindow();
    }, delayMs);
  }

  function closeWindow(): void {
    try { window.utools?.outPlugin?.(); } catch { /* 忽略 */ }
  }

  // ---------- 组装 ----------
  rebuildKindTabs();
  const sv = h("div", { class: "sv" }, head, kindTabs);
  const svContent = h("div", {
    style: { flex: "1", display: "flex", flexDirection: "column", gap: "10px", minHeight: "0" }
  });
  const fieldContent = h("div", {
    style: { flex: "1", display: "flex", flexDirection: "column", gap: "6px", minHeight: "0" }
  }, h("label", { class: "field-label", text: "内容" }));
  editorArea.style.flex = "1";
  editorArea.style.minHeight = "0";
  fieldContent.append(editorArea);
  svContent.append(
    fieldContent,
    h("div", { class: "field" },
      h("label", { class: "field-label", text: "标签（回车添加）" }),
      chipsWrap,
      tagWrap
    ),
    h("div", { class: "field" },
      h("label", { class: "field-label", text: "备注" }),
      noteInput
    ),
    foot
  );
  sv.append(svContent);
  app.append(sv);

  renderEditor();
  renderChips();

  // ---------- 统一 Escape（修订4）：由全局处理器栈调度 ----------
  let saved = false;
  const initialNote = noteInput.value;
  const initialTagList = [...tagSet].sort().join("\u0000");
  let baselineContent = ""; // 首次渲染后取编辑器规范化初始值，避免“无修改也判脏”

  /** 当前规范化内容：与保存时写库的取值一致（富文本经 htmlToMarkdown） */
  function currentContent(): string {
    if (kind === "image") return "";
    if (kind === "markdown") {
      if (mdMode === "rich") return richMd();
      if (mdMode === "source" && taEl) return taEl.value;
      return md;
    }
    return taEl ? taEl.value : text;
  }

  function isDirty(): boolean {
    if (saved) return false;
    if (kind !== init.kind) return true;
    if (currentContent() !== baselineContent) return true;
    if ([...tagSet].sort().join("\u0000") !== initialTagList) return true;
    if (noteInput.value !== initialNote) return true;
    if (tagInput.value.trim() !== "") return true; // 标签框里已键入但未回车：也会随离开丢失，视为改动
    return false;
  }

  function leaveView(): void {
    if (isEdit || fromMain) cb.onOpenMain();
    else closeWindow();
  }

  function commitLeave(): void {
    escOff();
    clearSuccessTimer();
    destroyMdEditor(); // 离开前释放富文本编辑器，避免事件泄漏到下一个视图
    leaveView();
  }

  // 防抖：确认框打开期间重复触发（连按 Esc / 连点取消）不再开第二个弹窗
  let confirming = false;
  function tryLeave(): void {
    if (confirming) return;
    if (!isDirty()) { commitLeave(); return; }
    confirming = true;
    void (async () => {
      const ok = await confirmDialog("未保存的修改", "内容、标签或备注已修改但未保存，确定放弃并离开吗？", "放弃离开");
      confirming = false;
      if (ok) commitLeave();
    })();
  }

  const escOff = pushEsc(() => {
    // ① 标签建议列表打开：先关闭列表回输入框，不离开保存视图
    if (suggestEl.style.display !== "none") {
      hideSuggest();
      tagInput.focus();
      return true;
    }
    // ② 有未保存修改：弹确认框；无修改（编辑/主面板新增）→回主面板，（uTools 指令新增）→退出插件
    tryLeave();
    return true;
  });

  baselineContent = currentContent(); // 基线在首次渲染后取值，消除富文本往返差异

  setTimeout(() => {
    if (kind === "text" && taEl) taEl.focus();
    else if (kind === "markdown" && mdEditor) mdEditor.commands.focus();
  }, 30);
}