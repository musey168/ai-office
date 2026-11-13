import type { ChannelHandler } from '../router'

/**
 * The app-wide preferences the renderers read on boot: language, theme,
 * author name, auto-save default, AI panel prefs.
 *
 * The values live on the server — one setting for the whole workspace — and
 * the renderers read them through the same channels upstream uses.
 */
export interface AppSettings {
  language: string
  theme: 'light' | 'dark' | 'system'
  documentTheme: 'dark' | 'light' | 'follow'
  authorName: string
  autoSave: { on: boolean; updatedAt: number }
  aiPanelPrefs: Record<string, unknown>
}

export const defaultAppSettings = (): AppSettings => ({
  language: 'zh',
  theme: 'system',
  documentTheme: 'follow',
  authorName: '',
  autoSave: { on: false, updatedAt: 0 },
  aiPanelPrefs: {},
})

export interface AppChannelDeps {
  settings: AppSettings
  /** Notifies the renderers that a preference changed. */
  onSettingsChanged?: (channel: string) => void
}

export function createAppChannels(deps: AppChannelDeps): Record<string, ChannelHandler> {
  const { settings } = deps
  return {
    'app:get-language': () => settings.language,
    'app:get-theme': () => settings.theme,
    'app:get-document-theme': () => settings.documentTheme,
    'app:get-ai-panel-prefs': () => settings.aiPanelPrefs,
    'app:get-author-name': () => settings.authorName,
    'app:auto-save-default': () => settings.autoSave,
    'app:system-locale': () => settings.language,
    'docs:system-locale': () => settings.language,
  }
}
