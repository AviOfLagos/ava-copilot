import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import './index.css';
import GraphPage from './GraphPage';

const container = document.querySelector('#app-container');
if (container) createRoot(container).render(<GraphPage />);
