import { useEffect, useState } from 'react';
import { screenRecorder } from './recorder';
import type { RecorderState } from './recorder';

/** The recorder's state, kept current. */
export function useRecorder(): RecorderState {
  const [state, setState] = useState(screenRecorder.current);
  useEffect(() => screenRecorder.subscribe(setState), []);
  return state;
}
