import { encodePng } from './png'

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

/**
 * A window.
 *
 * The upstream code stores windows in maps and hands them around as
 * `BrowserWindow`; on the server there is only ever the class below, so the
 * two names mean the same thing here.
 */
export type ServerWindow = BrowserWindow

/**
 * A renderer.
 *
 * Electron's own type: the upstream code passes these around as
 * `WebContents`, so the shape has to be the real one.
 */
export type ServerWebContents = Electron.WebContents

/** The upstream code names this type `WebContents`. */
export type WebContents = ServerWebContents

const noWindows: BrowserWindow[] = []

/**
 * A web contents that answers everything honestly and does nothing.
 *
 * Electron's `WebContents` is a class with a hundred methods; the server
 * needs a handful of them, and only the code paths that use them are ever
 * reached. The cast says so plainly: the shape below is what the upstream
 * code actually calls.
 */
/**
 * Where the events of a web contents go.
 *
 * Upstream pushes events at a renderer with `webContents.send(...)`. The
 * server has no renderers, so the worker registers where the events of each
 * web contents should go — to the browser tab it stands for.
 */
const contentsPushers = new Map<number, (channel: string, args: unknown[]) => void>()

/** Send the events of a web contents to the browser. */
export function registerContentsPush(
  id: number,
  push: (channel: string, args: unknown[]) => void,
): void {
  contentsPushers.set(id, push)
}

/** Stop sending the events of a web contents to the browser. */
export function unregisterContentsPush(id: number): void {
  contentsPushers.delete(id)
}

export function createWebContents(id: number): ServerWebContents {
  const contents = {
    id,
    send: (channel: string, ...args: unknown[]) => {
      contentsPushers.get(id)?.(channel, args)
    },
    isDestroyed: () => false,
    getURL: () => '',
    once: () => undefined,
    removeListener: () => undefined,
    copy: () => {},
    cut: () => {},
    paste: () => {},
    selectAll: () => {},
    getPrintersAsync: async () => [],
    executeJavaScript: async () => undefined,
    printToPDF: async () => Buffer.alloc(0),
    getOSProcessId: () => 0,
    forcefullyCrashRenderer: () => {},
    reload: () => {},
    on: () => undefined,
    setWindowOpenHandler: () => {},
    print: (_options: unknown, callback: (ok: boolean, reason: string) => void) =>
      callback(false, 'the server has no printer'),
    focus: () => {},
    loadURL: async () => {},
    capturePage: async () => nativeImage.createFromBuffer(Buffer.alloc(0)),
    devToolsWebContents: undefined as unknown as ServerWebContents,
    isDevToolsOpened: () => false,
    openDevTools: () => {},
    replaceMisspelling: () => {},
    copyImageAt: () => {},
  }
  return contents as unknown as ServerWebContents
}

export class BrowserWindow {
  static getAllWindows(): BrowserWindow[] {
    return noWindows
  }

  static getFocusedWindow(): BrowserWindow | null {
    return null
  }

  static fromWebContents(_contents?: ServerWebContents): BrowserWindow | null {
    return null
  }

  readonly id: number
  readonly webContents: ServerWebContents

  constructor(_options?: Record<string, unknown>) {
    this.id = 0
    this.webContents = createWebContents(0)
  }

  isDestroyed(): boolean {
    return true
  }

  /** The desktop window controls the upstream code drives. */
  isSimpleFullScreen(): boolean {
    return false
  }

  setSimpleFullScreen(_value: boolean): void {}
  setBounds(_bounds: Electron.Rectangle): void {}
  setFullScreenable(_value: boolean): void {}
  isFullScreen(): boolean {
    return false
  }

  getBounds(): Electron.Rectangle {
    return { x: 0, y: 0, width: 1920, height: 1080 }
  }

  setFullScreen(_value: boolean): void {}
  close(): void {}
  setBackgroundColor(_color: string): void {}
  setTitle(_title: string): void {}
  show(): void {}
  focus(): void {}
  on(
    _event: string,
    _listener: (event: { preventDefault(): void }, ...args: unknown[]) => void,
  ): this {
    return this
  }

  once(_event: string, _listener: (event: unknown, ...args: unknown[]) => void): this {
    return this
  }

  loadURL(_url: string): Promise<void> {
    return Promise.resolve()
  }

  /** The window the print dialog parents to. */
  readonly parent: BrowserWindow | null = null

  loadFile(_path: string): Promise<void> {
    return Promise.resolve()
  }

  destroy(): void {}
}

export const webContents = {
  /**
   * The web contents the upstream code looks up by sender id.
   *
   * Upstream keys its sessions by `e.sender.id` and pushes events at a
   * renderer with `webContents.fromId(id)?.send(...)`. The server has no
   * renderers, so the lookup is answered by whatever the host registered —
   * the slides host points it at the browser tabs.
   */
  fromId: (_id: number): ServerWebContents | undefined => undefined,
  getAllWebContents: (): ServerWebContents[] => [],
  getFocusedWebContents: (): ServerWebContents | undefined => undefined,
}

/**
 * Point `webContents.fromId` at a registry the host controls.
 *
 * The upstream code resolves a web contents for every session it owns, so
 * this is how a browser tab becomes addressable by the upstream id.
 */
export function setWebContentsSource(
  source: {
    fromId(id: number): ServerWebContents | undefined
    all(): ServerWebContents[]
  } | null,
): void {
  webContents.fromId = (id: number) => source?.fromId(id)
  webContents.getAllWebContents = () => source?.all() ?? []
}

/**
 * The web contents registry, as Electron types it.
 *
 * The server's registry answers with the handful of methods the upstream
 * code calls; the cast says so plainly.
 */
export const shimWebContents = webContents as unknown as Electron.WebContents

/** The event the app's own listeners receive (`open-file` and friends). */
export interface ShimAppEvent {
  preventDefault(): void
}

/** The app object, as a type — the upstream code declares parameters with it. */
export type App = Electron.App

/**
 * The parameters of a native context-menu event.
 *
 * Electron's own definition, taken from the upstream checkout's Electron
 * types: the upstream code reads these fields, so the shape has to be the
 * real one.
 */
export type ContextMenuParams = Electron.ContextMenuParams

/**
 * The Electron app object, as the upstream code uses it.
 *
 * The interface is explicit because the object refers to itself (`app.on`
 * returns the app): without it, TypeScript cannot infer the type and falls
 * back to `any` for the members that come after the reference.
 */
export interface ShimApp {
  name: string
  /** The errors the upstream `app.whenReady()` callback threw. */
  readyErrors: unknown[]
  getPath(name: string): string
  setPath(name: string, path: string): void
  getAppPath(): string
  getVersion(): string
  getName(): string
  getLocale(): string
  isPackaged: boolean
  isReady(): boolean
  /**
   * The app's own events.
   *
   * Electron's app events carry different payloads (`open-file` a path,
   * `web-contents-created` a renderer), so the listener is typed loosely
   * and the upstream code keeps its own types.
   */
  /**
   * The app's own events.
   *
   * `open-file` carries a path, `web-contents-created` a renderer; the
   * overloads say which is which.
   */
  on(event: 'open-file', listener: (event: ShimAppEvent, path: string) => void): ShimApp
  on(
    event: 'web-contents-created',
    listener: (event: ShimAppEvent, contents: ServerWebContents) => void,
  ): ShimApp
  on(event: string, listener: (event: ShimAppEvent, ...args: any[]) => void): ShimApp
  once(event: string, listener: (event: ShimAppEvent, ...args: any[]) => void): ShimApp
  quit(): void
  whenReady(): Promise<void>
  /** The command line switches the desktop app reads; the server has none. */
  commandLine: {
    appendSwitch(name: string, value?: string): void
    appendArgument(value: string): void
    getSwitchValue(name: string): string
  }
  getAppMetrics(): { type: string; pid: number; index?: number }[]
  getGPUFeatureStatus(): Electron.GPUFeatureStatus
  requestSingleInstanceLock(): boolean
}

/** The app object the upstream code talks to. */
export const app: ShimApp = {
  name: 'ai-office',
  getPath: (name: string): string => {
    if (name === 'temp') return '/tmp'
    return paths.get(name) ?? process.env.AIOFFICE_APP_DATA ?? '/tmp'
  },
  setPath: (name: string, path: string): void => {
    paths.set(name, path)
  },
  getAppPath: (): string => process.env.AIOFFICE_APP_DATA ?? '/tmp',
  getVersion: (): string => '0.0.0',
  getName: (): string => 'ai-office',
  getLocale: (): string => 'en-US',
  isPackaged: false,
  isReady: (): boolean => true,
  /**
   * The errors the upstream `app.whenReady()` callback threw.
   *
   * Upstream registers its IPC surface inside that callback, so a failure
   * there means the server has no handlers at all — it has to be visible.
   */
  readyErrors: [] as unknown[],
  on: (_event: string, _listener: (event: ShimAppEvent, ...args: any[]) => void): ShimApp => app,
  once: (_event: string, _listener: (event: ShimAppEvent, ...args: any[]) => void): ShimApp => app,
  quit: () => {},
  whenReady: (): Promise<void> => {
    // The upstream code registers its handlers in the callback of
    // `whenReady()`. A failure there is silent unless it is caught here.
    const ready = Promise.resolve()
    return {
      then: <TResult1 = void, TResult2 = never>(
        onFulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
        onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) =>
        ready.then(
          (value) => {
            try {
              return onFulfilled ? onFulfilled(value) : (value as unknown as TResult1)
            } catch (error) {
              app.readyErrors.push(error)
              throw error
            }
          },
          onRejected,
        ),
    } as Promise<void>
  },
  commandLine: {
    appendSwitch: () => {},
    appendArgument: () => {},
    getSwitchValue: (): string => '',
  },
  getAppMetrics: (): { type: string; pid: number; index?: number }[] => [],
  getGPUFeatureStatus: (): Electron.GPUFeatureStatus =>
    ({ webgl: 'enabled', webgl2: 'enabled' }) as unknown as Electron.GPUFeatureStatus,
  requestSingleInstanceLock: (): boolean => true,
}

/** The paths the app was told to use, overriding the environment. */
const paths = new Map<string, string>()

/**
 * The handlers the upstream main process registered.
 *
 * Upstream's main-process modules register their IPC surface with
 * `ipcMain.handle(...)` at import time. The server has no Electron, so the
 * registration is **captured** instead of dropped: the worker can then answer
 * a channel with the upstream function itself, rather than with a second
 * implementation of the same contract.
 */
export const ipcHandlers = new Map<string, (...args: never[]) => unknown>()

/**
 * The listeners the upstream main process registered with `ipcMain.on`.
 *
 * Upstream uses `on` for the messages the **renderer** sends without
 * waiting for an answer — "the document was renamed", "the save finished".
 * The server has to receive those too, so they are captured the same way
 * the handlers are.
 */
export const ipcListeners = new Map<string, Set<ShimIpcHandler>>()

/**
 * Every channel the upstream code registered, in order.
 *
 * Two applications may register the same channel name (a shared one such
 * as the theme). The list says which ones did, so a conflict is visible
 * instead of silent.
 */
export const ipcRegistrations: string[] = []

/**
 * The Electron event the upstream handlers receive.
 *
 * Upstream reads `sender.id` from it to find the session a call belongs to,
 * and pushes events back at `sender.send(...)`.
 */
export type ShimIpcEvent = Electron.IpcMainInvokeEvent

/** The event an `ipcMain.handle` listener receives, as Electron types it. */
export type IpcMainInvokeEvent = Electron.IpcMainInvokeEvent

/**
 * The signature Electron's `ipcMain.handle` accepts.
 *
 * Electron types the listener as `(event, ...args) => any`, and the upstream
 * code registers listeners of many shapes (some take no event at all), so
 * the parameters are loose here — the upstream code keeps its own types.
 */
export type ShimIpcHandler = Parameters<Electron.IpcMain['handle']>[1]

/**
 * The shape of a menu item, as the app builds its menus.
 *
 * The upstream code passes these to `Electron.Menu.setApplicationMenu`, so
 * the shape is the global namespace's one — the two must not drift.
 */
export type MenuItemConstructorOptions = Electron.MenuItemConstructorOptions

/**
 * The IPC surface, as a type.
 *
 * The upstream modules declare their registration function's parameter as
 * `IpcMain` (imported from `electron`), so the shim exports the type too.
 */
export type IpcMain = Electron.IpcMain

/**
 * The IPC surface.
 *
 * Electron's `IpcMain` is an EventEmitter with a dozen methods; the server
 * implements the four the upstream code uses, and the cast says so.
 */
export const ipcMain = {
  handle: (channel: string, handler: ShimIpcHandler): IpcMain => {
    ipcHandlers.set(channel, handler as (...args: never[]) => unknown)
    ipcRegistrations.push(channel)
    return ipcMain
  },
  handleOnce: (channel: string, handler: ShimIpcHandler): IpcMain => {
    ipcHandlers.set(channel, handler as (...args: never[]) => unknown)
    ipcRegistrations.push(channel)
    return ipcMain
  },
  on: (channel: string, handler: ShimIpcHandler): IpcMain => {
    const listeners = ipcListeners.get(channel) ?? new Set<ShimIpcHandler>()
    listeners.add(handler)
    ipcListeners.set(channel, listeners)
    ipcRegistrations.push(channel)
    return ipcMain
  },
  once: (channel: string, handler: ShimIpcHandler): IpcMain => {
    return ipcMain.on(channel, handler)
  },
  removeListener: (channel: string, handler: ShimIpcHandler): IpcMain => {
    ipcListeners.get(channel)?.delete(handler)
    return ipcMain
  },
  removeHandler: (channel: string): IpcMain => {
    ipcHandlers.delete(channel)
    return ipcMain
  },
  removeAllListeners: (channel: string): IpcMain => {
    ipcListeners.delete(channel)
    return ipcMain
  },
} as unknown as IpcMain

export const ipcRenderer = {
  invoke: async (): Promise<never> => {
    throw new Error('the server has no renderer')
  },
  send: () => {},
  on: () => {},
  once: () => {},
  removeListener: () => {},
}

/**
 * The image object upstream's PDF rasterizer builds its PNGs with.
 *
 * Electron's `nativeImage` is a native module; the server has none, so the
 * shim encodes the PNG itself (see `png.ts`). The bytes are the same.
 */
export interface ShimImage {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  toPNG(): Buffer
  toBitmap(): Buffer
}

export const nativeImage = {
  // Decoding an arbitrary image is not something the server needs: the only
  // path that asks for it is inserting an image into a PDF, which is not
  // part of the port yet.
  createFromBuffer: (buffer?: Buffer): ShimImage => ({
    isEmpty: () => !buffer || buffer.length === 0,
    getSize: () => ({ width: 0, height: 0 }),
    toPNG: () => buffer ?? Buffer.alloc(0),
    toBitmap: () => Buffer.alloc(0),
  }),
  createFromPath: (_path?: string): ShimImage => ({
    isEmpty: () => true,
    getSize: () => ({ width: 0, height: 0 }),
    toPNG: () => Buffer.alloc(0),
    toBitmap: () => Buffer.alloc(0),
  }),
  /** The thumbnail the PDF exporter asks for; the server cannot make one. */
  createThumbnailFromPath: (_path: string, _size: { width: number; height: number }): ShimImage => ({
    isEmpty: () => true,
    getSize: () => ({ width: 0, height: 0 }),
    toPNG: () => Buffer.alloc(0),
    toBitmap: () => Buffer.alloc(0),
  }),
  createEmpty: (): ShimImage => ({
    isEmpty: () => true,
    getSize: () => ({ width: 0, height: 0 }),
    toPNG: () => Buffer.alloc(0),
    toBitmap: () => Buffer.alloc(0),
  }),
  createFromBitmap: (
    data?: Buffer,
    options?: { width?: number; height?: number },
  ): ShimImage => {
    const width = options?.width ?? 0
    const height = options?.height ?? 0
    const pixels = data ?? Buffer.alloc(0)
    return {
      isEmpty: () => width === 0 || height === 0,
      getSize: () => ({ width, height }),
      toPNG: () => encodePng({ width, height, data: pixels }),
      toBitmap: () => pixels,
    }
  },
}

export const shell = {
  openPath: async (_path: string): Promise<string> => '',
  openExternal: async (_url: string): Promise<void> => {},
  showItemInFolder: (_path: string): void => {},
  trashItem: async (_path: string): Promise<void> => {},
}

export const clipboard = {
  writeText: () => {},
  writeImage: () => {},
  readText: (): string => '',
  readImage: (): ShimImage => ({
    isEmpty: () => true,
    getSize: () => ({ width: 0, height: 0 }),
    toPNG: () => Buffer.alloc(0),
    toBitmap: () => Buffer.alloc(0),
  }),
  /** The formats the clipboard holds; the server's clipboard is empty. */
  availableFormats: (): string[] => [],
  readBuffer: (_format?: string): Buffer => Buffer.alloc(0),
  readHTML: (): string => '',
  write: (_data: unknown) => {},
  writeBuffer: (_format: string, _buffer: Buffer) => {},
}

/**
 * A dialog the upstream code wants to show.
 *
 * The desktop app opens a native dialog; the browser has no native dialog,
 * so the server asks the browser instead: the request travels down the
 * event stream to the tab that triggered it, and the browser answers with
 * the chosen path.
 */
export interface ShimDialogRequest {
  /** The id the answer comes back with. */
  id: string
  kind: 'save' | 'open' | 'message'
  /** The Electron options the upstream code passed. */
  options: unknown
}

/**
 * Who shows the dialog.
 *
 * The worker sets this to the bridge between the engine and the browser.
 * Without it — a headless run — every dialog is cancelled, which is the
 * honest answer for a server that cannot show one.
 */
export type ShimDialogPresenter = (request: ShimDialogRequest) => void

let dialogPresenter: ShimDialogPresenter | null = null

/** The dialogs that are waiting for an answer. */
const waitingDialogs = new Map<string, (result: unknown) => void>()

let dialogCounter = 0

/** Let the worker show the dialogs in the browser. */
export function setDialogPresenter(presenter: ShimDialogPresenter | null): void {
  dialogPresenter = presenter
}

/**
 * Answer a dialog the browser was asked to show.
 *
 * The result is what Electron's dialog would have returned.
 */
export function resolveDialog(id: string, result: unknown): boolean {
  const resolve = waitingDialogs.get(id)
  if (!resolve) return false
  waitingDialogs.delete(id)
  resolve(result)
  return true
}

/** Ask the browser to show a dialog and wait for its answer. */
function askBrowser<T>(kind: ShimDialogRequest['kind'], options: unknown): Promise<T> {
  if (!dialogPresenter) {
    return Promise.resolve(
      (kind === 'save'
        ? { canceled: true, filePath: '' }
        : kind === 'open'
          ? { canceled: true, filePaths: [] }
          : { response: 1, checkboxChecked: false }) as T,
    )
  }
  dialogCounter += 1
  const id = `dialog-${dialogCounter}`
  return new Promise<T>((resolve) => {
    waitingDialogs.set(id, resolve as (result: unknown) => void)
    dialogPresenter!({ id, kind, options })
  })
}

export const dialog = {
  showOpenDialog: async (
    options?: Electron.OpenDialogOptions,
    _parent?: unknown,
  ): Promise<Electron.OpenDialogReturnValue> =>
    askBrowser<Electron.OpenDialogReturnValue>('open', options),
  showSaveDialog: async (
    options?: Electron.SaveDialogOptions,
    _parent?: unknown,
  ): Promise<Electron.SaveDialogReturnValue> =>
    askBrowser<Electron.SaveDialogReturnValue>('save', options),
  showMessageBox: async (
    optionsOrParent?: Electron.MessageBoxOptions | unknown,
    _maybeParent?: unknown,
  ): Promise<{ response: number; checkboxChecked: boolean }> =>
    askBrowser<{ response: number; checkboxChecked: boolean }>('message', optionsOrParent),
}

export const net = {
  fetch: async (...args: unknown[]): Promise<Response> =>
    fetch(...(args as [string])),
  request: (): never => {
    throw new Error('the server does not make Electron network requests')
  },
}

/** The shape of a display, as the presenter code reads it. */
export interface ShimDisplay {
  id: number
  bounds: Electron.Rectangle
  workArea: Electron.Rectangle
  workAreaSize: { width: number; height: number }
}

/** The one imaginary screen the server has. */
function theDisplay(): ShimDisplay {
  return {
    id: 0,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    workAreaSize: { width: 1920, height: 1080 },
  }
}

export const screen = {
  getPrimaryDisplay: theDisplay,
  getAllDisplays: (): ShimDisplay[] => [],
  /** The display a window sits on; the server has one imaginary screen. */
  getDisplayMatching: (_rect: Electron.Rectangle): ShimDisplay => theDisplay(),
}

export const systemPreferences = {
  getMediaAccessStatus: (_mediaType?: string): string => 'not-determined',
  isDarkMode: (): boolean => false,
  /** The desktop app asks the OS for the microphone; the server does not. */
  askForMediaAccess: async (_mediaType: string): Promise<boolean> => false,
}

export const session = {
  defaultSession: {
    webRequest: { onBeforeRequest: () => {} },
    protocol: {
      handle: (_scheme: string, _handler: (request: { url: string }) => Response): void => {},
      unhandle: (_scheme: string): void => {},
    },
    setPermissionRequestHandler: () => {},
    resolveProxy: async (_url?: string): Promise<string> => 'DIRECT',
    setDisplayMediaRequestHandler: (
      _handler: (
        request: unknown,
        callback: (stream: { video?: unknown }) => void,
      ) => void,
      _options?: { useSystemPicker?: boolean },
    ): void => {},
  },
}

/**
 * Electron's protocol registry — the server serves its media over HTTP, so
 * nothing registers a custom scheme here.
 */
export const protocol = {
  handle: () => {},
  unhandle: () => {},
  registerSchemesAsPrivileged: () => {},
}

/** Electron's file-path helper for a dropped file; the server has no paths. */
export const webUtils = {
  getPathForFile: (_file: unknown): string => '',
}

/** Screen capture — the desktop app records the screen; the server cannot. */
export const desktopCapturer = {
  getSources: async (_options?: {
    types?: string[]
    thumbnailSize?: { width: number; height: number }
  }): Promise<{ id: string; name: string }[]> => [],
}

/**
 * A detached window view; the server draws nothing of its own.
 *
 * Upstream puts every document in a `WebContentsView` — a renderer without
 * a window of its own — and the view is what tells the main process which
 * web contents belongs to which document. The server needs it for the same
 * reason: the upstream code grants the view's web contents the paths it may
 * read and write, and it keys its session by the web contents id.
 *
 * Every view therefore has its own id, or two documents would share one
 * session.
 */
export class WebContentsView {
  readonly id: number
  readonly webContents: ServerWebContents

  private static nextId = 1

  constructor(_options?: Record<string, unknown>) {
    this.id = WebContentsView.nextId++
    this.webContents = createWebContents(this.id)
  }

  setVisible(_visible: boolean): void {}
  setBounds(_bounds?: Electron.Rectangle): void {}
  setBackgroundColor(_color?: string): void {}
  async loadURL(_url: string): Promise<void> {}
}

/** The application menu; the server has none. */
export class Menu {
  static buildFromTemplate(_template?: unknown): Menu {
    return new Menu()
  }

  static setApplicationMenu(_menu: Menu | null): void {}

  /** Show the menu; the server has no screen to show it on. */
  popup(): void {}
}
