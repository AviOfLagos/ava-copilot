import { createRoot } from 'react-dom/client';
import '../../../src/ui/lib/theme.css';
import './styles.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<App />);
