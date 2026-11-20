import { useEffect, useState } from 'react';
import { ChevronRight, Package, Plus, Star, Trash2 } from 'lucide-react';
import { t } from '@extension/i18n';
import {
  ACCOUNT_PLATFORMS,
  emptyProductProfile,
  isEmptyProfile,
  productStore,
  workspaceId,
  workspaceStore,
} from '@extension/storage';
import type { AccountPlatform, ProductProfile, Workspace } from '@extension/storage';
import { cn } from '@extension/ui';
import { Button } from '../components/ui/button';
import ProductFields from './ProductFields';
import { useDefaultWorkspaceId, useWorkspaces } from './WorkspacePicker';

const PLATFORM_LABELS: Record<AccountPlatform, { label: string; placeholder: string }> = {
  google: { label: 'Google', placeholder: 'you@company.com' },
  x: { label: 'X', placeholder: '@handle' },
  linkedin: { label: 'LinkedIn', placeholder: 'Your name, or the company page' },
  youtube: { label: 'YouTube', placeholder: 'Channel name' },
  instagram: { label: 'Instagram', placeholder: '@handle' },
  slack: { label: 'Slack', placeholder: 'workspace.slack.com' },
  github: { label: 'GitHub', placeholder: 'account or org' },
};

const field =
  'glass w-full rounded-xl px-2.5 py-1.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/50';

/** One workspace being edited: its name, what it is, the words that mean it, and its accounts. */
function Editor({
  initial,
  others,
  onDone,
}: {
  initial: Workspace;
  // Every other workspace: their ids are taken, and their names too
  others: Workspace[];
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [keywords, setKeywords] = useState(initial.keywords.join(', '));
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The product this workspace sells, if any; null until the user adds one
  const [product, setProduct] = useState<ProductProfile | null>(null);
  const [hadProduct, setHadProduct] = useState(false);
  // Until the stored product is read, there is nothing to add to: a product typed meanwhile would be replaced
  const [productRead, setProductRead] = useState(false);
  useEffect(() => {
    let live = true;
    void productStore.forWorkspace(initial.id).then(found => {
      if (!live) return;
      if (found) {
        setProduct(found);
        setHadProduct(true);
      }
      setProductRead(true);
    });
    return () => {
      live = false;
    };
  }, [initial.id]);
  const isNew = !initial.name;
  const taken = others.map(item => item.id);
  // Two workspaces of one name could not be told apart, by the user or by routing a chat's words
  const clash = others.some(item => item.name.trim().toLowerCase() === draft.name.trim().toLowerCase());

  const save = async () => {
    if (!draft.name.trim() || clash) return;
    const id = isNew ? workspaceId(draft.name, taken) : draft.id;
    await workspaceStore.save({ ...draft, id, keywords: keywords.split(',') });
    // A product with nothing in it is no product
    if (product && !isEmptyProfile({ ...product, name: '' })) {
      await productStore.save({ ...product, workspaceId: id, name: product.name.trim() || draft.name.trim() });
    } else if (hadProduct) {
      await productStore.remove(id);
    }
    onDone();
  };

  return (
    <div className="flex flex-col gap-2 px-3 py-3">
      <label className="flex flex-col gap-1 text-[12px]">
        <span className="text-muted-foreground">{t('workspace_name')}</span>
        <input
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus={isNew}
          value={draft.name}
          onChange={event => setDraft({ ...draft, name: event.target.value })}
          aria-invalid={clash}
          className={field}
        />
        {clash && (
          <span role="alert" className="text-destructive text-[11.5px]">
            {t('workspace_nameTaken', [draft.name.trim()])}
          </span>
        )}
      </label>
      <label className="flex flex-col gap-1 text-[12px]">
        <span className="text-muted-foreground">{t('workspace_about')}</span>
        <textarea
          rows={3}
          value={draft.about}
          onChange={event => setDraft({ ...draft, about: event.target.value })}
          className={field}
        />
      </label>
      <label className="flex flex-col gap-1 text-[12px]">
        <span className="text-muted-foreground">{t('workspace_keywords')}</span>
        <input value={keywords} onChange={event => setKeywords(event.target.value)} className={field} />
      </label>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-muted-foreground mb-1 text-[12px]">{t('workspace_accounts')}</legend>
        {ACCOUNT_PLATFORMS.map(platform => (
          <label key={platform} className="grid grid-cols-[72px_1fr] items-center gap-2 text-[12px]">
            <span>{PLATFORM_LABELS[platform].label}</span>
            <input
              value={draft.accounts[platform] ?? ''}
              placeholder={PLATFORM_LABELS[platform].placeholder}
              onChange={event =>
                setDraft({ ...draft, accounts: { ...draft.accounts, [platform]: event.target.value } })
              }
              className={field}
            />
          </label>
        ))}
      </fieldset>
      {product ? (
        <ProductFields value={product} onChange={setProduct} />
      ) : !productRead ? null : (
        <button
          type="button"
          onClick={() => setProduct(emptyProductProfile({ id: draft.id, name: draft.name }))}
          className="text-primary hover:bg-accent/50 flex items-center gap-2 rounded-xl px-1 py-1.5 text-left text-[12.5px]">
          <Package className="size-3.5" />
          {t('product_add')}
        </button>
      )}
      <div className="mt-1 flex items-center gap-2">
        {!isNew &&
          (confirmDelete ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={async () => {
                // The product first: a workspace gone with its product left behind would leave an orphan
                await productStore.remove(draft.id);
                await workspaceStore.remove(draft.id);
                onDone();
              }}>
              {t('workspace_delete')}
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)} aria-label={t('workspace_delete')}>
              <Trash2 className="size-3.5" />
            </Button>
          ))}
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onDone}>
          {t('workspace_cancel')}
        </Button>
        <Button size="sm" disabled={!draft.name.trim() || clash} onClick={() => void save()}>
          {t('workspace_save')}
        </Button>
      </div>
    </div>
  );
}

/** The workspaces in settings: each opens to edit, and new ones are added at the end. */
export default function WorkspacesSettings() {
  const workspaces = useWorkspaces();
  const defaultId = useDefaultWorkspaceId();
  const [editing, setEditing] = useState<Workspace | null>(null);

  if (editing) {
    return (
      <Editor
        initial={editing}
        others={workspaces.filter(item => item.id !== editing.id)}
        onDone={() => setEditing(null)}
      />
    );
  }

  return (
    <>
      {workspaces.map(workspace => {
        const accounts = Object.values(workspace.accounts).filter(value => value?.trim()).length;
        const isDefault = defaultId === workspace.id;
        const starLabel = isDefault
          ? t('shell_workspace_isDefault', [workspace.name])
          : t('shell_workspace_setDefault', [workspace.name]);
        return (
          <div key={workspace.id} className="hover:bg-accent/50 flex w-full items-center gap-0.5 pr-1.5">
            <button
              type="button"
              onClick={() => setEditing(workspace)}
              className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left">
              <span className="min-w-0 flex-1">
                <span className="block text-[13px]">{workspace.name}</span>
                <span className="text-muted-foreground block truncate text-[11.5px]">
                  {[workspace.about.split('\n')[0], accounts ? `${accounts} accounts` : '']
                    .filter(Boolean)
                    .join(' · ') || workspace.keywords.join(', ')}
                </span>
              </span>
              <ChevronRight className="text-muted-foreground size-4 shrink-0" />
            </button>
            <button
              type="button"
              aria-pressed={isDefault}
              aria-label={starLabel}
              title={starLabel}
              onClick={() => void workspaceStore.setDefaultWorkspaceId(isDefault ? null : workspace.id)}
              className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-lg',
                isDefault ? 'text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}>
              <Star className={cn('size-4', isDefault && 'fill-current')} />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() =>
          setEditing({
            id: workspaceId(
              'workspace',
              workspaces.map(item => item.id),
            ),
            name: '',
            about: '',
            keywords: [],
            accounts: {},
            createdAt: Date.now(),
          })
        }
        className="text-primary hover:bg-accent/50 flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13px]">
        <Plus className="size-4" />
        {t('workspace_add')}
      </button>
    </>
  );
}
