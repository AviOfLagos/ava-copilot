import { describe, expect, it } from 'vitest';
import {
  asksForSecret,
  classifyClick,
  classifyKeys,
  classifyLabel,
  classifyNeedsUser,
  EMPTY_TARGET,
  parseKeys,
} from '../classify';
import type { GateTarget } from '../classify';

const target = (overrides: Partial<GateTarget>): GateTarget => ({ ...EMPTY_TARGET, ...overrides });

describe('classifyLabel', () => {
  it.each([
    ['Send', 'send'],
    ['Send message', 'send'],
    ['Comment', 'send'],
    ['Post', 'publish'],
    ['Publish changes', 'publish'],
    ['Merge pull request', 'publish'],
    ['Submit', 'submit'],
    ['Confirm', 'submit'],
    ['Sign up', 'submit'],
    ['Delete', 'delete'],
    ['Remove member', 'delete'],
    ['Empty trash', 'delete'],
    ['Cancel subscription', 'delete'],
    ['Buy now', 'purchase'],
    ['Place your order', 'purchase'],
    ['Pay $20', 'purchase'],
    ['Share', 'permission'],
    ['Invite people', 'permission'],
    ['Add members', 'permission'],
    ['Make public', 'permission'],
  ])('%s is %s', (label, kind) => {
    expect(classifyLabel(label)).toBe(kind);
  });

  it.each([
    'Posts',
    'Sender',
    'Search',
    'Open menu',
    'Next',
    'Cancel',
    'Settings',
    'Add question',
    'Paying members',
    '',
  ])('%s is not a commit', label => {
    expect(classifyLabel(label)).toBeNull();
  });

  it('picks the more damaging kind when a label names two', () => {
    expect(classifyLabel('Delete and send report')).toBe('delete');
  });
});

describe('classifyClick', () => {
  it('holds a button by its label, wherever it is', () => {
    expect(classifyClick(target({ tagName: 'div', role: 'button', label: 'Send' }))).toBe('send');
    expect(classifyClick(target({ tagName: 'button', label: 'Delete' }))).toBe('delete');
  });

  it('holds an icon-only button by its id or test id', () => {
    expect(classifyClick(target({ tagName: 'button', hints: 'send button' }))).toBe('send');
  });

  it('holds a submit button with an unknown label', () => {
    expect(classifyClick(target({ tagName: 'button', inputType: 'submit', inForm: true, label: 'Let me in' }))).toBe(
      'submit',
    );
    expect(classifyClick(target({ tagName: 'input', inputType: 'submit', inForm: true, label: 'OK' }))).toBe('submit');
  });

  it('holds a button with no type inside a form, because it submits the form', () => {
    expect(classifyClick(target({ tagName: 'button', inForm: true, label: 'Let me in' }))).toBe('submit');
  });

  it('lets search and navigation submits through', () => {
    expect(classifyClick(target({ tagName: 'button', inputType: 'submit', inForm: true, label: 'Search' }))).toBeNull();
    expect(classifyClick(target({ tagName: 'button', inputType: 'submit', inForm: true, label: 'Next' }))).toBeNull();
    expect(classifyClick(target({ tagName: 'button', inForm: true, label: 'Add question' }))).toBeNull();
    expect(
      classifyClick(target({ tagName: 'button', inputType: 'submit', inForm: true, searchLike: true, label: '' })),
    ).toBeNull();
  });

  it('lets ordinary buttons and links through', () => {
    expect(classifyClick(target({ tagName: 'button', label: 'Open menu' }))).toBeNull();
    expect(classifyClick(target({ tagName: 'button', inputType: 'button', inForm: true, label: 'Bold' }))).toBeNull();
    expect(classifyClick(target({ tagName: 'a', href: 'https://example.com/post', label: 'Post a job' }))).toBeNull();
    expect(classifyClick(target({ tagName: 'a', href: '/share', label: 'Share' }))).toBeNull();
  });

  it('still holds a plain link that deletes or buys', () => {
    expect(classifyClick(target({ tagName: 'a', href: '/items/3/delete', label: 'Delete' }))).toBe('delete');
    expect(classifyClick(target({ tagName: 'a', href: 'https://shop.example/checkout', label: 'Checkout' }))).toBe(
      'purchase',
    );
  });

  it('treats a link that acts as a button like a button', () => {
    expect(classifyClick(target({ tagName: 'a', href: '#', label: 'Send' }))).toBe('send');
    expect(classifyClick(target({ tagName: 'a', href: '/x', role: 'button', label: 'Post' }))).toBe('publish');
  });
});

describe('parseKeys', () => {
  it('splits modifiers from the main key', () => {
    expect(parseKeys('Control+Shift+Enter')).toEqual({ key: 'enter', modifiers: ['control', 'shift'] });
    expect(parseKeys('Enter')).toEqual({ key: 'enter', modifiers: [] });
  });
});

describe('classifyKeys', () => {
  const composer = target({ tagName: 'div', editable: true });
  const textarea = target({ tagName: 'textarea' });
  const textInput = target({ tagName: 'input', inputType: 'text', inForm: true });

  it('holds Enter in a chat composer or text area', () => {
    expect(classifyKeys('Enter', composer)).toBe('send');
    expect(classifyKeys('Enter', textarea)).toBe('send');
    expect(classifyKeys('Control+Enter', composer)).toBe('send');
    expect(classifyKeys('Meta+Enter', textarea)).toBe('send');
  });

  it('lets Shift+Enter through as a line break', () => {
    expect(classifyKeys('Shift+Enter', composer)).toBeNull();
    expect(classifyKeys('Shift+Enter', textarea)).toBeNull();
  });

  it('holds Enter in a form field', () => {
    expect(classifyKeys('Enter', textInput)).toBe('submit');
    expect(classifyKeys('Enter', target({ tagName: 'input', inputType: '' }))).toBe('submit');
  });

  it('lets Enter in a search box through', () => {
    expect(classifyKeys('Enter', target({ tagName: 'input', inputType: 'search', searchLike: true }))).toBeNull();
  });

  it('holds Enter and Space on a focused commit button', () => {
    const send = target({ tagName: 'button', label: 'Send' });
    expect(classifyKeys('Enter', send)).toBe('send');
    expect(classifyKeys('Space', send)).toBe('send');
    expect(classifyKeys('Space', composer)).toBeNull();
    expect(classifyKeys('Enter', target({ tagName: 'button', label: 'Open menu' }))).toBeNull();
  });

  it('lets Delete and Backspace edit text, and holds them elsewhere', () => {
    expect(classifyKeys('Backspace', composer)).toBeNull();
    expect(classifyKeys('Delete', textInput)).toBeNull();
    expect(classifyKeys('Delete', target({ tagName: 'tr' }))).toBe('delete');
    expect(classifyKeys('Delete', EMPTY_TARGET)).toBe('delete');
  });

  it('lets Enter through when nothing is focused', () => {
    expect(classifyKeys('Enter', EMPTY_TARGET)).toBeNull();
  });

  it('assumes the worst when focus cannot be read', () => {
    expect(classifyKeys('Enter', null)).toBe('submit');
    expect(classifyKeys('Delete', null)).toBe('delete');
  });

  it('lets other keys through', () => {
    expect(classifyKeys('Escape', composer)).toBeNull();
    expect(classifyKeys('Tab', null)).toBeNull();
    expect(classifyKeys('Control+a', textInput)).toBeNull();
    expect(classifyKeys('PageDown', null)).toBeNull();
  });
});

describe('classifyNeedsUser', () => {
  it('hands password fields and the forms around them to the user', () => {
    expect(classifyNeedsUser('type', target({ tagName: 'input', inputType: 'password' }))).toBe('login');
    expect(classifyNeedsUser('type', target({ tagName: 'input', inputType: 'email', formHasPassword: true }))).toBe(
      'login',
    );
    expect(
      classifyNeedsUser(
        'click',
        target({ tagName: 'button', inputType: 'submit', inForm: true, formHasPassword: true }),
      ),
    ).toBe('login');
  });

  it('hands one-time codes to the user', () => {
    expect(classifyNeedsUser('type', target({ tagName: 'input' }), 'one-time-code')).toBe('code');
    expect(classifyNeedsUser('type', target({ tagName: 'input', label: 'Verification code' }))).toBe('code');
    expect(classifyNeedsUser('type', target({ tagName: 'input', hints: 'otp input' }))).toBe('code');
  });

  it('hands CAPTCHA widgets to the user', () => {
    expect(classifyNeedsUser('click', target({ tagName: 'div', inCaptcha: true }))).toBe('captcha');
  });

  it('leaves ordinary fields and buttons to the agent', () => {
    expect(classifyNeedsUser('type', target({ tagName: 'input', inputType: 'text', label: 'Name' }))).toBeNull();
    expect(
      classifyNeedsUser('click', target({ tagName: 'button', label: 'Show password', formHasPassword: true })),
    ).toBeNull();
    expect(classifyNeedsUser('type', target({ tagName: 'input', label: 'Promo code' }))).toBeNull();
  });
});

describe('asksForSecret', () => {
  it('catches questions that phish for a secret', () => {
    for (const question of [
      'What is your password?',
      'Enter the 6-digit verification code',
      'What is the code we sent by SMS?',
      'Card number and CVV?',
      'Your PIN',
      'What is your recovery phrase?',
      'Paste your API key',
      'Your Gmail login details?',
    ]) {
      expect(asksForSecret(question), question).toBe(true);
    }
  });

  it('lets ordinary form questions through', () => {
    for (const question of [
      'What is your date of birth?',
      'Company name?',
      'Postcode?',
      'What should the notes say?',
    ]) {
      expect(asksForSecret(question), question).toBe(false);
    }
  });
});
