/**
 * The server-side stand-in for Electron.
 *
 * The upstream format engines live in pure packages, but some of the code
 * that turns a parsed document into what a renderer draws sits in the apps'
 * main-process modules — and those import Electron at the top.
 *
 * The server has no windows, no menus and no native dialogs, so the pieces
 * that need them are answered honestly: the window lookups find nothing, and
 * the operations that would touch the desktop are refused rather than
 * silently pretended.
 *
 * This is the same trick as the browser-side shim, on the other side of the
 * wire: the upstream source is compiled as-is, with `electron` pointing here.
 */

export interface ServerWindow {
  id: number
  webContents: ServerWebContents
  isDestroyed(): boolean
}

export interface ServerWebContents {
  id: number
  send(channel: string, ...args: unknown[]): void
  isDestroyed(): boolean
}

/** The upstream code names this type `WebContents`. */
export type WebContents = ServerWebContents

const noWindows: ServerWindow[] = []

export class BrowserWindow {
  static getAllWindows(): ServerWindow[] {
    return noWindows
  }

  static getFocusedWindow(): ServerWindow | null {
    return null
  }

  static fromWebContents(_contents?: ServerWebContents): ServerWindow | null {
    return null
  }

  readonly id: number
  readonly webContents: ServerWebContents

  constructor() {
    this.id = 0
    this.webContents = {
      id: 0,
      send: () => {},
      isDestroyed: () => true,
    }
  }

  isDestroyed(): boolean {
    return true
  }
}

export const webContents = {
  getAllWebContents: (): ServerWebContents[] => [],
  fromId: (_id: number): ServerWebContents | undefined => undefined,
  getFocusedWebContents: (): ServerWebContents | undefined => undefined,
}

export const app = {
  getPath: (name: string): string => {
    if (name === 'temp') return '/tmp'
    return process.env.AIOFFICE_APP_DATA ?? '/tmp'
  },
  getVersion: (): string => '0.0.0',
  getName: (): string => 'ai-office',
  isPackaged: false,
  on: () => app,
  once: () => app,
  quit: () => {},
  whenReady: async (): Promise<void> => {},
}

export const ipcMain = {
  handle: () => {},
  handleOnce: () => {},
  on: () => {},
  once: () => {},
  removeHandler: () => {},
  removeAllListeners: () => {},
}

export const ipcRenderer = {
  invoke: async (): Promise<never> => {
    throw new Error('the server has no renderer')
  },
  send: () => {},
  on: () => {},
  once: () => {},
  removeListener: () => {},
}

export const nativeImage = {
  createFromBuffer: (): { isEmpty: () => boolean; toPNG: () => Buffer } => ({
    isEmpty: () => true,
    toPNG: () => Buffer.alloc(0),
  }),
  createFromPath: (): { isEmpty: () => boolean; toPNG: () => Buffer } => ({
    isEmpty: () => true,
    toPNG: () => Buffer.alloc(0),
  }),
  createEmpty: (): { isEmpty: () => boolean; toPNG: () => Buffer } => ({
    isEmpty: () => true,
    toPNG: () => Buffer.alloc(0),
  }),
}

export const shell = {
  openPath: async (): Promise<string> => '',
  openExternal: async (): Promise<void> => {},
  showItemInFolder: (): void => {},
  trashItem: async (): Promise<void> => {},
}

export const clipboard = {
  writeText: () => {},
  writeImage: () => {},
  readText: (): string => '',
  readImage: (): null => null,
}

export const dialog = {
  showOpenDialog: async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({
    canceled: true,
    filePaths: [],
  }),
  showSaveDialog: async (): Promise<{ canceled: boolean; filePath?: string }> => ({
    canceled: true,
  }),
  showMessageBox: async (): Promise<{ response: number }> => ({ response: 1 }),
}

export const net = {
  fetch: async (...args: unknown[]): Promise<unknown> => fetch(...(args as [string])),
  request: (): never => {
    throw new Error('the server does not make Electron network requests')
  },
}

export const screen = {
  getPrimaryDisplay: () => ({
    workAreaSize: { width: 1920, height: 1080 },
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  }),
  getAllDisplays: () => [],
}

export const systemPreferences = {
  getMediaAccessStatus: (): string => 'not-determined',
  isDarkMode: (): boolean => false,
}

export const session = {
  defaultSession: {
    webRequest: { onBeforeRequest: () => {} },
    protocol: { handle: () => {}, unhandle: () => {} },
    setPermissionRequestHandler: () => {},
  },
}

export const Menu = {
  buildFromTemplate: (): unknown => ({}),
  setApplicationMenu: () => {},
}
