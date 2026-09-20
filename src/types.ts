export type SnippetKind = "text" | "markdown" | "image";

/** 收藏条目 */
export interface Snippet {
  _id: string;
  _rev?: string;
  type: "snippet";
  [key: string]: unknown;
  kind: SnippetKind;
  /** 文本或 Markdown 源码；图片条目为空字符串 */
  content: string;
  /** 备注 */
  note: string;
  /** 标签名列表 */
  tags: string[];
  /** 图片条目：本地文件绝对路径 */
  imagePath?: string;
  /** 图片扩展名 */
  imageExt?: string;
  createdAt: number;
  updatedAt: number;
  /** 复制取用次数（排序「使用次数」用；老数据缺省视为 0） */
  useCount?: number;
  /** 最近一次复制取用时间（排序「最近使用」用；0/缺省 = 从未取用） */
  lastUsedAt?: number;
}

/** 标签文档 */
export interface TagDoc {
  _id: string;
  _rev?: string;
  type: "tag";
  [key: string]: unknown;
  name: string;
  /** 最近使用时间戳（复制/编辑时更新），0 表示从未使用 */
  lastUsedAt: number;
  createdAt: number;
  updatedAt: number;
}

/** 用户设置（成功提示等） */
export interface UxSettings {
  /** 成功提示风格: toast=轻量气泡(默认), overlay=浮层, none=无提示直接退出 */
  successStyle: "toast" | "overlay" | "none";
  /** 浮层停留时长（毫秒） */
  successDelayMs: number;
  /** 复制后立即关闭窗口（所有复制操作成功即退出 uTools，不显示提示气泡） */
  closeOnCopy: boolean;
  /** Windows 系统消息提示（utools.showNotification）：保存成功时是否弹系统通知，默认开启 */
  systemNotify: boolean;
  /** 搜索收藏记录时启用拼音匹配（全拼/首字母），默认开启 */
  pinyinSearch: boolean;
  /**
   * 收藏列表排序方式（0.6.0）：选定后记住，下次打开插件仍用最后一次设定。
   * "smart" = 搜索时按相关度、无关键词时按更新时间；其余为具体排序键。
   */
  sortMode: "smart" | "recent" | "updated" | "created" | "hits" | "title" | "kind";
  /** 排序方向（asc 升序 / desc 降序） */
  sortDir: "asc" | "desc";
  /** 是否按「今天 / 昨天 / …」分组显示 */
  sortGroup: "none" | "day";
}

export interface DbResult {
  ok?: boolean;
  error?: boolean;
  id?: string;
  rev?: string;
  message?: string;
  name?: string;
}

export interface DbDoc {
  _id: string;
  _rev?: string;
  [key: string]: unknown;
}

/** 存储后端抽象：app 内用 utools.db，测试内用内存实现 */
export interface DbLike {
  put(doc: DbDoc): DbResult;
  get(id: string): DbDoc | null;
  remove(doc: DbDoc): DbResult | null;
  allDocs(idStartsWith?: string): DbDoc[];
}