import { t } from '@extension/i18n';
import type { GraphNode } from '@extension/storage';
import GraphView from '../side-panel/kb/GraphView';
import { useTheme } from '../side-panel/layout/theme';

const params = new URLSearchParams(location.search);
const workspaceId = params.get('workspace') || null;
const agentId = params.get('agent') || null;

/** Opens a saved page in a new tab; for a chat or meeting, the nearest this standalone tab can do is
 * bring the side panel forward, since only it can show the thread or the meeting note itself. */
function openSource(node: GraphNode) {
  const sourceId = node.id.slice(node.type.length + 1);
  if (node.type === 'page' && /^https?:/.test(sourceId)) {
    void chrome.tabs.create({ url: sourceId });
    return;
  }
  void chrome.windows.getCurrent().then(win => {
    if (win.id != null) void chrome.sidePanel?.open?.({ windowId: win.id }).catch(() => {});
  });
}

/** The knowledge graph in its own full tab, for graphs too big to work with in the side panel. */
export default function GraphPage() {
  const { dark } = useTheme();
  return (
    <div className="flex h-screen flex-col">
      <header className="border-border flex items-center gap-2 border-b px-4 py-3">
        <h1 className="text-foreground text-[14px] font-medium">{t('graph_tab')}</h1>
      </header>
      <main className="min-h-0 flex-1 overflow-hidden">
        <GraphView
          workspaceId={workspaceId}
          agentId={agentId}
          onOpenSource={openSource}
          isDarkMode={dark}
          canPopout={false}
        />
      </main>
    </div>
  );
}
