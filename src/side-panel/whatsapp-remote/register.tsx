// Registers Settings › Connections › WhatsApp (Ava messages you); see ../registry.ts
import { registerSettingsSection } from '../registry';
import WhatsAppSettings from './WhatsAppSettings';

registerSettingsSection({
  id: 'whatsapp-remote',
  label: 'wava_settings_title',
  page: 'connections',
  order: 31,
  keywords: ['whatsapp', 'phone', 'message', 'qr', 'linked devices', 'notify'],
  Component: WhatsAppSettings,
});
