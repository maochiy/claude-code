import type { AgentSidePanelTab } from '@/atoms/agent-atoms'

export type StackableAgentSidePanelTab = 'plan' | 'tasks'

export interface SidePanelStackLayout {
  activeTab: AgentSidePanelTab
  stackedPrimary?: StackableAgentSidePanelTab
  auxiliaryTab?: StackableAgentSidePanelTab
}

function isStackableTab(tab: AgentSidePanelTab): tab is StackableAgentSidePanelTab {
  return tab === 'plan' || tab === 'tasks'
}

/**
 * 计划与后台任务允许同时纵向展示；其它功能仍由原有单面板 Tab 负责。
 * 防御性去重可避免同一轻量面板被重复挂载。
 */
export function resolveSidePanelStackLayout(
  stack: readonly AgentSidePanelTab[],
  fallbackActiveTab: AgentSidePanelTab,
): SidePanelStackLayout {
  const stackableTabs = stack
    .filter(isStackableTab)
    .filter((tab, index, tabs) => tabs.indexOf(tab) === index)
    .slice(0, 2)

  const stackedPrimary = stackableTabs[0]
  if (!stackedPrimary) return { activeTab: fallbackActiveTab }

  return {
    activeTab: stackedPrimary,
    stackedPrimary,
    auxiliaryTab: stackableTabs[1],
  }
}
