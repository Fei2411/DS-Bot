// Whether the app is in front, from React Native's AppState: `active`. iOS goes
// `inactive` on the way to the background and while the app switcher or a system sheet
// covers the app; nothing of the app moves then either. (Kept apart from host.ts so the
// clock's tests read it without React Native.)
export const shownState = (state: string | null | undefined) => state !== 'background' && state !== 'inactive'
