import { resolve, sep } from 'node:path'
import {
  setAdditionalSkillDirectories,
  setOriginalCwd,
} from '../../bootstrap/state.js'
import { clearCommandsCache, getCommands } from '../../commands.js'
import { initBuiltinPlugins } from '../../plugins/bundled/index.js'
import { initBundledSkills } from '../../skills/bundled/index.js'
import type { Command } from '../../types/command.js'
import { applyDesktopRuntimeConfiguration } from '../bootstrap/runtimeConfiguration.js'
import type {
  RuntimeSessionOptions,
  RuntimeSkillCatalog,
  RuntimeSkillInfo,
  RuntimeSkillSource,
} from '../protocol/types.js'

function isInside(path: string, root: string): boolean {
  const normalizedPath = resolve(path)
  const normalizedRoot = resolve(root)
  return (
    normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}${sep}`)
  )
}

export type SkillCommand = Extract<Command, { type: 'prompt' }>

function resolveSource(
  command: SkillCommand,
  additionalSkillDirectories: string[],
): RuntimeSkillSource {
  if (
    command.skillRoot &&
    additionalSkillDirectories.some(directory =>
      isInside(command.skillRoot!, directory),
    )
  ) {
    return 'proma-project'
  }
  if (command.loadedFrom === 'bundled') return 'ccb-bundled'
  if (command.loadedFrom === 'plugin') return 'ccb-plugin'
  if (command.source === 'userSettings') return 'ccb-user'
  if (command.source === 'projectSettings') return 'ccb-project'
  if (command.source === 'policySettings' || command.loadedFrom === 'managed') {
    return 'ccb-managed'
  }
  return 'unknown'
}

function toSkillInfo(
  command: SkillCommand,
  additionalSkillDirectories: string[],
): RuntimeSkillInfo {
  const source = resolveSource(command, additionalSkillDirectories)
  const path = command.skillRoot ? resolve(command.skillRoot) : undefined
  return {
    id: `${source}:${command.name}:${path ?? 'memory'}`,
    name: command.name,
    description: command.description || command.whenToUse,
    source,
    path,
    enabled: true,
    userInvocable: command.userInvocable !== false,
    modelInvocable: command.disableModelInvocation !== true,
    pluginName: command.pluginInfo?.pluginManifest.name,
  }
}

export function buildRuntimeSkillCatalog(
  commands: Command[],
  cwd: string,
  additionalSkillDirectories: string[],
  resolvedAt = Date.now(),
): RuntimeSkillCatalog {
  const skills = commands
    .filter(
      (command): command is SkillCommand =>
        command.type === 'prompt' &&
        command.source !== 'builtin' &&
        (command.loadedFrom === 'skills' ||
          command.loadedFrom === 'plugin' ||
          command.loadedFrom === 'bundled' ||
          command.loadedFrom === 'managed' ||
          command.disableModelInvocation === true),
    )
    .map(command => toSkillInfo(command, additionalSkillDirectories))

  const winnerByName = new Map<string, string>()
  for (const skill of skills) {
    const winner = winnerByName.get(skill.name)
    if (winner) {
      skill.shadowedBy = winner
    } else {
      winnerByName.set(skill.name, skill.id)
    }
  }

  return {
    projectPath: resolve(cwd),
    skills,
    resolvedAt,
  }
}

export async function resolveDesktopSkillCatalog(
  options: RuntimeSessionOptions,
): Promise<RuntimeSkillCatalog> {
  initBuiltinPlugins()
  initBundledSkills()
  applyDesktopRuntimeConfiguration(
    options.environment,
    options.providerConfiguration,
  )
  setOriginalCwd(options.cwd)
  process.chdir(options.cwd)
  const additionalSkillDirectories = options.additionalSkillDirectories ?? []
  setAdditionalSkillDirectories(additionalSkillDirectories)
  clearCommandsCache()

  const commands = await getCommands(options.cwd)
  return buildRuntimeSkillCatalog(
    commands,
    options.cwd,
    additionalSkillDirectories,
  )
}
