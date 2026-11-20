import { useState, useCallback } from 'react';
import { api, ApiError } from './api';

type State<T> = { phase: 'idle' } | { phase: 'loading' } | { phase: 'done'; result: T } | { phase: 'error'; message: string };

interface Props<T> {
  label: string;
  endpoint: string;
  method?: string;
  body?: object;
  children: (result: T) => React.ReactNode;
  className?: string;
}

export function AiAssist<T>({ label, endpoint, method = 'GET', body, children, className }: Props<T>) {
  const [state, setState] = useState<State<T>>({ phase: 'idle' });

  const run = useCallback(async () => {
    setState({ phase: 'loading' });
    try {
      const result = await api<T>(endpoint, method, body);
      setState({ phase: 'done', result });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'AI request failed.';
      setState({ phase: 'error', message });
    }
  }, [endpoint, method, body]);

  const dismiss = useCallback(() => setState({ phase: 'idle' }), []);

  return (
    <div className={`ai-assist${className ? ` ${className}` : ''}`}>
      {state.phase === 'idle' && (
        <button type="button" className="ai-assist-btn" onClick={run}>
          ✦ {label}
        </button>
      )}
      {state.phase === 'loading' && (
        <div className="ai-assist-loading">
          <span className="ai-assist-spinner" />
          AI thinking…
        </div>
      )}
      {state.phase === 'error' && (
        <div className="ai-assist-error">
          {state.message}
          <button type="button" onClick={run}>Retry</button>
        </div>
      )}
      {state.phase === 'done' && (
        <div className="ai-assist-result">
          {children(state.result)}
          <button type="button" className="ai-assist-dismiss" onClick={dismiss}>Dismiss</button>
        </div>
      )}
    </div>
  );
}
