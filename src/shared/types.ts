/**
 * Types shared between main and renderer. Everything crossing the contextBridge
 * boundary must be structured-cloneable: no functions, no class instances.
 *
 * Re-exported from domain-specific type definitions in `./types/`.
 */

export * from "./types/index";
