// Suture tracing (suture.nexprove.com/docs/tracing): every agent call is sent to the Ava Copilot project.
// The key comes from .env.local (VITE_SUTURE_API_KEY); without it nothing is sent.
import { initSuture } from 'suture-trace';

initSuture({
  apiKey: import.meta.env.VITE_SUTURE_API_KEY,
  captureContent: import.meta.env.VITE_SUTURE_CAPTURE_CONTENT === 'true',
  serviceName: 'ava-copilot',
});
