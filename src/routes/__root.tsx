import type { ReactNode } from 'react'
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from '@tanstack/react-router'
import navStylesUrl from '../global-nav.css?url'
import stylesUrl from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Sitemap Crawl' },
      {
        name: 'description',
        content: 'Private competitor Sitemap monitoring and SEO analysis dashboard.',
      },
    ],
    links: [
      { rel: 'stylesheet', href: stylesUrl },
      { rel: 'stylesheet', href: navStylesUrl },
    ],
  }),
  component: RootComponent,
})

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  )
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <HeadContent />
      </head>
      <body>
        <nav className="global-nav" aria-label="全局导航">
          <a className="global-brand" href="/">Sitemap Crawl</a>
          <div>
            <a href="/">Dashboard</a>
            <a href="/pages">新增页面</a>
          </div>
        </nav>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
