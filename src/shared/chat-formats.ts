/**
 * Formats no local extractor can read but a chat model can.
 *
 * The `webchat` engine attaches the document to a chat site, and the sites
 * accept a much wider set of formats than pdftext or Marker do — Word,
 * PowerPoint, spreadsheets, HTML, EPUB. Listing them here keeps the scanner
 * from painting a `.docx` red as "unsupported" when the app can in fact
 * convert it: the file is convertible, just not locally, and the failure only
 * exists if the user picks one of the local engines.
 *
 * Kept in `shared/` because all three sides need the same answer — the
 * scanner decides the badge, the converter decides whether to refuse, and the
 * panel's hint text names the engine that will work.
 */
const CHAT_CONVERTIBLE_EXTENSIONS = new Set([
  '.doc',
  '.docx',
  '.odt',
  '.rtf',
  '.pptx',
  '.xlsx',
  '.csv',
  '.html',
  '.htm',
  '.epub',
])

export function isChatConvertible(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.')
  if (dot === -1) return false
  return CHAT_CONVERTIBLE_EXTENSIONS.has(fileName.slice(dot).toLowerCase())
}
