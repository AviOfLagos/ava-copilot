import { registerRecovery } from '../registry';
import { pruneOnce } from './index';

// Do-once records of tasks that are long over are dropped when the background starts
registerRecovery('once', () => pruneOnce());
