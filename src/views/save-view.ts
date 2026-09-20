// 收藏 / 编辑视图：文本编辑、Markdown 富文本编辑、图片预览、标签与备注
import type { Snippet, SnippetKind } from "../types.ts";
import type { Store } from "../db.ts";
import { renderMarkdown, htmlToMarkdown, codeLanguages } from "../render.ts";
import { createMdEditor, prepareBlockSelection, toggleCodeBlockSmart, splitLinesForList } from "../editor.ts";
import type { Editor } from "@tiptap/core";
import { h, toast, confirmDialog, openModal } from "../ui.ts";
import { attachCodeCopyLayer } from "../code-block-ui.ts";
import type { CodeCopyLayer } from "../code-block-ui.ts";
import { openTablePicker } from "../table-picker.ts";
import { matchTextOrPinyin } from "../pinyin.ts";
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
  /**
   * 0.6.0：这条内容是按哪种「标记」带进来的，仅用于文案提示，不限制用户改类型。
   * - "text"：剪贴板 / uTools 选中文本（可能被原应用加粗/倾斜，按原样当纯文本收藏）
   * - "markdown"：uTools 的「收藏 Markdown」指令
   * - "image"：图片指令 / 剪贴板图片
   */
  source?: "text" | "markdown" | "image";
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
  /**
   * 0.6.0：这条内容是按哪种标记带进来的（文案提示用）。
   * 图片恒为 image；否则取 init.source，缺省按初始类型推断。
   */
  const source: "text" | "markdown" | "image" = isImage
    ? "image"
    : init.source ?? (init.kind === "markdown" ? "markdown" : "text");

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
  const subEl = h("div", { class: "sv-sub" });
  /**
   * 副标题文案（0.6.0）：
   * - 编辑模式：说明编辑后保存生效；
   * - 新建模式：说明「按哪种标记收藏」以及用户可自行改类型。
   *   文案随类型切换实时更新——用户想收藏纯文本时不必被 Markdown 绑架，反之亦然。
   */
  function syncSub(): void {
    if (isEdit) {
      subEl.textContent = "编辑后保存生效";
      return;
    }
    if (kind === "image") {
      subEl.textContent = "图片收藏 · 保存后随取随用";
      return;
    }
    if (source === "text" && kind === "text") {
      subEl.textContent = "正在按「文本」收藏（原样保存，不做 Markdown 解析）· 可切换为 Markdown";
      return;
    }
    if (source === "text" && kind === "markdown") {
      subEl.textContent = "已切换为「Markdown」收藏 · 想原样保存请切回文本";
      return;
    }
    if (source === "markdown" && kind === "markdown") {
      subEl.textContent = "正在按「Markdown」收藏 · 需要纯文本原样保存可切换为文本";
      return;
    }
    if (source === "markdown" && kind === "text") {
      subEl.textContent = "已切换为「文本」收藏（不做 Markdown 解析）";
      return;
    }
    subEl.textContent = "保存前可预览、补充标签与备注";
  }
  const head = h(
    "div",
    { class: "sv-head" },
    h("div", { class: "mv-logo", text: "闪" }),
    h("div", {},
      h("div", { class: "sv-title", text: isEdit ? "编辑收藏" : "收藏到闪藏" }),
      subEl
    )
  );

  // 类型切换（文本 / Markdown 可切换；图片为固定类型）
  const kindTabs = h("div", { class: "kind-tabs" });
  function rebuildKindTabs(): void {
    kindTabs.replaceChildren();
    const options: Array<{ key: SnippetKind; label: string; disabled?: boolean; title?: string }> = [
      { key: "text", label: "文本", title: "按纯文本收藏：内容原样保存，不做任何 Markdown 解析（SQL、代码、日志等首选）" },
      { key: "markdown", label: "Markdown", title: "按 Markdown 收藏：可富文本编辑、源码编辑与渲染预览" },
      { key: "image", label: "图片", disabled: true, title: "图片收藏（入口决定，不可切换）" }
    ];
    for (const o of options) {
      kindTabs.append(h("button", {
        class: "kind-tab" + (kind === o.key ? " active" : ""),
        text: o.label,
        title: o.title,
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
          syncSub(); // 类型提示随切换实时更新（收藏成文本还是 Markdown 由用户定）
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

  // ---------- 标签（token field，0.6.3）----------
  /**
   * 标签区是一个**整体控件**：已选标签（token）与输入框在同一个容器里，
   * 光标就停在 token 之后——所见即所删，退格删标签不再"隔空操作"。
   * 结构：
   *   .tag-field            ← position:relative，同时是建议列表的定位上下文
   *     .tag-field-box      ← 有边框的"输入框"，内部 flex-wrap 排列
   *       .chip-item × N
   *       input.tag-input
   *     .tag-suggest        ← 紧贴 box 下沿展开
   */
  const tagInput = h("input", {
    class: "tag-input",
    placeholder: "输入标签，回车添加 · Esc 收起候选"
  }) as HTMLInputElement;
  /**
   * 输入框是 tagBox 的常驻最后一个子元素；token 用 prepend 插到它前面。
   *
   * 0.6.6：点击事件要**排除建议列表内部**。suggestEl 挂在 tagField（tagBox 的兄弟）下，
   * 但列表视觉上贴着输入框，用户点选项时很容易被判定成"点了标签区空白"而把焦点抢回输入框；
   * 加上浏览器对 `.opt` 的默认聚焦行为，就会出现用户反馈的"选着选着焦点丢了/输入框不响应"。
   * 这里只处理真正的标签区点击。
   */
  const tagBox = h("div", {
    class: "tag-field-box",
    onclick: (e: Event) => {
      if (suggestEl.contains(e.target as Node)) return;
      focusTagInput();
    }
  }, tagInput);
  const tagField = h("div", { class: "tag-field" }, tagBox);
  const suggestEl = h("div", { class: "tag-suggest", style: { display: "none" } });
  tagField.append(suggestEl);

  /**
   * 抑制「输入框重新获得焦点时自动弹出候选列表」。
   * 用于：在列表里选过标签、或点 × 删标签之后——这些时刻用户不需要候选列表。
   */
  let suppressBlur = false;

  /** 点空白处把焦点收回输入框（token field 的标准手感） */
  function focusTagInput(): void {
    try { tagInput.focus(); } catch { /* 忽略 */ }
  }

  /**
   * 「待删除」的标签名：输入框为空时第一次退格只标记（红色高亮），再按一次才删除。
   * token field 里标签就在光标左侧，高亮**看得见**，所以这个保护是有效的。
   */
  let pendingRemoval: string | null = null;

  function armPendingRemoval(name: string): void {
    pendingRemoval = name;
    renderChips();
  }

  function cancelPendingRemoval(): void {
    if (pendingRemoval === null) return;
    pendingRemoval = null;
    renderChips();
  }

  /**
   * 渲染已选标签（**按添加顺序**，不再排序）。
   * 顺序即用户输入顺序，删除时也从"视觉上最后一个"删，所见与所删一致。
   */
  function renderChips(): void {
    // 旧 token 全部移除，只保留输入框
    for (const el of [...tagBox.querySelectorAll(".chip-item")]) el.remove();
    const toks: HTMLElement[] = [];
    for (const t of tagSet) {
      const pending = pendingRemoval === t;
      toks.push(h("span", {
        class: "chip-item" + (pending ? " pending-del" : ""),
        title: pending ? "再按一次退格即可删除该标签" : t
      },
        h("span", { class: "chip-text", text: t }),
        h("span", {
          class: "x",
          text: "×",
          title: "移除标签「" + t + "」",
          onclick: (e: Event) => {
            e.stopPropagation();
            pendingRemoval = null;
            tagSet.delete(t);
            renderChips();
            /**
             * 删除时**不要**让候选列表弹出来（用户是在移除标签，不可能同时要选一个）。
             * 这里用 suppressBlur 抑制随后的 focus 自动弹出——点 × 会让输入框先失焦再聚焦，
             * 而 focus 处理器默认会 showSuggest()。
             */
            suppressBlur = true;
            focusTagInput();
            hideSuggest();
            setTimeout(() => { suppressBlur = false; }, 200);
          }
        })
      ));
    }
    // token 插在输入框之前，保证光标始终在最右
    tagBox.prepend(...toks);
  }

  function addTag(raw: string): void {
    const n = raw.trim();
    if (!n || tagSet.has(n)) return;
    pendingRemoval = null; // 新增标签时清掉待删标记
    tagSet.add(n);
    store.createTag(n); // 保证标签文档存在（重复创建会返回错误，忽略）
    renderChips();
  }

  /** 落库用的标签数组：**按拼音排序**（跨收藏统一，搜索结果里相同标签位置一致） */
  function tagsForSave(): string[] {
    return [...tagSet].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  }

  /**
   * 标签集合的"内容签名"（用于判脏）。
   * 用**排序后的快照**比较，因此"只是顺序变了"不算修改——落库时本来就会重排，
   * 顺序差异不该触发"未保存的修改"提示。
   */
  function tagSignature(): string {
    return [...tagSet].sort().join("\u0000");
  }

  // 建议列表键盘导航状态（修订3A；0.6.0 修复“首次全量列表键盘选择无效”）
  let suggestOpts: string[] = [];
  let suggestActive = -1;
  /**
   * 是否处于「键盘导航模式」（0.6.7 明确化）。
   *
   * 语义：用户用键盘（↑/↓）选择列表项期间，**鼠标被动滑过的 `mouseenter` 不得接管高亮**。
   * 只有用户**真的移动鼠标**（`mousemove`）才退出该模式。
   *
   * 为什么必须是显式布尔量、不能用「最近按键时间窗」：
   * 时间窗**会过期**。用 500ms 判据时，只要按键间隔超过 500ms（思考、找键位、慢慢按），
   * 保护就失效，`mouseenter` 又会抢走高亮——现象随鼠标位置与按键快慢而变，
   * 这正是用户反馈的"和我鼠标有点关系"。模式化的判据与时间无关，才彻底。
   *
   * 它同时决定 CSS 类 `.kbd-nav`（压掉 `:hover` 样式），但**类只是表现**，
   * 真正的守卫是 `mouseenter` 里的 `if (kbdNav) return;`——千万别以为加个类就安全。
   */
  let kbdNav = false;
  /**
   * 上一次键盘导航按键（↑/↓）的时间戳。
   * 某些环境里方向键会顺带触发一次 `input` 事件，用它区分“真在改筛选词”与“按键的副产物”。
   * （0.6.6 曾用它做 mouseenter 免疫窗，0.6.7 已改为上面的 `kbdNav`。）
   */
  let lastNavKeyAt = 0;
  /** 上一次的筛选词（用于判断“用户真的改了筛选条件”，从而复位高亮） */
  let lastQuery = "";
  // 失焦后延迟收起（给「点选项」留出时间）；用句柄跟踪，避免它晚到把刚刚重新弹出的列表又收掉
  let blurHideTimer: ReturnType<typeof setTimeout> | null = null;
  function cancelBlurHide(): void {
    if (blurHideTimer !== null) { clearTimeout(blurHideTimer); blurHideTimer = null; }
  }
  function paintSuggest(): void {
    suggestEl.querySelectorAll(".opt").forEach((el, i) => el.classList.toggle("active", i === suggestActive));
  }

  /**
   * 建议列表的**真实行高**（0.6.6）。
   *
   * 为什么不写死 32：`.opt` 的高度由 CSS 决定（现已固定为 32px，见 style.css），
   * 但布局量只能实测才作数——用常量去算"一屏几行"时，只要 CSS 有一点点出入
   * （字体回退、行高继承、padding 改动），`max-height` 就不再是真实行高的整数倍，
   * 列表上下边缘各被切掉一部分，正是用户看到的"遮蔽一半记录"。
   *
   * 取相邻两项的 offsetTop 差值最稳；退化到首项自身高度；再退化到常量。
   * 结果缓存：列表每次重建后行高不会变，避免每次按键都强制布局。
   */
  let cachedRowH = 0;
  const ROW_H_FALLBACK = 32;
  function measureRowH(): number {
    const first = suggestEl.querySelector(".opt") as HTMLElement | null;
    if (!first) return cachedRowH || ROW_H_FALLBACK;
    const second = suggestEl.querySelectorAll(".opt")[1] as HTMLElement | undefined;
    let h = second ? second.offsetTop - first.offsetTop : 0;
    if (!(h > 0)) h = first.offsetHeight;
    if (!(h > 0)) h = cachedRowH || ROW_H_FALLBACK;
    cachedRowH = h;
    return h;
  }
  function resetRowHCache(): void { cachedRowH = 0; }

  /**
   * 让高亮项滚动到列表可视区内（0.6.5 重写）。
   *
   * 为什么不用 `scrollIntoView`：它会滚动**所有可滚动祖先**（常把整个保存视图顶动、下拉自己不动），
   * 且向上展开时列表是 `transform` 视觉上移的，浏览器按布局盒判断可见性会判错。
   *
   * 这里自己算，只改 `suggestEl.scrollTop`。**0.6.4 没做对的关键**：
   * `.tag-suggest` 有 `border:1px`，`max-height` 又是按可用空间动态设的，
   * 所以 `clientHeight` 往往**不是行高的整数倍**（例如 318px / 32px = 9.94 行）。
   * 此时若用 `scrollTop = itemBottom - clientHeight`，会得到 34/66/98 这类非整数倍值，
   * 顶部永远露出**半行**；用户继续按 ↓ 时高亮其实在往下走，但因顶上那条被切掉一半，
   * 视觉上就像"焦点跳回了上面一条的下一条"。
   *
   * 修正：**按整行对齐**滚动——计算"要让高亮完整可见，第一行应该是第几行"，
   * 再乘以行高。这样每次滚动量都是行高的整数倍，视觉上就是一行一行地走。
   */
  function scrollActiveIntoView(): void {
    const opts = suggestEl.querySelectorAll(".opt");
    const el = opts[suggestActive] as HTMLElement | undefined;
    if (!el) return;

    // 行高：统一走实测（详见 measureRowH 的说明），不再各算各的
    const rowH = measureRowH();

    const viewH = suggestEl.clientHeight;
    if (viewH <= 0) return; // 列表尚未真正显示（display:none 时 clientHeight 为 0）

    const itemTop = el.offsetTop;
    const itemBottom = itemTop + rowH;
    const cur = suggestEl.scrollTop;
    const rows = Math.max(1, Math.floor(viewH / rowH)); // 一屏能放下的整行数

    if (itemTop < cur) {
      // 高亮在可视区上方 → 让它成为第 1 行
      suggestEl.scrollTop = Math.max(0, Math.floor(itemTop / rowH) * rowH);
    } else if (itemBottom > cur + viewH) {
      // 高亮在可视区下方 → 让它成为最后一行（整行对齐，顶部不留半行）
      suggestEl.scrollTop = Math.max(0, (Math.floor(itemTop / rowH) - rows + 1) * rowH);
    }
  }
  /**
   * 唯一的「进入/退出键盘导航模式」入口（0.6.7）。
   *
   * 为什么必须收敛成一个函数：`kbdNav` 这个布尔量和 CSS 类 `.kbd-nav` 是**同一状态的两处表示**，
   * 一旦有人只改其中一个（历史上就发生过：只加类、没置位，或重绘时只清类、没清位），
   * 就会出现"看得到 hover 被压制、但高亮仍被鼠标抢走"这类难查的不一致。
   * **任何地方都不要直接 `classList.add/remove("kbd-nav")`，一律走这里。**
   */
  function setKbdNav(on: boolean): void {
    kbdNav = on;
    suggestEl.classList.toggle("kbd-nav", on);
  }

  function hideSuggest(): void {
    cancelBlurHide();
    suggestEl.style.display = "none";
    setKbdNav(false);
    suggestOpts = [];
    suggestActive = -1;
    lastQuery = "";
  }
  function pickTag(name: string): void {
    suppressBlur = true;
    addTag(name);
    tagInput.value = "";
    hideSuggest();
    tagInput.focus();
    setTimeout(() => { suppressBlur = false; }, 200);
  }

  /**
   * 建议列表的定位基准 = 它的定位上下文（`.tag-field`，`position:relative`）。
   * 注意：suggestEl 是 tagField 的**子元素**，absolute 的 top/left 相对 tagField 计算；
   * 列表要对齐的是带边框的 `tagBox`（输入框本体），所以两者都要用。
   */
  const tagAnchor = tagBox;

  /**
   * 仅重建候选列表内容（不重定位、不改变展开方向）。
   * 用于键盘导航：让 ↓ 能“进入”输入框里已有的文字所对应的候选，
   * 而不必先按回车重绘一次列表（那次重绘正是丢状态的元凶）。
   *
   * @param resetHighlight 为 true 时把高亮复位到「未选中」。
   *   ⚠️ 只要**筛选词变了**就必须复位：列表内容已经刷新，
   *   旧的下标指向的是另一批候选项，继续沿用会让 ↓ 从列表中间接着走
   *   （用户反馈：删掉一个字符后列表变了，↓ 却从上一个位置继续往下）。
   */
  function rebuildSuggestOpts(q: string, resetHighlight = true): boolean {
    // 0.5.6：支持拼音匹配（全拼/首字母），如输入 "qd" 可搜出标签「前端」
    const all = store.listTags().filter((t) => !tagSet.has(t.name) && matchTextOrPinyin(t.name, q));
    suggestOpts = all.map((t) => t.name);
    suggestEl.replaceChildren();
    resetRowHCache(); // 列表重建 → 行高缓存作废，下次重新实测
    if (resetHighlight) {
      suggestActive = -1;
      setKbdNav(false);
    }
    if (all.length === 0) return false;
    for (const t of all) {
      suggestEl.append(h("div", {
        class: "opt",
        text: t.name,
        /**
         * tabindex="-1"（0.6.6）：让选项**可被 mousedown 命中但不进入 Tab 序列、不被聚焦**。
         * 否则浏览器点选菜单项时会先聚焦它，输入框随即失焦 → blur 处理器把列表收起，
         * 用户看到的就是"点一下 / 键盘走到某处，焦点莫名其妙没了"。
         */
        tabindex: "-1",
        onmousedown: (e: Event) => { e.preventDefault(); pickTag(t.name); },
        onmouseenter: () => {
          /**
           * 0.6.7 关键修复（此问题第 3 次修订，前两次都没对）：
           * **键盘导航是一个"模式"，不是一个"时间窗"**。
           *
           * 现象（用户实测）：按 ↓ 走到可视区最后一条再按一次 → **失高亮**、滚动条只下移一点点；
           * 再按一次 → 滚动条**回到最上面**、第一条露出来但仍无高亮；再按一次才高亮第一条。
           * 并且"鼠标如果放在下拉表上面，顺序就会变乱一点"。
           *
           * 真因（两层，缺一不可）：
           * ① **`mouseenter` 抢走高亮**：列表滚动时**新的一行会滑到静止的鼠标指针下面**，
           *    浏览器随即对该行触发 `mouseenter`。旧实现无条件接管高亮 → 把刚选中的 `.active` 抹掉。
           * ② **用 500ms 时间窗去挡它是错的**：时间窗**会过期**。只要按键间隔超过 500ms
           *    （思考、找键位、慢慢按），保护就失效、`mouseenter` 又能抢走高亮 → 现象复发。
           *    这正是用户说的"和我鼠标有点关系"：取决于指针是否停在列表上以及按键有多慢。
           *    **必须改成显式的粘性模式，不能用计时器。**
           *
           * 现在：只要处于键盘导航模式（`kbdNav` 为真），`mouseenter` **一律不接管**；
           * **只有真实的 `mousemove`（用户确实移动了鼠标）才退出该模式**。
           * 这样"被动滑过来"的 mouseenter 永远无法打断键盘操作，与按键快慢无关。
           *
           * ⚠️ `kbd-nav` 类**只管 CSS**（压掉 `:hover` 样式），对这里的 JS 赋值毫无约束，
           *    真正的守卫是这个 `if (kbdNav) return;`。
           */
          if (kbdNav) return;
          // 鼠标接管高亮：退出键盘导航模式，否则键盘高亮会与 hover 打架
          setKbdNav(false);
          suggestActive = suggestOpts.indexOf(t.name);
          paintSuggest();
        },
        /**
         * 只有**鼠标真的移动**才视为"用户想用鼠标选"——退出键盘导航模式，
         * 让上面的 mouseenter 恢复接管。
         *
         * 判据必须是 `mousemove` 而不是 `mouseenter`：滚动导致的"被动进入"不会触发 mousemove，
         * 所以不会误退出键盘模式。**不要**改成用 mouseenter 退出。
         */
        onmousemove: () => {
          if (!kbdNav) return;
          setKbdNav(false);
          suggestActive = suggestOpts.indexOf(t.name);
          paintSuggest();
        }
      }));
    }
    return true;
  }

  /**
   * 只做「定位 + 定高」，**不碰候选内容、不碰高亮**。
   *
   * 0.6.6 抽出来单独存在的原因：键盘导航时必须能重新套用几何（见 keydown 处理器），
   * 而 `showSuggest()` 会顺带 `rebuildSuggestOpts()` 重置高亮——那正是"↓ 之后高亮被冲掉"的老 bug。
   * 拆开之后，导航路径可以只要几何、不要重建。
   */
  function placeSuggest(): void {
    const rect = tagAnchor.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const below = vh - rect.bottom - 12;
    const above = rect.top - 12;
    // 期望高度用实测行高（见下方 ROW_H 说明），避免"想放几行"与实际行高脱节
    const want = suggestOpts.length * measureRowH() + 10;
    /**
     * 方向：优先向下（紧贴输入框下沿）。
     * 只有「下方放不下且上方确实更宽裕」时才向上翻——注意这里比较的是
     * 可用空间本身，而不是像旧版那样拿固定 200px 去比，否则会在
     * “下方够用但不到 200px”时被误判成向上翻。
     */
    const dir: "down" | "up" = below >= Math.min(want, 140) || below >= above ? "down" : "up";
    suggestEl.classList.toggle("drop-up", dir === "up");
    // 相对 tagAnchor 的偏移：容器本身没有 border/padding，直接贴 0 即可
    suggestEl.style.left = "0px";
    suggestEl.style.width = "100%";
    const room = dir === "down" ? below : above;
    /**
     * 高度取**整行数**（0.6.5 起）。
     * 0.6.6 修正：行高不能想当然按 32 算——CSS 侧已把 `.opt` 固定成 32px 高
     * （见 style.css 对应注释），但这里仍以**实测行高**为准：
     * 若 CSS 被改动而常量没同步，用常量会让 max-height 不是真实行高的整数倍，
     * 列表就会固定切掉半行（用户实测的"遮蔽一半记录"）。
     * 量不到时（列表未显示/无候选）才退回常量。
     */
    const ROW_H = measureRowH(), BORDER = 2;
    const maxRows = Math.max(3, Math.min(10, Math.floor((room - BORDER) / ROW_H)));
    // 不额外夹 320：maxRows 已限上限 10 行，再加边框即为整行高度
    suggestEl.style.maxHeight = maxRows * ROW_H + BORDER + "px";
    suggestEl.style.top = (dir === "down" ? rect.height + 4 : -4) + "px";
  }

  /**
   * 弹出/刷新建议列表。
   * - 相对 `.tag-input-wrap`（定位上下文）紧贴输入框下沿内联展开；
   * - 不再用 fixed + 上下翻转：那会在“上方空间更富余”时把列表甩到输入框上方老远，
   *   中间留出一大段空白，观感上像和输入框无关；
   * - 高度按“输入框到窗口边缘”的可用空间计算，并取整行数（见 placeSuggest）。
   */
  function showSuggest(): void {
    cancelBlurHide(); // 关键：清掉可能正在倒计时的「失焦收起」，否则列表刚弹出就被延迟回调收掉
    const q = tagInput.value.trim().toLowerCase();
    const hasAny = rebuildSuggestOpts(q);
    if (!hasAny) {
      suggestEl.style.display = "none";
      return;
    }
    placeSuggest();
    suggestEl.style.display = "block";
  }

  tagInput.addEventListener("keydown", (e) => {
    /**
     * 0.6.0 修复「键盘选标签没效果」：在标签输入框里，↑/↓/回车**本身就是操作**，
     * 绝不能落到底部的 `showSuggest()` 去“刷新列表”——那会重置高亮项。
     * 更隐蔽的一层：某些环境会把方向键顺带翻译成一次 input 事件，
     * 触发下面的 input 处理器把状态冲掉。所以这里显式列出导航键并单独处理，
     * 且回车**只以「有没有高亮项」为准**（高亮是唯一可信的“用户想选这一项”信号）。
     */
    const navKeys = ["ArrowDown", "ArrowUp", "Enter", "Escape", "Tab"];
    if (navKeys.includes(e.key)) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const suggestVisible = suggestEl.style.display !== "none" && suggestEl.style.display !== "";
        /**
         * 候选列表优先沿用**当前已展示的那一份**（只要它非空），
         * 绝不因为“输入框此刻是空的”就悄悄换成全量列表——
         * 那会让 ↓ 的高亮跳到别的标签上（用户以为选了 A，实际选中的是 B，
         * 即反馈中的「全量不筛选时选择标签没效果」）。
         */
        if (!(suggestVisible && suggestOpts.length > 0)) {
          const ok = rebuildSuggestOpts(tagInput.value.trim().toLowerCase());
          if (!ok) return;
        }
        if (suggestOpts.length === 0) return;
        e.preventDefault();
        /**
         * 0.6.6：键盘导航时**重新套用几何**。
         * 旧版这里只写 `display = "block"`，沿用上一次 showSuggest 留下的 maxHeight：
         * 若那次是在可用空间更小的时候算的（例如刚弹出时窗口更矮、或方向被翻转过），
         * 高度就偏小，`scrollTop` 能到的上限随之变小 —— 表现就是
         * 「还没到最后一条，滚动条就停住不动了」（用户实测反馈）。
         * 这里只重算定位/高度，不重建候选、不碰高亮。
         */
        placeSuggest();
        suggestEl.style.display = "block";
        lastNavKeyAt = Date.now();
        setKbdNav(true); // 进入键盘导航模式：压制 hover，并挡住鼠标的被动接管
        const delta = e.key === "ArrowDown" ? 1 : -1;
        suggestActive = Math.max(0, Math.min(suggestOpts.length - 1, suggestActive + delta));
        paintSuggest();
        scrollActiveIntoView();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const typed = tagInput.value.trim();
        /**
         * 回车语义（0.6.0 二次修订，务必按此实现，别再改回去）：
         *
         * 1) **有高亮项**（用户明确按过 ↑/↓ 选中了某一项）→ 选中它。
         *    这是唯一的“选中已有标签”路径，且必须由显式的 ↑/↓ 触发——
         *    不能只看“列表里有候选”就抢走回车，否则**用户永远无法新增标签**
         *    （实测反馈：输入 aaaaa 回车，本想新建 aaaaa，却被塞成了列表里的 aaaaa乙）。
         *
         * 2) 输入框为空（未用键盘选）→ 展开全部已存在标签，纯浏览。
         *
         * 3) 其它情况（输入框有文字、且没用 ↑/↓ 选过）→ **按输入内容新建/添加标签**。
         *    想让键盘选已有标签，就先按 ↓ 高亮再回车；直接回车永远是“我要这个”。
         */
        if (suggestActive >= 0 && suggestOpts[suggestActive]) {
          pickTag(suggestOpts[suggestActive]);
          return;
        }
        if (!typed) { showSuggest(); return; }
        addTag(typed);
        tagInput.value = "";
        hideSuggest();
        return;
      }
      // Escape / Tab 交给浏览器与 Escape 栈处理，不在这里刷新列表
      return;
    }
    /**
     * 退格删标签（token field 标准交互，0.6.3）：
     * 标签就在输入框左侧、光标旁边，所以**高亮看得见**，可以做"先提醒再删"：
     * ① 输入框为空时第一次退格 → 把**视觉上最后一个**标签标红（不删）；
     * ② 再按一次退格 → 才真正删除；
     * ③ 继续输入 / 新增标签 / 点别处 → 自动取消待删状态。
     * 输入框有文字时，退格只删文字，绝不碰标签。
     * 删除对象取 `Set` 的最后一个（= 最后添加的），与 renderChips 的添加顺序一致，
     * 因此"删的"和"看到的"永远是同一个。
     */
    if (e.key === "Backspace") {
      if (tagInput.value) {
        if (pendingRemoval !== null) cancelPendingRemoval();
        showSuggest();
        return;
      }
      e.preventDefault();
      /**
       * 删标签时**收起建议列表**（0.6.4）：此刻用户是在移除标签，不可能要选一个标签，
       * 列表留着只会挡住标签区、干扰"待删除"的红色提示。
       * 同理，标记待删除时也收起。
       */
      hideSuggest();
      if (pendingRemoval === null) {
        const last = [...tagSet][tagSet.size - 1];
        if (!last) return; // 没有标签可删
        armPendingRemoval(last);
        return;
      }
      const name = pendingRemoval;
      cancelPendingRemoval();
      tagSet.delete(name);
      renderChips();
      toast(`已移除标签「${name}」`);
      return;
    }
    if (pendingRemoval !== null) cancelPendingRemoval();
    showSuggest();
  });

  tagInput.addEventListener("input", () => {
    /**
     * 筛选词变了 → 候选列表已刷新 → **高亮必须复位**（从“未选中”重新开始），
     * 因为旧下标指向的是上一批候选里的位置，沿用会让 ↓ 从列表中间继续走。
     * 用户实测：输入 aaaaa → ↓↓ 停在第二项 → 删掉一个 a 变成 aaaa，列表已刷新，
     * 此时再按 ↓ 却从原来的第二个位置继续，交互很怪。
     * 现在把“筛选词”单独记下来，只有它真变了才复位（避免方向键顺带触发的 input 误伤键盘导航）。
     */
    if (lastQuery === tagInput.value.trim().toLowerCase() && lastNavKeyAt && Date.now() - lastNavKeyAt < 200) {
      return; // 方向键顺带触发的事件：不动状态
    }
    // 用户继续输入 → 取消"待删除"标记（那是上一次退格的临时状态）
    if (pendingRemoval !== null && tagInput.value) cancelPendingRemoval();
    lastQuery = tagInput.value.trim().toLowerCase();
    suggestActive = -1;
    setKbdNav(false);
    showSuggest();
  });
  tagInput.addEventListener("focus", () => { if (!suppressBlur) showSuggest(); });
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
        snippet.tags = tagsForSave();
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
          tags: tagsForSave(),
          imagePath: p,
          imageExt: String(p.match(/\.(\w+)$/)?.[1] ?? "png")
        });
      } else {
        snippet = store.createSnippet({
          kind: kind === "text" ? "text" : "markdown",
          content: kind === "text" ? text : md,
          note: note.trim(),
          tags: tagsForSave()
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
    // 0.5.6：可在设置中关闭 Windows 系统消息提示
    if (store.getUxSettings().systemNotify) {
      try { window.utools?.showNotification?.("已收入闪藏 ✦"); } catch { /* 忽略 */ }
    }
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
    // 0.5.6：可在设置中关闭 Windows 系统消息提示
    if (store.getUxSettings().systemNotify) {
      try { window.utools?.showNotification?.("已收入闪藏 ✦"); } catch { /* 忽略 */ }
    }
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
  syncSub();
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
      h("label", { class: "field-label", text: "标签（回车添加 · 退格两次移除最后一个）" }),
      tagField
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
  const initialTagList = tagSignature();
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
    if (tagSignature() !== initialTagList) return true;
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
    if (suggestEl.style.display !== "none" && suggestEl.style.display !== "") {
      hideSuggest();
      tagInput.focus();
      return true;
    }
    // ② 有未保存修改：弹确认框；无修改（编辑/主面板新增）→回主面板，（uTools 指令新增）→退出插件
    tryLeave();
    return true;
  });

  /**
   * 建议列表跟随滚动/尺寸变化重新贴合字段（0.6.0）。
   * 列表现在是 `position:absolute` 挂在字段旁，字段位置变化时必须重算，
   * 否则会出现“列表浮在半空、和输入框脱节”的观感。
   * 监听 document（capture）以覆盖任意内层滚动容器；视图离开后随 DOM 一起失效。
   *
   * ⚠️ 0.6.8 关键修复（此现象第 5 次才找到真因，0.6.4~0.6.7 连续四次没修对）：
   * capture 监听连**下拉自身的 scroll 事件**也会捕获到（scroll 不冒泡，但捕获阶段
   * 仍从 document 一路走向目标）。而键盘导航走到底时 `scrollActiveIntoView()`
   * 正会改 `suggestEl.scrollTop` → 浏览器随后异步派发 scroll（目标是 suggestEl）
   * → 旧实现调用 `showSuggest()` → `rebuildSuggestOpts()` 把候选**整表重建**、
   * `suggestActive=-1`、`scrollTop` 钳回 0 —— 表现就是「走到可视区最后一条再按 ↓，
   * 不跟随、跳回顶端、无高亮，再按一次才高亮第一条」。
   * 且重建后的选项是全新节点，指针下方的新节点会再触发 mouseenter（此时 kbdNav
   * 已被重建复位 → 守卫失效），这就是用户说“和我鼠标有点关系”的残余来源。
   * 修复：来自下拉自身（或其内部）的 scroll 一律忽略——它自己滚动不会改变
   * 它与定位上下文 `.tag-field` 的相对位置，本就无需重定位。
   * ⚠️ jsdom 里 `scrollTop` 赋值不会派发 scroll 事件，本历史路径在旧测试里
   * 从未执行过（连续假绿灯）；回归用例必须显式派发 scroll 事件模拟真实浏览器。
   */
  const repositionSuggest = (e?: Event): void => {
    if (suggestEl.style.display !== "none" && suggestEl.style.display !== "") {
      if (e && e.target instanceof Node && suggestEl === e.target) return; // 自身滚动：无需重定位
      showSuggest();
    }
  };  document.addEventListener("scroll", repositionSuggest, true);
  window.addEventListener("resize", repositionSuggest);

  baselineContent = currentContent(); // 基线在首次渲染后取值，消除富文本往返差异

  setTimeout(() => {
    if (kind === "text" && taEl) taEl.focus();
    else if (kind === "markdown" && mdEditor) mdEditor.commands.focus();
  }, 30);
}