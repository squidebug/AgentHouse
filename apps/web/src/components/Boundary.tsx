import { Component, type ReactNode } from 'react';

interface Props {
  /** Shown instead of the children once they failed to render. */
  fallback: ReactNode;
  /** When this changes, the children get another try (another session, another mode). */
  resetKey?: unknown;
  /** Told when the children failed to render, for whoever would rather not try the same again. */
  onFail?: () => void;
  children: ReactNode;
}

/**
 * Keeps a failure where it happened. Without it, one entry that cannot be
 * drawn (an agent's reply nested a thousand levels deep) takes the whole app
 * down, and again after every reload, since the pane's mode is remembered.
 */
export class Boundary extends Component<Props, { failed: boolean; key: unknown }> {
  state = { failed: false, key: this.props.resetKey };

  static getDerivedStateFromError(): Partial<{ failed: boolean }> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: Props, state: { failed: boolean; key: unknown }) {
    return props.resetKey === state.key ? null : { failed: false, key: props.resetKey };
  }

  componentDidCatch(): void {
    this.props.onFail?.();
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
