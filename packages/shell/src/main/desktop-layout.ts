import type { Rectangle } from "electron";

export interface LayoutView {
  setBounds(bounds: Rectangle): void;
  setVisible(visible: boolean): void;
}

export interface LayoutBrowser {
  readonly activeTab: { readonly view: LayoutView } | undefined;
  setBounds(bounds: Rectangle): void;
  setVisible(visible: boolean): void;
}

export function splitTaskBounds(width: number, height: number): Rectangle {
  const shellWidth = Math.min(380, Math.max(280, Math.floor(width * 0.36)));
  return { x: shellWidth, y: 0, width: Math.max(1, width - shellWidth), height };
}

/** Production view selection is driven only by main-owned committed task tabs. */
export class DesktopLayout {
  private readonly browsers: LayoutBrowser[] = [];
  private selected: LayoutBrowser | undefined;

  constructor(
    private readonly contentBounds: () => { width: number; height: number },
    private readonly shell: LayoutView,
    private readonly fixture: LayoutView,
  ) {
    this.fixture.setVisible(false);
    this.resize();
  }

  get activeBrowser(): LayoutBrowser | undefined { return this.selected; }

  addBrowser(browser: LayoutBrowser): void {
    browser.setVisible(false);
    this.browsers.push(browser);
  }

  browserChanged(browser: LayoutBrowser): void {
    if (!this.browsers.includes(browser)) throw new Error("unknown task browser");
    const index = this.browsers.indexOf(browser);
    this.browsers.splice(index, 1);
    if (browser.activeTab) this.browsers.push(browser);
    else this.browsers.unshift(browser);
    this.selected = [...this.browsers].reverse().find((candidate) => candidate.activeTab !== undefined);
    this.resize();
  }

  resize(): void {
    const { width, height } = this.contentBounds();
    const task = splitTaskBounds(width, height);
    this.shell.setBounds({ x: 0, y: 0, width: this.selected ? task.x : width, height });
    this.shell.setVisible(true);
    this.fixture.setVisible(false);
    for (const browser of this.browsers) {
      browser.setBounds(task);
      browser.setVisible(browser === this.selected);
    }
  }
}
