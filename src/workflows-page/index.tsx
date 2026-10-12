import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
// The panel's look: its theme, Tailwind config and components; the page's views live with the panel's
import '../side-panel/index.css';
import WorkflowsPage from '../side-panel/workflows/WorkflowsPage';

const container = document.querySelector('#app-container');
if (container) createRoot(container).render(<WorkflowsPage />);
