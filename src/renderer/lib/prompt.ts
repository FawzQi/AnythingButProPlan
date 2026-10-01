/**
 * Insert the user's input instruction into a built prompt, immediately
 * before the `## Output Instructions` section.
 *
 * The position matters. The output contract is the part of the prompt that
 * tells the model *how* to reply — headings, file-entry forms, the rules
 * the parser depends on. The user's instruction is the part that says
 * *what* to change. Putting the instruction first and the contract second
 * makes the contract the last thing the model reads before it starts
 * generating, which is the ordering that keeps a long instruction from
 * burying the format rules.
 *
 * The heading is located with `lastIndexOf`, not `indexOf`. The earlier
 * version used `indexOf` and anchored to the *first* `## Output
 * Instructions` line in the prompt, which is correct only when the string
 * appears exactly once. On a large codebase that is not guaranteed: any
 * selected file whose body contains the literal line `## Output
 * Instructions` — a README, a markdown doc, the app's own prompt-template
 * sources — shadows the real heading, and `indexOf` returns the shadow
 * first. The instruction was then spliced into the middle of a file body
 * instead of before the contract. On a small selection the user could
 * usually find the misplaced block; on a large one it disappeared into
 * hundreds of kilobytes of file content, which read as "the instruction
 * was not added at all."
 *
 * The contract heading lives at the *end* of the template output — files
 * are inlined above it — so the last occurrence is the real one, and a
 * file body that happens to contain the string is always earlier. That is
 * why the fix is `lastIndexOf` rather than a more elaborate scan for a
 * heading that is not inside a fence: the ordering of the template already
 * supplies the invariant, and `lastIndexOf` is the one-line expression of
 * it.
 *
 * An earlier version of this function inserted the block at exactly this
 * position by looking for the literal string `## Output Instructions`, and
 * a later rewrite moved to a plain append because a reworded heading made
 * `indexOf` return -1 and the block silently landed somewhere unexpected.
 * This version keeps the anchored insert but adds a fallback: if the
 * heading is missing — the template has been edited, or the base prompt is
 * empty — the block is appended at the end rather than dropped. Both
 * outcomes are visible in the generated prompt, so the user can see what
 * happened instead of finding the instruction gone.
 *
 * Returns the prompt untouched when either side is empty, so an unedited
 * textarea produces byte-identical output to the base prompt.
 */
const OUTPUT_HEADING = '## Output Instructions'

export function insertCustomPrompt(prompt: string, custom: string): string {
  const trimmed = custom.trim()
  if (prompt === '' || trimmed === '') return prompt

  // `lastIndexOf`: the output contract is the final section of the
  // template, so the last occurrence is the real heading even when one or
  // more inlined file bodies contain the same string. Using `indexOf`
  // here pinned the insertion to whichever file body mentioned the
  // heading first, which on a large codebase is how the instruction ended
  // up buried mid-file instead of in front of the contract.
  const at = prompt.lastIndexOf(OUTPUT_HEADING)
  if (at === -1) {
    // No output heading to anchor to. Append at the end so the instruction
    // is still included in the prompt that reaches the model, and the user
    // can see from the rendered prompt that the insertion point was missed.
    return `${prompt.trimEnd()}\n\n## Input Instruction\n\n${trimmed}\n`
  }

  const before = prompt.slice(0, at).trimEnd()
  const after = prompt.slice(at)
  return `${before}\n\n## Input Instruction\n\n${trimmed}\n\n${after}`
}