import { describe, expect, it } from 'vitest';
import { formatTree, type AXNode } from './snapshot';

const node = (nodeId: string, role: string, name: string, extra: Partial<AXNode> = {}): AXNode => ({
  nodeId,
  role: { value: role },
  name: { value: name },
  backendDOMNodeId: Number(nodeId) * 10,
  ...extra,
});

const tree: AXNode[] = [
  node('1', 'RootWebArea', 'Shop', { childIds: ['2', '3', '6', '8', '9', '11'] }),
  node('2', 'heading', 'Products', { parentId: '1', properties: [{ name: 'level', value: { value: 1 } }] }),
  node('3', 'button', 'Add to cart', { parentId: '1', childIds: ['4'], properties: [{ name: 'disabled', value: { value: true } }] }),
  node('4', 'StaticText', 'Add to cart', { parentId: '3', childIds: ['5'] }),
  node('5', 'InlineTextBox', 'Add to cart', { parentId: '4' }),
  node('6', 'generic', '', { parentId: '1', ignored: true, childIds: ['7'] }),
  node('7', 'textbox', 'Email', { parentId: '6', value: { value: 'a@b.co' }, properties: [{ name: 'required', value: { value: true } }, { name: 'focused', value: { value: false } }] }),
  node('8', 'checkbox', 'Terms', { parentId: '1', properties: [{ name: 'checked', value: { value: 'mixed' } }] }),
  node('9', 'generic', '', { parentId: '1', childIds: ['10'] }),
  node('10', 'StaticText', 'Download report', { parentId: '9' }),
  node('11', 'StaticText', '', { parentId: '1' }),
];

describe('formatTree', () => {
  it('lists interactive and text nodes with refs, skipping duplicate text and noise', () => {
    const refs = new Map<number, number>();
    expect(formatTree(tree, refs, 100)).toEqual([
      '[1] heading "Products" h1',
      '[2] button "Add to cart" disabled',
      '[3] textbox "Email" value="a@b.co" required',
      '[4] checkbox "Terms" checked=mixed',
      '[5] text "Download report"',
    ]);
    expect([...refs]).toEqual([[1, 20], [2, 30], [3, 70], [4, 80], [5, 100]]);
  });

  it('caps the number of lines and says how many were dropped', () => {
    const refs = new Map<number, number>();
    const lines = formatTree(tree, refs, 2);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatch(/^… 3 more elements/);
    expect(refs.size).toBe(2);
  });

  it('lists the root of a role-less contenteditable as a textbox', () => {
    const ed = { name: 'editable', value: { value: 'richtext' } };
    const nodes = [
      node('1', 'RootWebArea', '', { childIds: ['2'] }),
      node('2', 'generic', 'Notes', { parentId: '1', childIds: ['3'], properties: [ed] }),
      node('3', 'StaticText', 'hello', { parentId: '2', properties: [ed] }),
    ];
    expect(formatTree(nodes, new Map(), 10)).toEqual(['[1] textbox "Notes"']);
  });

  it('continues numbering across frames', () => {
    const refs = new Map<number, number>([[1, 999]]);
    expect(formatTree([node('1', 'link', 'Home')], refs, 10)).toEqual(['[2] link "Home"']);
  });
});
