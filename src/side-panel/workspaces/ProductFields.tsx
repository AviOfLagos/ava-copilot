import { useState } from 'react';
import type { ReactNode } from 'react';
import { t } from '@extension/i18n';
import { SOCIAL_PLATFORMS } from '@extension/storage';
import type { ProductNotify, ProductProfile, ProductStage, SocialPlatform } from '@extension/storage';

/**
 * The product a workspace sells, as fields in the workspace editor (docs/growth-team.md, Part 6). Every field
 * may be left empty: an empty one reads "Not set" here and to the agents, which then say they do not know it.
 */

const field =
  'glass w-full rounded-xl px-2.5 py-1.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/50';

const SOCIAL_LABELS: Record<SocialPlatform, string> = {
  x: 'X',
  linkedin: 'LinkedIn',
  youtube: 'YouTube',
  instagram: 'Instagram',
  reddit: 'Reddit',
};

const toLines = (text: string) => text.split('\n');
const fromLines = (values: string[]) => values.join('\n');

/** A number as typed, or null when the field is empty or does not hold one. */
export function numberFromText(text: string): number | null {
  const value = Number(text.trim());
  return text.trim() !== '' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** "#suture-notifications C0CKJC0CT4M": the name people say, then the id when it is known. One channel a row. */
export function channelsFromText(text: string): ProductProfile['slackChannels'] {
  return text
    .split('\n')
    .map(row => row.trim())
    .filter(Boolean)
    .map(row => {
      const [name = '', id = ''] = row.split(/\s+/);
      // A row that is only an id (C0…) has no name to show
      return /^[CGD][A-Z0-9]{6,}$/.test(name) && !id ? { name: '', id: name } : { name, id };
    });
}

export const channelsToText = (channels: ProductProfile['slackChannels']) =>
  channels.map(channel => [channel.name, channel.id].filter(Boolean).join(' ')).join('\n');

/** The names of the fields agents will read as "not set", for the line under the heading. */
export function missingFields(profile: ProductProfile): string[] {
  const missing: [boolean, string][] = [
    [!profile.audience.some(item => item.trim()), t('product_missing_audience')],
    [!profile.pricing.trim(), t('product_missing_pricing')],
    [!profile.email?.from.trim(), t('product_missing_email')],
    [!profile.postalAddress.trim(), t('product_missing_postal')],
    [
      !(profile.betaRule && profile.betaRule.testersPerWeek && profile.betaRule.days && profile.betaRule.plan.trim()),
      t('product_missing_betaRule'),
    ],
    [!Object.values(profile.social).some(account => account?.handle.trim()), t('product_missing_social')],
    [
      !(profile.northStar && profile.northStar.metric.trim() && profile.northStar.weeklyTarget),
      t('product_missing_northStar'),
    ],
    [!profile.notify, t('product_missing_notify')],
  ];
  return missing.filter(([empty]) => empty).map(([, label]) => label);
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[12px]">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function Group({ title, children, open = false }: { title: string; children: ReactNode; open?: boolean }) {
  return (
    <details open={open} className="border-border/60 rounded-xl border px-2.5 py-1.5">
      <summary className="cursor-pointer select-none py-1 text-[12.5px]">{title}</summary>
      <div className="flex flex-col gap-2 pb-1.5 pt-1">{children}</div>
    </details>
  );
}

// What is typed in the fields that are not plain text, kept as typed: turning "12." into 12 on every key would
// make "12.5" impossible to type, and trimming a row of channels would eat the space before its id
interface Typed {
  weeklyTarget: string;
  budget: string;
  betaTesters: string;
  betaDays: string;
  slack: string;
}

const shownNumber = (value: number | null | undefined) => (value ? String(value) : '');

export default function ProductFields({
  value,
  onChange,
}: {
  value: ProductProfile;
  onChange: (next: ProductProfile) => void;
}) {
  const notSet = t('product_notSet');
  const [typed, setTyped] = useState<Typed>(() => ({
    weeklyTarget: shownNumber(value.northStar?.weeklyTarget),
    budget: value.budget ? String(value.budget.totalUsd) : '',
    betaTesters: shownNumber(value.betaRule?.testersPerWeek),
    betaDays: shownNumber(value.betaRule?.days),
    slack: channelsToText(value.slackChannels),
  }));
  const set = (patch: Partial<ProductProfile>) => onChange({ ...value, ...patch });

  // A part with several fields keeps what is typed in each while the others are still empty (0 here means "not
  // typed yet"); what is still incomplete when it is saved is stored as "not set" (cleanProductProfile)
  const northStar = (patch: Partial<NonNullable<ProductProfile['northStar']>>) =>
    set({
      northStar: { metric: value.northStar?.metric ?? '', weeklyTarget: value.northStar?.weeklyTarget ?? 0, ...patch },
    });
  const betaRule = (patch: Partial<NonNullable<ProductProfile['betaRule']>>) =>
    set({
      betaRule: {
        testersPerWeek: value.betaRule?.testersPerWeek ?? 0,
        days: value.betaRule?.days ?? 0,
        plan: value.betaRule?.plan ?? '',
        ...patch,
      },
    });

  const text = (key: 'name' | 'url' | 'oneLiner' | 'problem' | 'pricing' | 'repo' | 'postalAddress', rows = 0) =>
    rows ? (
      <textarea
        rows={rows}
        value={value[key]}
        placeholder={notSet}
        onChange={event => set({ [key]: event.target.value })}
        className={field}
      />
    ) : (
      <input
        value={value[key]}
        placeholder={notSet}
        onChange={event => set({ [key]: event.target.value })}
        className={field}
      />
    );
  const list = (key: 'audience' | 'alternatives' | 'differentiators' | 'never') => (
    <textarea
      rows={3}
      value={fromLines(value[key])}
      placeholder={notSet}
      onChange={event => set({ [key]: toLines(event.target.value) })}
      className={field}
    />
  );
  const number = (key: keyof Omit<Typed, 'slack'>, onNumber: (next: number | null) => void) => (
    <input
      inputMode="decimal"
      value={typed[key]}
      placeholder={notSet}
      onChange={event => {
        setTyped({ ...typed, [key]: event.target.value });
        onNumber(numberFromText(event.target.value));
      }}
      className={field}
    />
  );
  const missing = missingFields(value);

  return (
    <fieldset className="flex flex-col gap-2" data-testid="product-fields">
      <legend className="text-muted-foreground mb-1 text-[12px]">{t('product_title')}</legend>
      <p className="text-muted-foreground text-[11.5px] leading-snug">{t('product_hint')}</p>
      {missing.length > 0 && (
        <p className="text-[11.5px] leading-snug" data-testid="product-missing">
          {t('product_missing', [missing.join(', ')])}
        </p>
      )}

      <Group title={t('product_group_facts')} open>
        <Row label={t('product_name')}>{text('name')}</Row>
        <Row label={t('product_url')}>{text('url')}</Row>
        <Row label={t('product_oneLiner')}>{text('oneLiner', 2)}</Row>
        <Row label={t('product_stage')}>
          <select
            value={value.stage ?? ''}
            onChange={event => set({ stage: (event.target.value || null) as ProductStage | null })}
            className={field}>
            <option value="">{notSet}</option>
            <option value="beta">{t('product_stage_beta')}</option>
            <option value="live">{t('product_stage_live')}</option>
          </select>
        </Row>
        <Row label={t('product_audience')}>{list('audience')}</Row>
        <Row label={t('product_problem')}>{text('problem', 2)}</Row>
        <Row label={t('product_alternatives')}>{list('alternatives')}</Row>
        <Row label={t('product_differentiators')}>{list('differentiators')}</Row>
        <Row label={t('product_pricing')}>{text('pricing', 2)}</Row>
        <Row label={t('product_never')}>{list('never')}</Row>
      </Group>

      <Group title={t('product_group_places')}>
        <Row label={t('product_repo')}>{text('repo')}</Row>
        <Row label={t('product_admin')}>
          <input
            value={value.superAdmin?.url ?? ''}
            placeholder={notSet}
            onChange={event =>
              set({ superAdmin: { url: event.target.value, account: value.superAdmin?.account ?? '' } })
            }
            className={field}
          />
        </Row>
        <Row label={t('product_adminAccount')}>
          <input
            value={value.superAdmin?.account ?? ''}
            placeholder={notSet}
            onChange={event => set({ superAdmin: { url: value.superAdmin?.url ?? '', account: event.target.value } })}
            className={field}
          />
        </Row>
        <Row label={t('product_api')}>
          <input
            value={value.agentApi?.baseUrl ?? ''}
            placeholder={notSet}
            onChange={event =>
              set({
                agentApi: event.target.value.trim() ? { kind: 'suture-agent-v1', baseUrl: event.target.value } : null,
              })
            }
            className={field}
          />
        </Row>
        <Row label={t('product_slack')}>
          <textarea
            rows={2}
            value={typed.slack}
            placeholder={notSet}
            onChange={event => {
              setTyped({ ...typed, slack: event.target.value });
              set({ slackChannels: channelsFromText(event.target.value) });
            }}
            className={field}
          />
        </Row>
        {SOCIAL_PLATFORMS.map(platform => (
          <Row key={platform} label={SOCIAL_LABELS[platform]}>
            <input
              value={value.social[platform]?.handle ?? ''}
              placeholder={notSet}
              onChange={event =>
                set({
                  social: {
                    ...value.social,
                    [platform]: { handle: event.target.value, account: value.social[platform]?.account ?? '' },
                  },
                })
              }
              className={field}
            />
          </Row>
        ))}
      </Group>

      <Group title={t('product_group_outreach')}>
        <Row label={t('product_emailFrom')}>
          <input
            type="email"
            value={value.email?.from ?? ''}
            placeholder={notSet}
            onChange={event =>
              set({ email: { from: event.target.value, replyTo: value.email?.replyTo ?? '', via: 'nexmail' } })
            }
            className={field}
          />
        </Row>
        <Row label={t('product_replyTo')}>
          <input
            type="email"
            value={value.email?.replyTo ?? ''}
            placeholder={notSet}
            onChange={event =>
              set({ email: { from: value.email?.from ?? '', replyTo: event.target.value, via: 'nexmail' } })
            }
            className={field}
          />
        </Row>
        <Row label={t('product_postal')}>{text('postalAddress', 2)}</Row>
        <Row label={t('product_notify')}>
          <select
            value={value.notify ?? ''}
            onChange={event => set({ notify: (event.target.value || null) as ProductNotify | null })}
            className={field}>
            <option value="">{notSet}</option>
            <option value="whatsapp">{t('product_notify_whatsapp')}</option>
            <option value="slack">{t('product_notify_slack')}</option>
            <option value="both">{t('product_notify_both')}</option>
          </select>
        </Row>
      </Group>

      <Group title={t('product_group_limits')}>
        <Row label={t('product_northStar')}>
          <input
            value={value.northStar?.metric ?? ''}
            placeholder={notSet}
            onChange={event => northStar({ metric: event.target.value })}
            className={field}
          />
        </Row>
        <Row label={t('product_weeklyTarget')}>
          {number('weeklyTarget', next => northStar({ weeklyTarget: next ?? 0 }))}
        </Row>
        <Row label={t('product_budget')}>
          {number('budget', next =>
            set({ budget: next === null ? null : { totalUsd: next, spentUsd: value.budget?.spentUsd ?? 0 } }),
          )}
        </Row>
        <Row label={t('product_betaTesters')}>
          {number('betaTesters', next => betaRule({ testersPerWeek: next ?? 0 }))}
        </Row>
        <Row label={t('product_betaPlan')}>
          <input
            value={value.betaRule?.plan ?? ''}
            placeholder={notSet}
            onChange={event => betaRule({ plan: event.target.value })}
            className={field}
          />
        </Row>
        <Row label={t('product_betaDays')}>{number('betaDays', next => betaRule({ days: next ?? 0 }))}</Row>
      </Group>
    </fieldset>
  );
}
