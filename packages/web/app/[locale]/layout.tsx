import type { Metadata } from "next"
import type { JSX, ReactNode } from "react"
import { notFound } from "next/navigation"
import { hasLocale } from "next-intl"
import { setRequestLocale } from "next-intl/server"
import { DocumentShell } from "@/app/_components/document-shell"
import { LocalizedPageShell } from "@/app/_components/localized-page-shell"
import { generateSiteMetadata, siteViewport } from "@/app/_components/site-metadata"
import { languageTag } from "@/i18n/config"
import { routing } from "@/i18n/routing"

export const revalidate = 3600
// The locale segment is a closed set: any other first segment (an unmatched /api or asset path) is an unmatched URL
// and gets app/global-not-found.tsx, not a layout-less error page.
export const dynamicParams = false
export const viewport = siteViewport

export function generateMetadata(): Promise<Metadata> {
  return generateSiteMetadata()
}

export function generateStaticParams(): Array<{ readonly locale: string }> {
  return routing.locales.map((locale) => ({ locale }))
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ locale: string }>
}): Promise<JSX.Element> {
  const { locale } = await params

  if (!hasLocale(routing.locales, locale)) {
    notFound()
  }

  setRequestLocale(locale)

  return (
    <DocumentShell lang={languageTag(locale)}>
      <LocalizedPageShell locale={locale}>{children}</LocalizedPageShell>
    </DocumentShell>
  )
}
