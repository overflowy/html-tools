/** Handle the Shell gives a Tool for participating in Deep Links. */
export interface ToolContext {
  /** Store the Tool's encoded State in the Deep Link. Pass "" to clear it. */
  setState(payload: string): void;
  /** Register the handler that restores the Tool from a Deep Link payload. */
  onRestore(fn: (payload: string) => void): void;
  /** The Sidebar's Collapsed state, for a Tool that hides the Shell's header and its reveal button. */
  sidebar: {
    readonly collapsed: boolean;
    setCollapsed(next: boolean): void;
    onChange(fn: (collapsed: boolean) => void): void;
  };
}

export interface Tool {
  /** Stable identifier: used for the URL hash, host class name, and last-used storage. */
  id: string;
  name: string;
  subtitle: string;
  /** Extra terms the sidebar filter matches besides the name. */
  keywords: string[];
  /** Hides the Shell's title and subtitle above the Tool, for one that wants the whole height. */
  fullHeight?: boolean;
  /** Called once, on first selection. Builds the tool's DOM inside `el`. */
  mount(el: HTMLElement, ctx: ToolContext): void;
}
