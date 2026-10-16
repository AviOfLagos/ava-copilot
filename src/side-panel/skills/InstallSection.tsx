import { useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { Download, FileUp } from 'lucide-react';
import { t } from '@extension/i18n';
import { candidateFromFiles, skillStore, unzipSkillFiles } from '@extension/storage';
import type { SkillSourceFile } from '@extension/storage';
import { cn } from '@extension/ui';
import type { PanelApi } from '../registry';
import { buttonClasses } from '../components/ui/button';
import { SKILL_STARTERS } from './starters';

interface Listing {
  name: string;
  url: string;
}

interface InstallSectionProps {
  api: PanelApi;
  // A skill was saved turned off: show its review card
  onInstalled: (id: string) => void;
}

// Fetching a GitHub folder reads each of its Markdown files, so give it time
const FETCH_TIMEOUT_MS = 90_000;

const field =
  'glass min-w-0 flex-1 rounded-xl px-2.5 py-1.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/50';

/** The files the user chose or dropped, as a skill's files: a zip is unpacked, Markdown read as text. */
async function readFiles(
  list: FileList | File[],
): Promise<{ files: SkillSourceFile[]; kind: 'file' | 'zip'; name: string }> {
  const chosen = [...list];
  const zip = chosen.find(file => /\.zip$/i.test(file.name));
  if (zip) return { files: unzipSkillFiles(new Uint8Array(await zip.arrayBuffer())), kind: 'zip', name: zip.name };
  const files = await Promise.all(
    chosen.map(async file => {
      const path = file.webkitRelativePath || file.name;
      return /\.(md|markdown)$/i.test(file.name) ? { path, text: await file.text() } : { path };
    }),
  );
  return { files, kind: 'file', name: chosen.map(file => file.name).join(', ') };
}

/**
 * Install a skill: paste a link, or choose or drop a .md or .zip; and Find skills, the starter collections. Every
 * way saves the skill turned off and opens its review card. Links are fetched by the background, only on a click.
 */
export default function InstallSection({ api, onInstalled }: InstallSectionProps) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listing, setListing] = useState<Listing[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const fetchLink = (link: string) =>
    run(async () => {
      const reply = await api.request<{ type: string; id?: string; items?: Listing[] }>(
        { type: 'skills_install', url: link },
        FETCH_TIMEOUT_MS,
      );
      if (reply.type === 'skills_listing') {
        setListing(reply.items ?? []);
        return;
      }
      if (reply.id) {
        setListing(null);
        setUrl('');
        onInstalled(reply.id);
      }
    });

  const installFiles = (list: FileList | File[]) =>
    run(async () => {
      if (!list.length) return;
      const { files, kind, name } = await readFiles(list);
      const candidate = await candidateFromFiles(files, { url: name, kind });
      const skill = await skillStore.install(candidate);
      onInstalled(skill.id);
    });

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length) void installFiles(event.dataTransfer.files);
  };

  return (
    <>
      <section
        aria-label={t('skills_install_title')}
        onDragOver={event => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'glass flex flex-col gap-2 rounded-2xl p-3 transition-colors',
          dragging && 'border-primary/60 bg-primary/10',
        )}>
        <h3 className="label-mono">{t('skills_install_title')}</h3>
        <p className="text-muted-foreground text-[12px] leading-relaxed">
          {dragging ? t('skills_install_dropHere') : t('skills_install_hint')}
        </p>
        <form
          className="flex gap-1.5"
          onSubmit={event => {
            event.preventDefault();
            if (url.trim()) void fetchLink(url.trim());
          }}>
          <input
            type="url"
            inputMode="url"
            value={url}
            onChange={event => setUrl(event.target.value)}
            placeholder="https://github.com/…/SKILL.md"
            aria-label={t('skills_install_urlLabel')}
            className={field}
            disabled={busy}
          />
          <button type="submit" className={buttonClasses('default', 'sm')} disabled={busy || !url.trim()}>
            <Download className="size-3.5" strokeWidth={1.75} />
            {t('skills_install_button')}
          </button>
        </form>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={buttonClasses('glass', 'sm')}
            onClick={() => fileInput.current?.click()}
            disabled={busy}>
            <FileUp className="size-3.5" strokeWidth={1.75} />
            {t('skills_install_file')}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".md,.markdown,.zip,text/markdown,application/zip"
            multiple
            className="hidden"
            aria-label={t('skills_install_file')}
            onChange={event => {
              if (event.target.files) void installFiles([...event.target.files]);
              event.target.value = '';
            }}
          />
          {busy && (
            <span role="status" className="text-muted-foreground text-[12px]">
              {t('skills_install_fetching')}
            </span>
          )}
        </div>
        {error && (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        )}
        {listing && (
          <div aria-label={t('skills_listing_title', [String(listing.length)])}>
            <p className="label-mono mb-1">{t('skills_listing_title', [String(listing.length)])}</p>
            <ul className="divide-border/60 max-h-64 divide-y overflow-y-auto rounded-xl border">
              {listing.map(item => (
                <li key={item.url} className="flex items-center gap-2 px-2.5 py-1.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{item.name}</span>
                  <button
                    type="button"
                    className={buttonClasses('glass', 'sm')}
                    aria-label={`${t('skills_listing_review')} ${item.name}`}
                    onClick={() => void fetchLink(item.url)}
                    disabled={busy}>
                    {t('skills_listing_review')}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section aria-label={t('skills_starters_title')}>
        <h3 className="label-mono mb-1.5 px-1">{t('skills_starters_title')}</h3>
        <div className="glass divide-border/60 divide-y overflow-hidden rounded-2xl">
          <p className="text-muted-foreground px-3 py-2 text-[11.5px]">{t('skills_starters_hint')}</p>
          {SKILL_STARTERS.map(starter => (
            <div key={starter.id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[12.5px]">{starter.name}</div>
                <div className="text-muted-foreground mt-0.5 text-[11.5px]">{t(starter.about)}</div>
              </div>
              <button
                type="button"
                className={buttonClasses('glass', 'sm')}
                aria-label={`${t('skills_starters_browse')} ${starter.name}`}
                onClick={() => void fetchLink(starter.url)}
                disabled={busy}>
                {t('skills_starters_browse')}
              </button>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
