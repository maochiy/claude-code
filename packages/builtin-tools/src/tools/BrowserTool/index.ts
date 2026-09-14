import { BrowserAttachTool } from './BrowserAttachTool.js'
import { BrowserClickTool } from './BrowserClickTool.js'
import { BrowserCloseTool } from './BrowserCloseTool.js'
import { BrowserGetStateTool } from './BrowserGetStateTool.js'
import { BrowserHistoryTool } from './BrowserHistoryTool.js'
import { BrowserListSessionsTool } from './BrowserListSessionsTool.js'
import { BrowserListTasksTool } from './BrowserListTasksTool.js'
import { BrowserListTabsTool } from './BrowserListTabsTool.js'
import { BrowserNavigateTool } from './BrowserNavigateTool.js'
import { BrowserPressTool } from './BrowserPressTool.js'
import { BrowserScreenshotTool } from './BrowserScreenshotTool.js'
import { BrowserScrollTool } from './BrowserScrollTool.js'
import { BrowserTypeTool } from './BrowserTypeTool.js'

export {
  BrowserAttachTool,
  BrowserClickTool,
  BrowserCloseTool,
  BrowserGetStateTool,
  BrowserHistoryTool,
  BrowserListSessionsTool,
  BrowserListTabsTool,
  BrowserListTasksTool,
  BrowserNavigateTool,
  BrowserPressTool,
  BrowserScreenshotTool,
  BrowserScrollTool,
  BrowserTypeTool,
}

/**
 * 自研浏览器控制工具组（feature BROWSER_USE）。不进 CORE_TOOLS，
 * 走 SearchExtraTools 延迟发现。
 */
export const browserTools = [
  BrowserAttachTool,
  BrowserNavigateTool,
  BrowserGetStateTool,
  BrowserClickTool,
  BrowserTypeTool,
  BrowserPressTool,
  BrowserScrollTool,
  BrowserScreenshotTool,
  BrowserHistoryTool,
  BrowserCloseTool,
  BrowserListTasksTool,
  BrowserListTabsTool,
  BrowserListSessionsTool,
]
