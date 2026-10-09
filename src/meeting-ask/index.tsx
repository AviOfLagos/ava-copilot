import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import './index.css';
import MeetingAsk from './MeetingAsk';

const container = document.querySelector('#app-container');
if (container) createRoot(container).render(<MeetingAsk />);
