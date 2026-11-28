import { describe, expect, it } from 'vitest';
import { WHATSAPP_ABILITIES, whatsappStatusSchema } from '@src/shared/lib/protocol/companion';
import { ABILITY_WORDS, whatsappAbilitiesSection } from '../abilities';

const TODAY = [
  'send_text',
  'send_voice',
  'react',
  'edit',
  'delete',
  'presence',
  'read_voice',
  'read_photo',
  'read_document',
  'read_link',
] as const;

describe('WhatsApp abilities (#202)', () => {
  it('has words for every ability Ava Brain can report', () => {
    for (const id of WHATSAPP_ABILITIES) expect(ABILITY_WORDS[id]).toBeTruthy();
  });

  it('says a picture is not possible yet, and coming, while the driver cannot send one', () => {
    const section = whatsappAbilitiesSection([...TODAY]);
    const [can, notYet] = section.split('Not possible on WhatsApp yet:');
    expect(can).toContain('answer with a voice note');
    expect(can).not.toContain('send pictures');
    expect(notYet).toContain('send pictures');
    expect(notYet).toContain('message other people for the owner');
    expect(notYet).toContain('it is coming');
  });

  it('moves an ability to "can" as soon as the driver reports it', () => {
    const section = whatsappAbilitiesSection([...TODAY, 'send_image']);
    const [can, notYet] = section.split('Not possible on WhatsApp yet:');
    expect(can).toContain('send pictures');
    expect(notYet).not.toContain('send pictures');
  });

  it('keeps a send "not yet" while no tool here makes it, even when the driver can (#204)', () => {
    const section = whatsappAbilitiesSection([...TODAY, 'send_image', 'send_video', 'send_document']);
    const [can, notYet] = section.split('Not possible on WhatsApp yet:');
    expect(can).toContain('send_whatsapp_picture');
    expect(can).not.toContain('send files from this computer');
    expect(notYet).toContain('send files from this computer (being built)');
    expect(notYet).toContain('send short videos (being built)');
  });

  it('promises nothing WhatsApp-specific when Ava Brain did not say', () => {
    expect(whatsappAbilitiesSection(null)).toContain('Do not promise');
    expect(whatsappAbilitiesSection([])).toContain('Do not promise');
  });

  it('reads an older Ava Brain (no list) as none, and drops ids it does not know', () => {
    const base = {
      state: 'linked',
      qr: null,
      number: null,
      ownerNumber: null,
      message: null,
      queued: 0,
      sentLastHour: 0,
      sendLimitPerHour: 20,
    };
    expect(whatsappStatusSchema.parse(base).abilities).toEqual([]);
    expect(whatsappStatusSchema.parse({ ...base, abilities: ['send_text', 'teleport'] }).abilities).toEqual([
      'send_text',
    ]);
  });
});
