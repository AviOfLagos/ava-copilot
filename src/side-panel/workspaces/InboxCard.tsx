import { useState } from 'react';
import { Undo2 } from 'lucide-react';
import { isMoveId, isOfferId } from '@extension/storage';
import { t } from '@extension/i18n';
import { Button } from '../components/ui/button';
import { usePlacement, workspacesRequest } from './client';
import { OfferSheet } from './MakeWorkspaceSheet';

/**
 * What an Inbox item from "workspaces" holds (docs/pm-desk.md, Part 3): a workspace Ava made and its Undo, or an offer to
 * move things (a model's guess, things that may be in the wrong workspace, what looks like a new workspace) and its answer.
 * Both read the record, so the card shows what is true now.
 */
export function WorkspaceInboxCard({ externalId }: { externalId: string }) {
  const placement = usePlacement();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (isOfferId(externalId)) {
    const offer = placement.offers.find(item => item.id === externalId);
    return offer ? <OfferSheet offer={offer} /> : null;
  }
  if (!isMoveId(externalId)) return null;
  const move = placement.moves.find(item => item.id === externalId);
  if (!move) return <p className="text-muted-foreground text-[12.5px]">{t('workspaces_move_gone')}</p>;
  if (move.undoneAt !== null) return <p className="text-muted-foreground text-[12.5px]">{t('workspaces_undone')}</p>;

  const undo = async () => {
    setBusy(true);
    setError('');
    try {
      await workspacesRequest({ type: 'workspaces_undo', moveId: move.id });
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Button size="sm" variant="glass" className="self-start" disabled={busy} onClick={() => void undo()}>
        <Undo2 className="size-3.5" aria-hidden />
        {t('workspaces_undo')}
      </Button>
      {error && (
        <p role="alert" className="text-destructive text-[12px]">
          {error}
        </p>
      )}
    </div>
  );
}
