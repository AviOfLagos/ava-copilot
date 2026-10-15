// The reflection's job: daily before the morning brief, and soon after a long conversation (see VoiceManager.stop)
export const REFLECT_JOB = 'identity_reflect';
export const REFLECT_DAILY_KEY = 'identity:reflect:daily';
export const REFLECT_SOON_KEY = 'identity:reflect:soon';
// After the workspace summaries (07:30), before the brief's usual 08:00
export const REFLECT_DAILY_CRON = '45 7 * * *';
