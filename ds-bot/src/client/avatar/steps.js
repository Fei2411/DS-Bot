// Building a model runs in steps of about STEP_MS. The steps are timed, not counted,
// so a slice of idle time stays short for every shape, on a slow machine as on a fast
// one. A generator checks `clock() - since > STEP_MS` where it can stop, yields, and
// starts timing again when it resumes.
export const STEP_MS = 1
export const clock = () => performance.now()
