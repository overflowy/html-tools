export interface Tool {
  /** Stable identifier: used for the URL hash, host class name, and last-used storage. */
  id: string;
  name: string;
  subtitle: string;
  /** Extra terms the sidebar filter matches besides the name. */
  keywords: string[];
  /** Called once, on first selection. Builds the tool's DOM inside `el`. */
  mount(el: HTMLElement): void;
}
