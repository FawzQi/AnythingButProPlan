import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

/** Measure an element's box so virtualized lists get a concrete pixel height. */
export function useElementSize<T extends HTMLElement>(): [RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(element)
    setSize({ width: element.clientWidth, height: element.clientHeight })
    return () => observer.disconnect()
  }, [])

  return [ref, size]
}

/** Run `callback` once the value has stopped changing for `delay` ms. */
export function useDebouncedEffect(callback: () => void, delay: number, deps: unknown[]): void {
  const callbackRef = useRef(callback)
  useEffect(() => {
    callbackRef.current = callback
  }, [callback])

  useEffect(() => {
    const timer = setTimeout(() => callbackRef.current(), delay)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, delay])
}

export interface ResizableWidthOptions {
  min: number
  /** Upper bound for this panel when the viewport is large enough. */
  max: number
  /**
   * +1 when dragging the handle right should grow this panel (handle sits to
   * the panel's right); -1 when the handle sits to the panel's left.
   */
  sign: 1 | -1
}

/**
 * Pixel width of a side panel, driven by dragging a divider. The parent lays
 * the panel out with `style={{ width }}` and hands `onMouseDown` to the
 * `<ResizeHandle>` next to it. Width is kept in a ref so the mousedown handler
 * never reads a stale value and does not need to be re-created on every render.
 */
export function useResizableWidth(
  initial: number,
  options: ResizableWidthOptions,
): { width: number; onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void } {
  const { min, max, sign } = options
  const [width, setWidth] = useState(initial)
  const widthRef = useRef(initial)

  const onMouseDown = (event: React.MouseEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = widthRef.current

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onMove = (moveEvent: MouseEvent): void => {
      // Cap to half the viewport so both panels can never starve the middle.
      const viewportCap = Math.floor(window.innerWidth * 0.5)
      const effectiveMax = Math.max(min, Math.min(max, viewportCap))
      const delta = (moveEvent.clientX - startX) * sign
      const next = Math.min(effectiveMax, Math.max(min, startWidth + delta))
      widthRef.current = next
      setWidth(next)
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return { width, onMouseDown }
}
