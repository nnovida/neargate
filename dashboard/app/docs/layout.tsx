import type { ReactNode } from 'react';
import { DocsSidebar, DocsTopNav, OnThisPage } from '@/components/docs-nav';

/* Server shell for the docs section: a sticky grouped sidebar on desktop, a
   compact horizontal nav on mobile, a comfortable prose column, and an
   auto-generated "on this page" rail on wide screens. The active-link and
   scroll-spy logic need usePathname, so they live in the small client
   components imported above — this layout itself stays a server component. */

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-7xl px-5 py-10 sm:px-8 sm:py-14 lg:flex lg:gap-10">
      <aside className="hidden w-56 shrink-0 lg:block">
        <div className="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto pb-8">
          <DocsSidebar />
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <div className="mb-8 lg:hidden">
          <DocsTopNav />
        </div>
        <article className="mx-auto max-w-3xl pb-10">{children}</article>
      </div>
      <aside className="hidden w-52 shrink-0 xl:block">
        <div className="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto pb-8">
          <OnThisPage />
        </div>
      </aside>
    </div>
  );
}
