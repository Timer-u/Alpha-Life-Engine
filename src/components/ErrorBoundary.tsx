import type { ErrorInfo, ReactNode } from 'react';

import { Component } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Uncaught render error:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
          <div className="card max-w-md w-full text-center">
            <h2 className="text-lg font-semibold text-gray-900 mb-2">页面出错了</h2>
            <p className="text-sm text-gray-500 mb-6">发生了意外错误，请刷新页面重试。如果问题持续存在，请检查网络连接。</p>
            <button onClick={() => window.location.reload()} className="btn-primary w-full">
              刷新页面
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
