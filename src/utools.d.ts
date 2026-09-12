// uTools 运行时 API 类型声明（仅 UI/浏览器侧使用）
interface UtoolsEnterAction {
  code: string;
  type: string;
  payload: unknown;
  from?: string;
  option?: Record<string, unknown>;
}

interface FlashStashBridge {
  getDataDir(): string;
  saveImageFile(input: unknown, ext?: string): { ok: boolean; path?: string; error?: string };
  readImageAsDataUrl(filePath: string): { ok: boolean; dataUrl?: string; error?: string };
  deleteFile(filePath: string): boolean;
  copyImageByPath(filePath: string): { ok: boolean; error?: string };
  copyText(text: string): { ok: boolean; error?: string };
  readClipboard(): { text: string | null; imageDataUrl: string | null };
}

interface Window {
  flashStash: FlashStashBridge;
  utools: {
    onPluginEnter(cb: (action: UtoolsEnterAction) => void): void;
    onPluginOut(cb: (isKill: boolean) => void): void;
    onThemeChange?(cb: (theme: "light" | "dark") => void): void;
    isDarkColors?(): boolean;
    db: {
      put(doc: { _id: string; _rev?: string; [k: string]: unknown }): { ok?: boolean; error?: boolean; id?: string; rev?: string; message?: string };
      get(id: string): { _id: string; _rev?: string; [k: string]: unknown } | null;
      remove(doc: { _id: string; [k: string]: unknown }): { ok?: boolean; error?: boolean; id?: string } | null;
      allDocs(idStartsWith?: string): { _id: string; _rev?: string; [k: string]: unknown }[];
    };
    copyText(text: string): boolean;
    copyImage(image: string): boolean;
    getPath(name: string): string;
    setExpendHeight(height: number): boolean;
    setSubInput(onChange: (d: { text: string }) => void, placeholder?: string, isFocus?: boolean): boolean;
    removeSubInput(): void;
    /** 隐藏主窗口（isRestorePreWindow：焦点是否回到之前活动窗口，默认 true） */
    hideMainWindow(isRestorePreWindow?: boolean): void;
    outPlugin(): void;
    showNotification(text: string, groupId?: string): void;
    /** 用系统默认浏览器打开外部链接（避免 webview 内导航跳走） */
    shellOpenExternal?(url: string): void;
    redirectHotKeySetting(cmdLabel: string, autocopy?: boolean): void;
    getUser(): { avatar?: string; nickname?: string } | null;
  };
}
