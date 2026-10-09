import { Component, type ReactNode } from 'react'

export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="card p-5 text-sm">
        <div className="font-semibold text-neg">画面の表示中にエラーが発生しました</div>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-muted">{this.state.error.message}</pre>
        <button className="btn-ghost mt-3 h-8" onClick={() => this.setState({ error: null })}>再表示</button>
      </div>
    )
  }
}
