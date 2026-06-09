/**
 * trigger node — the starting point of every workflow.
 */

export const triggerNodeType = {
  type: 'trigger',
  label: 'Trigger',
  description: 'Starts the workflow. Use "Daily at X AM" for scheduled runs, or Manual for on-demand.',
  icon: 'play_circle',
  family: 'trigger',
  configSchema: [
    { key: 'time', label: 'Daily time (HH:MM)', type: 'text', optional: true,
      hint: '24-hour. Leave blank for manual-only triggers.' },
    { key: 'cron', label: 'Cron schedule', type: 'text', optional: true, advanced: true,
      hint: 'e.g. "0 6 * * *" for daily 6 AM. Use this only if you need something other than a simple daily schedule.' },
  ],
  previewTemplate: '{time?Runs every day at {time}.|cron?Runs on schedule "{cron}".|Runs only when triggered manually.}',
  run: async (_cfg, _ctx, _services) => {
    return { trigger: true, at: new Date().toISOString() };
  },
};
