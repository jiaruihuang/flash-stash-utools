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