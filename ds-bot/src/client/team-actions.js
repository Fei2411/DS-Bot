// Re-export shared team action orchestration from team-core so existing imports
// and parallel PRs continue working without path churn.
export { sectionFoldWrites, teamActions } from './team-core/actions.js'
