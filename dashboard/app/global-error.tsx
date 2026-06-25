'use client';

/**
 * Last-resort boundary for failures in the root layout itself. Must render its
 * own <html>/<body> because it replaces the whole document tree.
 */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#09090b',
          color: '#fafafa',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }}
      >
        <div style={{ textAlign: 'center', padding: '2rem' }}>
          <p style={{ fontSize: '1.125rem' }}>The dashboard failed to load.</p>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: '1.5rem',
              padding: '0.5rem 1rem',
              background: 'transparent',
              border: '1px solid #3f3f46',
              color: '#d4d4d8',
              cursor: 'pointer',
            }}
          >
            try again
          </button>
        </div>
      </body>
    </html>
  );
}
