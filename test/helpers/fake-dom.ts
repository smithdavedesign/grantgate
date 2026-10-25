// A small DOM fake for testing extension pages in Node. Elements keep their
// children and whatever properties the page sets; events call the listeners and
// wait for any promise they return, so a test can await a click or a submit end
// to end. Setting innerHTML throws: pages must build text with textContent.

import assert from 'node:assert/strict';

export interface FakeFile {
  name: string;
  size: number;
  text(): Promise<string>;
}

export interface FakeEvent {
  type: string;
  target: FakeElement;
  defaultPrevented: boolean;
  preventDefault(): void;
}

type Listener = (event: FakeEvent) => unknown;

export class FakeElement {
  readonly tagName: string;
  children: (FakeElement | string)[] = [];
  className = '';
  type = '';
  name = '';
  value = '';
  disabled = false;
  href = '';
  target = '';
  rel = '';
  files: FakeFile[] | null = null;
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  private listeners = new Map<string, Listener[]>();

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  get textContent(): string {
    return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
  set textContent(value: string) {
    this.children = [String(value)];
  }
  set innerHTML(_value: string) {
    throw new Error('pages must not render HTML');
  }
  insertAdjacentHTML(): never {
    throw new Error('pages must not render HTML');
  }
  append(...nodes: (FakeElement | string)[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: (FakeElement | string)[]) {
    this.children = [...nodes];
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = String(value);
  }
  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  /** Fires `type` and waits for every listener, including the promises they return. */
  async dispatch(type: string): Promise<FakeEvent> {
    const event: FakeEvent = {
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() {
        event.defaultPrevented = true;
      },
    };
    await Promise.all((this.listeners.get(type) ?? []).map((listener) => listener(event)));
    return event;
  }
  async click(): Promise<void> {
    if (!this.disabled) await this.dispatch('click');
  }
  querySelectorAll(selector: string): FakeElement[] {
    assert.match(selector, /^[a-z]+$/, 'the fake only supports tag selectors');
    return all(this, (el) => el.tagName === selector.toUpperCase());
  }
}

export const fakeDocument = { createElement: (tag: string) => new FakeElement(tag) };

export function all(root: FakeElement, test: (el: FakeElement) => boolean): FakeElement[] {
  const found: FakeElement[] = [];
  for (const child of root.children) {
    if (typeof child === 'string') continue;
    if (test(child)) found.push(child);
    found.push(...all(child, test));
  }
  return found;
}

/** The one element matching `test`; fails the test when there are none or several. */
export function only(root: FakeElement, test: (el: FakeElement) => boolean, what: string): FakeElement {
  const matches = all(root, test);
  assert.equal(matches.length, 1, `expected one ${what}, found ${matches.length}`);
  return matches[0];
}

export const byAction = (root: FakeElement, action: string) => only(root, (el) => el.dataset.action === action, `[data-action=${action}]`);
export const byName = (root: FakeElement, name: string) => only(root, (el) => el.name === name, `[name=${name}]`);
export const hasAction = (root: FakeElement, action: string) => all(root, (el) => el.dataset.action === action).length > 0;
export const tags = (root: FakeElement, tag: string) => all(root, (el) => el.tagName === tag.toUpperCase());

export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
