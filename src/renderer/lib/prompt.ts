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

  const at = prompt.indexOf(OUTPUT_HEADING)
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