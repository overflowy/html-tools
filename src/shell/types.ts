/** Handle the Shell gives a Tool for participating in Deep Links. */
export interface ToolContext {
  /** Store the Tool's encoded State in the Deep Link. Pass "" to clear it. */
  setState(payload: string): void;
  /** Register the handler that restores the Tool from a Deep Link payload. */
  onRestore(fn: (payload: string) => void): void;
}

export interface Tool {
  /** Stable identifier: used for the URL hash, host class name, and last-used storage. */
  id: string;
  name: string;
  subtitle: string;
  /** Extra terms the sidebar filter matches besides the name. */
  keywords: string[];
  /** Called once, on first selection. Builds the tool's DOM inside `el`. */
  mount(el: HTMLElement, ctx: ToolContext): void;
}
