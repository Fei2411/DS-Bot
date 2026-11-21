// The DSH interface primitives the Bot views draw with, all in one place. The desktop
// app's window does not load DSH's interface; its build puts its own module in place of
// this one (app/ui/src/primitives.js), which must export the same names. The settings
// icons and controls come first, then what a user message's text and files are drawn with.
export {
  FishLogo, MarkdownText, writeClipboard,
  IconAgentPresetOutlineMedium, IconArchiveOutlineMedium, IconPersonalizationOutlineMedium, IconSettingsOutlineMedium, IconUserOutlineMedium,
  IconDownloadOutlineRegular, IconLoadingOutlineRegular, RiskConfirmation, Button, ConnectionIndicator, Modal, Tooltip,
  FileTypeIcon, JsonBlock, fileExtension, fileSizeText, projectUserText,
} from '@deepseek-ai/dsh-client-ui-primitives'
