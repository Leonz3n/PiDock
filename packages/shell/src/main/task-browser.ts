import { session, WebContentsView } from "electron";
import type {
  BrowserWindow,
  Rectangle,
  Session,
  WebPreferences,
} from "electron";
import { taskPartitionName } from "./task-partition.js";
import type { TrustDomainRegistry } from "./trust-domain.js";

export interface TaskTab {
  readonly taskId: string;
  readonly pageId: string;
  readonly viewId: string;
  readonly webContentsId: number;
  readonly view: WebContentsView;
}

export interface TaskPopup {
  readonly taskId: string;
  readonly openerPageId: string;
  readonly pageId: string;
  readonly viewId: string;
  readonly webContentsId: number;
  readonly window: BrowserWindow;
}

export interface TaskBrowserOptions {
  readonly window: BrowserWindow;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly bounds: Rectangle;
  readonly registry: TrustDomainRegistry;
}

const SAFE_TASK_WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
} satisfies WebPreferences;

/**
 * Main-process owner for one task's browser views.
 *
 * Every tab and popup in the task uses the same persistent partition. A
 * page handle always carries both task and page identity, and the registry
 * is updated in lockstep with the live WebContents instance.
 */
export class TaskBrowser {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly partition: string;
  readonly session: Session;

  private readonly window: BrowserWindow;
  private bounds: Rectangle;
  private readonly registry: TrustDomainRegistry;
  private readonly tabsById = new Map<string, TaskTab>();
  private readonly popupsById = new Map<number, TaskPopup>();
  private activePageId: string | undefined;
  private nextPageNumber = 1;
  private closing = false;

  constructor(options: TaskBrowserOptions) {
    if (options.taskId.trim().length === 0) {
      throw new Error("taskId must be a non-empty string");
    }
    this.window = options.window;
    this.workspaceId = options.workspaceId;
    this.taskId = options.taskId;
    this.bounds = { ...options.bounds };
    this.registry = options.registry;
    this.partition = taskPartitionName(options.taskId, options.workspaceId);
    this.session = session.fromPartition(this.partition);
    this.window.once("closed", () => this.close());
  }

  get tabs(): readonly TaskTab[] {
    return [...this.tabsById.values()];
  }

  get popups(): readonly TaskPopup[] {
    return [...this.popupsById.values()];
  }

  get activeTab(): TaskTab | undefined {
    return this.activePageId
      ? this.tabsById.get(this.activePageId)
      : undefined;
  }

  get webPreferences(): WebPreferences {
    return this.createWebPreferences();
  }

  setBounds(bounds: Rectangle): void {
    this.bounds = { ...bounds };
    this.activeTab?.view.setBounds(this.bounds);
  }

  async openTab(url: string, preferredPageId?: string): Promise<TaskTab> {
    if (this.closing) throw new Error(`task ${this.taskId} is closing`);
    const pageId = preferredPageId ?? this.nextAutomaticPageId();
    if (pageId.trim().length === 0) {
      throw new Error("pageId must be a non-empty string");
    }
    if (this.tabsById.has(pageId)) {
      throw new Error(`duplicate pageId for task ${this.taskId}: ${pageId}`);
    }

    const view = new WebContentsView({
      webPreferences: this.createWebPreferences(),
    });
    const tab: TaskTab = {
      taskId: this.taskId,
      pageId,
      viewId: `${this.taskId}:${pageId}`,
      webContentsId: view.webContents.id,
      view,
    };

    this.registry.registerTask({
      webContentsId: tab.webContentsId,
      viewId: tab.viewId,
      workspaceId: this.workspaceId,
      taskId: this.taskId,
      pageId: tab.pageId,
    });
    this.installPopupHandling(tab);
    view.webContents.once("destroyed", () => this.forgetTab(pageId));
    this.window.contentView.addChildView(view);
    this.tabsById.set(pageId, tab);
    this.activateTab(pageId);

    try {
      await view.webContents.loadURL(url);
      return tab;
    } catch (error) {
      this.closeTab(pageId);
      throw error;
    }
  }

  activateTab(pageId: string): void {
    const tab = this.tabsById.get(pageId);
    if (!tab) throw new Error(`unknown page for task ${this.taskId}: ${pageId}`);
    this.activePageId = pageId;
    for (const candidate of this.tabsById.values()) {
      candidate.view.setVisible(candidate.pageId === pageId);
      if (candidate.pageId === pageId) {
        candidate.view.setBounds(this.bounds);
      }
    }
  }

  closeTab(pageId: string): boolean {
    const tab = this.tabsById.get(pageId);
    if (!tab) return false;

    this.forgetTab(pageId);
    if (!tab.view.webContents.isDestroyed()) {
      tab.view.webContents.close();
    }
    return true;
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;

    for (const popup of [...this.popupsById.values()]) {
      if (!popup.window.isDestroyed()) popup.window.destroy();
      this.forgetPopup(popup.webContentsId);
    }

    for (const pageId of [...this.tabsById.keys()]) {
      this.closeTab(pageId);
    }
  }

  private nextAutomaticPageId(): string {
    let pageId = `page-${this.nextPageNumber++}`;
    while (this.tabsById.has(pageId)) {
      pageId = `page-${this.nextPageNumber++}`;
    }
    return pageId;
  }

  private createWebPreferences(): WebPreferences {
    return {
      ...SAFE_TASK_WEB_PREFERENCES,
      partition: this.partition,
    };
  }

  private installPopupHandling(opener: TaskTab): void {
    opener.view.webContents.setWindowOpenHandler(() => ({
      action: "allow",
      overrideBrowserWindowOptions: {
        show: true,
        parent: this.window,
        webPreferences: this.createWebPreferences(),
      },
    }));

    opener.view.webContents.on("did-create-window", (popupWindow) => {
      const webContentsId = popupWindow.webContents.id;
      const pageId = `popup-${webContentsId}`;
      const popup: TaskPopup = {
        taskId: this.taskId,
        openerPageId: opener.pageId,
        pageId,
        viewId: `${this.taskId}:${pageId}`,
        webContentsId,
        window: popupWindow,
      };
      this.registry.registerTask({
        webContentsId,
        viewId: popup.viewId,
        workspaceId: this.workspaceId,
        taskId: this.taskId,
        pageId: popup.pageId,
      });
      this.popupsById.set(webContentsId, popup);
      popupWindow.once("closed", () => this.forgetPopup(webContentsId));
      popupWindow.webContents.once("destroyed", () =>
        this.forgetPopup(webContentsId),
      );
    });
  }

  private forgetTab(pageId: string): void {
    const tab = this.tabsById.get(pageId);
    if (!tab) return;

    try {
      this.window.contentView.removeChildView(tab.view);
    } catch {
      // The parent window may already be destroyed.
    }
    this.registry.unregister(tab.webContentsId);
    this.tabsById.delete(pageId);

    if (this.activePageId === pageId) {
      this.activePageId = undefined;
      const next = this.tabsById.keys().next();
      if (!next.done) this.activateTab(next.value);
    }
  }

  private forgetPopup(webContentsId: number): void {
    const popup = this.popupsById.get(webContentsId);
    if (!popup) return;
    this.registry.unregister(popup.webContentsId);
    this.popupsById.delete(webContentsId);
  }
}
