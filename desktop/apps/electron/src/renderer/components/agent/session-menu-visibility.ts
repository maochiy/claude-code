export function shouldShowPlanEntry(input: {
  hasPlanDocument: boolean
  visibleTodoCount: number
}): boolean {
  return input.hasPlanDocument || input.visibleTodoCount > 0
}

export function shouldShowBackgroundTasksEntry(taskCount: number): boolean {
  return taskCount > 0
}
