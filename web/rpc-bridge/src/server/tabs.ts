/**
 * The server's tab registry.
 *
 * Upstream keeps tabs in the main process: the shell's renderer asks for the
 * list (`tabs:list`) and is told when it changes (`tabs:changed`), while the
 * editor views live in the main process as well. The browser has no main
 * process, so the tabs live here — on the server, next to the files they
 * point at.
 *
 * The shapes are upstream's (`apps/shell/src/shared/tabs-api.ts`): the shell
 * renderer consumes them unchanged.
 */

export type TabKind = 'home' | 'docs' | 'sheets' | 'slides' | 'pdf' | 'markdown' | 'html' | 'help'

export interface TabSummary {
  id: string
  kind: TabKind
  title: string
  closable: boolean
  active: boolean
  /** absolute path behind the tab; absent while the document is untitled */
  filePath?: string
  /** renderer released to free memory; reopens its file when shown */
  dormant?: boolean
  /** excluded from sleeping (tab context menu) */
  pinned?: boolean
}

/** Which upstream app opens a file with this extension. */
const KIND_BY_EXTENSION: Record<string, TabKind> = {
  docx: 'docs',
  doc: 'docs',
  dotx: 'docs',
  docm: 'docs',
  xlsx: 'sheets',
  xlsm: 'sheets',
  xlsb: 'sheets',
  xls: 'sheets',
  csv: 'sheets',
  tsv: 'sheets',
  ods: 'sheets',
  ots: 'sheets',
  pptx: 'slides',
  ppt: 'slides',
  pptm: 'slides',
  odp: 'slides',
  otp: 'slides',
  pdf: 'pdf',
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
}

export function tabKindForPath(filePath: string): TabKind {
  const match = /\.([a-z0-9]+)$/i.exec(filePath)
  const ext = match ? match[1].toLowerCase() : ''
  return KIND_BY_EXTENSION[ext] ?? 'docs'
}

export const HOME_TAB_ID = 'home'

interface Tab {
  id: string
  kind: TabKind
  title: string
  filePath?: string
}

export type TabChangeListener = (tabs: TabSummary[]) => void

export class TabRegistry {
  private readonly tabs = new Map<string, Tab>()
  private readonly listeners = new Set<TabChangeListener>()
  private activeId = HOME_TAB_ID
  private counter = 0

  constructor() {
    this.tabs.set(HOME_TAB_ID, { id: HOME_TAB_ID, kind: 'home', title: 'GenOffice' })
  }

  onChange(listener: TabChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  list(): TabSummary[] {
    return [...this.tabs.values()].map((tab) => ({
      id: tab.id,
      kind: tab.kind,
      title: tab.title,
      closable: tab.id !== HOME_TAB_ID,
      active: tab.id === this.activeId,
      ...(tab.filePath ? { filePath: tab.filePath } : {}),
    }))
  }

  /** The tab the caller belongs to, if it is known. */
  get(id: string): Tab | undefined {
    return this.tabs.get(id)
  }

  active(): Tab | undefined {
    return this.tabs.get(this.activeId)
  }

  /**
   * Open a document in a new tab, or focus the tab that already holds it.
   *
   * Upstream does the same in its tab manager: opening a file that is already
   * open switches to that tab instead of opening a second one.
   */
  open(filePath: string, title: string): Tab {
    const existing = [...this.tabs.values()].find((tab) => tab.filePath === filePath)
    if (existing) {
      this.activeId = existing.id
      this.notify()
      return existing
    }
    this.counter += 1
    const tab: Tab = {
      id: `tab-${this.counter}`,
      kind: tabKindForPath(filePath),
      title,
      filePath,
    }
    this.tabs.set(tab.id, tab)
    this.activeId = tab.id
    this.notify()
    return tab
  }

  /**
   * Open an untitled document in a new tab.
   *
   * Upstream opens a view with no file behind it; the file appears when the
   * document is saved. The tab carries no path, so the app boots into its
   * own blank state.
   */
  openBlank(kind: TabKind, title: string): Tab {
    this.counter += 1
    const tab: Tab = { id: `tab-${this.counter}`, kind, title }
    this.tabs.set(tab.id, tab)
    this.activeId = tab.id
    this.notify()
    return tab
  }

  activate(id: string): boolean {
    if (!this.tabs.has(id)) return false
    this.activeId = id
    this.notify()
    return true
  }

  close(id: string): boolean {
    if (id === HOME_TAB_ID || !this.tabs.has(id)) return false
    this.tabs.delete(id)
    if (this.activeId === id) {
      this.activeId = HOME_TAB_ID
    }
    this.notify()
    return true
  }

  private notify(): void {
    const snapshot = this.list()
    for (const listener of this.listeners) listener(snapshot)
  }
}
