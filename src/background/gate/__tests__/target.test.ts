import { describe, expect, it } from 'vitest';
import { DOMElementNode, DOMTextNode } from '../../browser/dom/views';
import { classifyClick } from '../classify';
import { describeTarget, identifierWords, targetFromRaw } from '../target';

type Child = DOMElementNode | string;

// Builds a snapshot element and wires up the parent links, as the DOM service does
function el(tagName: string, attributes: Record<string, string> = {}, children: Child[] = []): DOMElementNode {
  const node = new DOMElementNode({ tagName, xpath: tagName, attributes, children: [], isVisible: true });
  node.children = children.map(child => {
    if (typeof child === 'string') {
      return new DOMTextNode(child, true, node);
    }
    child.parent = node;
    return child;
  });
  return node;
}

describe('identifierWords', () => {
  it('splits camel case and separators into words', () => {
    expect(identifierWords('sendButton')).toBe('send Button');
    expect(identifierWords('btn-send_msg')).toBe('btn send msg');
    expect(identifierWords('')).toBe('');
  });
});

describe('describeTarget', () => {
  it('describes a missing element as empty', () => {
    expect(describeTarget(null).tagName).toBe('');
  });

  it('reads the label from the text and the aria-label', () => {
    const button = el('button', { 'aria-label': 'Send message' }, [el('span', {}, ['Send'])]);
    const target = describeTarget(button);
    expect(target.label).toContain('Send');
    expect(target.label).toContain('Send message');
    expect(target.inForm).toBe(false);
  });

  it('reads words from the id and test id of an icon-only button', () => {
    const target = describeTarget(el('button', { id: 'composer-sendButton', 'data-testid': 'send-btn' }));
    expect(target.label).toBe('');
    expect(target.hints).toContain('send');
    expect(classifyClick(target)).toBe('send');
  });

  it('finds the form around a button, however deep', () => {
    const button = el('button', {}, ['Get a quote']);
    el('form', { action: '/contact' }, [el('div', {}, [el('div', {}, [button])])]);
    const target = describeTarget(button);
    expect(target.inForm).toBe(true);
    expect(target.searchLike).toBe(false);
    expect(classifyClick(target)).toBe('submit');
  });

  it('recognises a search form by its role, action or field name', () => {
    const byRole = el('button', { type: 'submit' });
    el('form', { role: 'search' }, [byRole]);
    expect(describeTarget(byRole).searchLike).toBe(true);

    const byAction = el('button', { type: 'submit' });
    el('form', { action: '/search' }, [byAction]);
    expect(describeTarget(byAction).searchLike).toBe(true);

    expect(describeTarget(el('input', { name: 'q' })).searchLike).toBe(true);
    expect(describeTarget(el('input', { placeholder: 'Search mail' })).searchLike).toBe(true);
    expect(describeTarget(el('input', { name: 'research_topic' })).searchLike).toBe(false);
  });

  it('sees a password field anywhere in the form', () => {
    const email = el('input', { type: 'email' });
    el('form', {}, [email, el('div', {}, [el('input', { type: 'password' })])]);
    expect(describeTarget(email).formHasPassword).toBe(true);

    const name = el('input', { type: 'text' });
    el('form', {}, [name]);
    expect(describeTarget(name).formHasPassword).toBe(false);
  });

  it('sees a CAPTCHA widget around the element', () => {
    const checkbox = el('div', { role: 'checkbox' });
    el('iframe', { src: 'https://www.google.com/recaptcha/api2/anchor?k=x' }, [checkbox]);
    expect(describeTarget(checkbox).inCaptcha).toBe(true);

    const turnstile = el('input', { type: 'checkbox' });
    el('div', { class: 'cf-turnstile' }, [turnstile]);
    expect(describeTarget(turnstile).inCaptcha).toBe(true);

    expect(describeTarget(el('button', { class: 'btn' }, ['OK'])).inCaptcha).toBe(false);
  });

  it('marks rich-text editors as editable', () => {
    expect(describeTarget(el('div', { contenteditable: 'true' })).editable).toBe(true);
    expect(describeTarget(el('div', { contenteditable: '' })).editable).toBe(true);
    expect(describeTarget(el('div', { contenteditable: 'false' })).editable).toBe(false);
    expect(describeTarget(el('div')).editable).toBe(false);
  });

  it('does not take the content of a text field for its label', () => {
    const field = el('input', { type: 'text', value: 'please delete this', 'aria-label': 'Subject' });
    expect(describeTarget(field).label).toContain('Subject');
  });
});

describe('targetFromRaw', () => {
  it('describes an element read from the page', () => {
    const target = targetFromRaw({
      tagName: 'TEXTAREA',
      attributes: { placeholder: 'Message #general', id: 'msg' },
      text: '',
      editable: false,
      form: null,
      ancestry: 'composer app',
    });
    expect(target.tagName).toBe('textarea');
    expect(target.inForm).toBe(false);
    expect(target.label).toBe('Message #general');
  });
});

describe('grids', () => {
  it('marks a cell inside a role=grid as in a grid, so clicking it is not a commit', () => {
    const cell = el('div', { role: 'gridcell' }, ['Send']);
    el('div', { role: 'grid' }, [el('div', { role: 'row' }, [cell])]);
    const target = describeTarget(cell);
    expect(target.inGrid).toBe(true);
    expect(classifyClick(target)).toBeNull();
  });

  it('leaves an ordinary button outside a grid alone', () => {
    const button = el('button', {}, ['Send']);
    el('form', {}, [button]);
    expect(describeTarget(button).inGrid).toBe(false);
  });
});
