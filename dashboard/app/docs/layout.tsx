import type { ReactNode } from 'react';
import { DocsSidebar, DocsTopNav } from '@/components/docs-nav';

/* Server shell for the docs section: sticky sidebar on desktop, a compact
   horizontal nav on mobile, and a comfortable prose column for content.
   The active-link logic needs usePathname, so it lives in the small client
   components imported above — this layout itself stays a server component. */

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl px-5 py-10 sm:px-8 sm:py-14 lg:flex lg:gap-12">
      <aside className="hidden w-56 shrink-0 lg:block">
        <div className="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto pb-8">
          <DocsSidebar />
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <div className="mb-8 lg:hidden">
          <DocsTopNav />
        </div>
        <article className="max-w-3xl pb-10">{children}</article>
      </div>
    </div>
  );
}
