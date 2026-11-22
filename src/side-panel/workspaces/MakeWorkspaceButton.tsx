import { useState } from 'react';
import { FolderPlus } from 'lucide-react';
import { t } from '@extension/i18n';
import { Button } from '../components/ui/button';
import { usePlacement, workspacesRequest } from './client';
import { MakeWorkspaceSheet, OfferSheet, UndoToast } from './MakeWorkspaceSheet';

/**
 * "Make a workspace for these": the button under the "No workspace" group, in the brief and on the Tasks page. One click
 * opens the sheet; one confirm in it makes the workspace and moves the ticked things (docs/pm-desk.md, Part 3).
 */
export function MakeWorkspaceButton() {
  const [open, setOpen] = useState(false);
  if (open) return <MakeWorkspaceSheet onClose={() => setOpen(false)} />;
  return (
    <Button size="sm" variant="glass" className="self-start" onClick={() => setOpen(true)}>
      <FolderPlus className="size-3.5" aria-hidden />
      {t('workspaces_make_button')}
    </Button>
  );
}

/** The Undo under "Moved 3 things to Tech Ember Fest" in the brief: reads the move, so an old brief shows today's state. */
export function UndoMoveButton({ moveId }: { moveId: string }) {
  const { moves } = usePlacement();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const move = moves.find(item => item.id === moveId);
  if (!move) return null;
  if (move.undoneAt !== null) return <p className="text-muted-foreground text-[12.5px]">{t('workspaces_undone')}</p>;
  const undo = async () => {
    setBusy(true);
    setError('');
    try {
      await workspacesRequest({ type: 'workspaces_undo', moveId });
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <Button size="sm" variant="glass" className="self-start" disabled={busy} onClick={() => void undo()}>
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

/**
 * What the panel shows by itself: the sheet for a workspace made by voice or chat when things in No workspace look like
 * it (the same sheet, so they move in one confirm), and the Undo of that workspace for thirty seconds.
 */
export function PendingWorkspaceOffers() {
  const { offers, moves } = usePlacement();
  const sheet = [...offers].reverse().find(offer => offer.status === 'open' && offer.kind === 'sheet');
  // Read at render: the toast lasts thirty seconds from when it was made
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const fresh = [...moves]
    .reverse()
    .find(move => (move.by === 'voice' || move.by === 'agent') && move.undoneAt === null && now - move.at < 30_000);
  if (!sheet && !fresh) return null;
  return (
    <div className="flex flex-col gap-2 px-2.5 pt-2">
      {fresh && (
        <UndoToast
          key={fresh.id}
          moveId={fresh.id}
          startedAt={fresh.at}
          text={t('workspaces_done_voice', [fresh.workspaceName])}
        />
      )}
      {sheet && <OfferSheet key={sheet.id} offer={sheet} />}
    </div>
  );
}
