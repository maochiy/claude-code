import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { SkillCommand } from './skillCatalog.js'
import { buildRuntimeSkillCatalog } from './skillCatalog.js'

function skillCommand(input: {
  name: string
  source: SkillCommand['source']
  loadedFrom: NonNullable<SkillCommand['loadedFrom']>
  skillRoot?: string
}): SkillCommand {
  return {
    type: 'prompt',
    name: input.name,
    description: `${input.name} description`,
    progressMessage: 'loading',
    contentLength: 1,
    source: input.source,
    loadedFrom: input.loadedFrom,
    skillRoot: input.skillRoot,
    getPromptForCommand: async () => [],
  }
}

describe('Desktop Runtime Skill Catalog', () => {
  test('识别 CCB 项目、CCB 内置与 Proma 宿主 Skills 来源', () => {
    const projectPath = '/tmp/project'
    const promaSkillsPath = '/tmp/proma-skills'
    const catalog = buildRuntimeSkillCatalog(
      [
        skillCommand({
          name: 'proma-documents',
          source: 'projectSettings',
          loadedFrom: 'skills',
          skillRoot: join(promaSkillsPath, 'proma-documents'),
        }),
        skillCommand({
          name: 'project-review',
          source: 'projectSettings',
          loadedFrom: 'skills',
          skillRoot: join(projectPath, '.claude/skills/project-review'),
        }),
        skillCommand({
          name: 'ccb-builtin',
          source: 'bundled',
          loadedFrom: 'bundled',
        }),
      ],
      projectPath,
      [promaSkillsPath],
      123,
    )

    expect(catalog.projectPath).toBe(projectPath)
    expect(catalog.resolvedAt).toBe(123)
    expect(catalog.skills.map(skill => [skill.name, skill.source])).toEqual([
      ['proma-documents', 'proma-project'],
      ['project-review', 'ccb-project'],
      ['ccb-builtin', 'ccb-bundled'],
    ])
  })

  test('同名 Skill 保留 CCB 命令解析顺序并标记被覆盖项', () => {
    const catalog = buildRuntimeSkillCatalog(
      [
        skillCommand({
          name: 'review',
          source: 'userSettings',
          loadedFrom: 'skills',
          skillRoot: '/tmp/user/review',
        }),
        skillCommand({
          name: 'review',
          source: 'projectSettings',
          loadedFrom: 'skills',
          skillRoot: '/tmp/project/.claude/skills/review',
        }),
      ],
      '/tmp/project',
      [],
    )

    expect(catalog.skills[0]?.shadowedBy).toBeUndefined()
    expect(catalog.skills[1]?.shadowedBy).toBe(catalog.skills[0]?.id)
  })
})
