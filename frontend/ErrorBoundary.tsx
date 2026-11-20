import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: { componentStack?: string | null }) {
    console.error('React render error', error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      this.props.fallback ?? (
        <div className="card notice" role="alert">
          <h2>Something went wrong</h2>
          <p>This section failed to render. Other pages are unaffected.</p>
          <button className="btn" onClick={() => location.reload()}>
            Reload workspace
          </button>
        </div>
      )
    );
  }
}
