export const TASK_CATEGORIES = {
  coordination: 'Coordination',
  coding: 'Coding',
  review: 'Code review',
  research: 'Research',
  general: 'General',
}

export const RESPONSIBILITY_PRESETS = {
  coordinator: {
    label: 'Coordinator',
    instructions: 'Clarify the request, plan the work, delegate to the appropriate Bots, and report results and decisions to the user.',
    categories: ['coordination', 'research'],
  },
  coding: {
    label: 'Coding Agent',
    instructions: 'Implement the requested changes, run focused checks, and report the files changed and the verification results.',
    categories: ['coding'],
  },
  reviewer: {
    label: 'Code Reviewer',
    instructions: 'Review changes for correctness and regressions. Report findings with severity, evidence, and stable IDs. Use the structured review-fix action only when a Bot has been asked to address a specific finding.',
    categories: ['review'],
  },
  research_coding: {
    label: 'Research + Coding',
    instructions: 'Research the question using evidence, document sources and assumptions, and implement or verify code when requested.',
    categories: ['research', 'coding'],
  },
  custom: { label: 'Custom' },
}

export function cleanResponsibility(value) {
  if (!Object.hasOwn(RESPONSIBILITY_PRESETS, value?.preset) || !Array.isArray(value.categories)
    || value.categories.some(category => !Object.hasOwn(TASK_CATEGORIES, category))) {
    throw new Error('Choose a valid responsibility preset and task categories')
  }
  return {
    preset: value.preset,
    categories: [...new Set(value.categories)],
    ...(value.custom !== undefined ? {
      custom: {
        instructions: typeof value.custom?.instructions === 'string' ? value.custom.instructions.trim() : '',
        categories: Array.isArray(value.custom?.categories)
          ? [...new Set(value.custom.categories.filter(category => Object.hasOwn(TASK_CATEGORIES, category)))] : [],
      },
    } : {}),
  }
}

export function responsibilityDraft(bot, current, preset) {
  const custom = current.preset === 'custom' ? { instructions: current.instructions, categories: current.categories }
    : current.custom ?? bot.responsibility?.custom ?? { instructions: bot.instructions ?? '', categories: Object.keys(TASK_CATEGORIES) }
  const template = RESPONSIBILITY_PRESETS[preset]
  return { preset, custom, ...(preset === 'custom' ? custom : { instructions: template.instructions, categories: template.categories }) }
}

export function savedResponsibility(bot) {
  return {
    preset: bot.responsibility?.preset ?? 'custom',
    instructions: bot.instructions ?? '',
    categories: bot.responsibility?.categories ?? Object.keys(TASK_CATEGORIES),
    custom: bot.responsibility?.custom,
  }
}
