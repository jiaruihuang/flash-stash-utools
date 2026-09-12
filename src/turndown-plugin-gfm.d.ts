// turndown-plugin-gfm 自带的 CJS 无类型声明，这里补一个最小声明
declare module "turndown-plugin-gfm" {
  import type { TurndownService } from "turndown";
  /** 表格 / 删除线 / 任务列表等 GFM 规则的组合插件，用法：td.use(gfm) */
  export const gfm: (service: TurndownService) => void;
  export const tables: (service: TurndownService) => void;
  export const strikethrough: (service: TurndownService) => void;
  export const taskListItems: (service: TurndownService) => void;
}