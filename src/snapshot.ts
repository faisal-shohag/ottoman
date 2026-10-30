// Turns Chrome's accessibility tree into a compact text view with numbered refs the model can act on.
import type { Browser } from './cdp';

export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: unknown };
  properties?: { name: string; value: { value?: unknown } }[];
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'checkbox', 'radio', 'switch',
  'slider', 'spinbutton', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'textField',
  'PopUpButton', 'ColorWell', 'DisclosureTriangle', 'Date', 'DateTime', 'InputTime',
]);
// Named regions are landmarks like "Messages panel" that the model can scroll inside.
const CONTEXT = new Set(['heading', 'StaticText', 'image', 'dialog', 'alertdialog', 'alert', 'status', 'Iframe', 'img', 'region']);
// Menus and dialogs usually mount at the end of <body>; on long pages they would fall past the line cap.
const LAYERS = new Set(['menu', 'listbox', 'dialog', 'alertdialog']);
const LAYER_LINES = 100;
const FLAGS = ['checked', 'selected', 'expanded', 'disabled', 'required', 'invalid', 'focused', 'readonly', 'multiselectable'];

const clip = (s: string, n = 100) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/**
 * Formats AX nodes as lines like `[3] button "Send" disabled`. Text under an interactive node is skipped
 * because the node's name already carries it. Every line gets a ref, so plain text (e.g. a clickable div)
 * can be clicked too. Open menus and dialogs are listed first and do not count against `maxLines`.
 */
export function formatTree(nodes: AXNode[], refs: Map<number, number>, maxLines: number): string[] {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => !n.parentId) ?? nodes[0];
  const lines: string[] = [];
  let dropped = 0;
  let limit = maxLines;
  const seen = new Set<string>(); // listed in the layer pass
  let layerPass = false;

  const editable = (n?: AXNode) => !!n?.properties?.some((p) => p.name === 'editable' && p.value?.value);

  const visit = (n: AXNode, insideInteractive: boolean) => {
    if (seen.has(n.nodeId)) return;
    if (layerPass) seen.add(n.nodeId);
    // A contenteditable without a role shows up as generic; list its root as a textbox.
    const editableRoot = editable(n) && !editable(byId.get(n.parentId ?? ''));
    const role = editableRoot && !INTERACTIVE.has(String(n.role?.value)) ? 'textbox' : String(n.role?.value ?? '');
    const name = String(n.name?.value ?? '').trim();
    const interactive = !n.ignored && INTERACTIVE.has(role);
    const show =
      !n.ignored &&
      n.backendDOMNodeId !== undefined &&
      (interactive || (CONTEXT.has(role) && !!name && !(insideInteractive && role === 'StaticText')));

    if (show) {
      if (lines.length >= limit) dropped++;
      else {
        const ref = refs.size + 1;
        refs.set(ref, n.backendDOMNodeId!);
        let line = role === 'StaticText' ? `[${ref}] text "${clip(name, 160)}"` : `[${ref}] ${role}${name ? ` "${clip(name)}"` : ''}`;
        const value = n.value?.value;
        if (value !== undefined && value !== '' && String(value) !== name) line += ` value="${clip(String(value))}"`;
        for (const p of n.properties ?? []) {
          const v = p.value?.value;
          if (p.name === 'level' && role === 'heading') line += ` h${v}`;
          else if (FLAGS.includes(p.name) && v && v !== 'false') line += v === 'mixed' ? ` ${p.name}=mixed` : ` ${p.name}`;
        }
        lines.push(line);
      }
    }
    for (const id of n.childIds ?? []) {
      const child = byId.get(id);
      if (child) visit(child, insideInteractive || interactive);
    }
  };
  const layers = nodes.filter((n) => !n.ignored && LAYERS.has(String(n.role?.value)) && (n.childIds?.length ?? 0) > 0);
  if (layers.length) {
    layerPass = true;
    lines.push('Open menu/dialog:');
    for (const l of layers) {
      limit = lines.length + LAYER_LINES;
      visit(l, false);
    }
    if (lines.length === 1) lines.pop(); // only empty layers
    layerPass = false;
    dropped = 0;
    if (lines.length) lines.push('Page:');
  }
  limit = lines.length + maxLines;
  if (root) visit(root, false);
  if (dropped) lines.push(`… ${dropped} more elements not shown. Scroll, or use read_page for text.`);
  return lines;
}

interface FrameTree {
  frame: { id: string; url: string; name?: string };
  childFrames?: FrameTree[];
}

/** Snapshot of the active tab, including same-process iframes. Shadow DOM is already part of the AX tree. */
export async function snapshot(browser: Browser, maxLines = 400) {
  const refs = new Map<number, number>();
  const { frameTree } = await browser.send<{ frameTree: FrameTree }>('Page.getFrameTree');
  const { result } = await browser.send('Runtime.evaluate', { expression: 'JSON.stringify([document.title, location.href, scrollY, document.documentElement.scrollHeight, innerHeight])', returnByValue: true });
  const [title, url, scrollY, height, viewport] = JSON.parse(result.value);

  const { nodes } = await browser.send<{ nodes: AXNode[] }>('Accessibility.getFullAXTree');
  const lines = [`Page: "${title}" ${url}`, `Scroll: ${Math.round(scrollY)} of ${Math.max(0, height - viewport)}px`];
  lines.push(...formatTree(nodes, refs, maxLines));

  // shortcut: cross-origin (out-of-process) iframes are skipped; they need their own target session.
  const frames: FrameTree[] = [...(frameTree.childFrames ?? [])];
  while (frames.length) {
    const f = frames.shift()!;
    frames.push(...(f.childFrames ?? []));
    try {
      const sub = await browser.send<{ nodes: AXNode[] }>('Accessibility.getFullAXTree', { frameId: f.frame.id });
      const subLines = formatTree(sub.nodes, refs, Math.max(20, maxLines - lines.length));
      if (subLines.length) lines.push(`--- inside iframe ${f.frame.name || f.frame.url} ---`, ...subLines, '--- end iframe ---');
    } catch {
      // Frame is out of process or already gone.
    }
  }
  if (browser.dialog) lines.push(`!! A ${browser.dialog.type} dialog is open: "${browser.dialog.message}". Use handle_dialog.`);
  return { text: lines.join('\n'), refs };
}
